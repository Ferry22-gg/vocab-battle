import "server-only";

/**
 * Trusted answer-submission orchestration (docs/DATABASE_SCHEMA.md 10.3,
 * MVP_SPEC_FOR_CLAUDE.md section 18). This is the ONE place that wires
 * together: authenticated identity, trusted server-side reads, the rating
 * estimator, the FSRS adapter, the battle calculator, and
 * commitAnswerTransaction() -- in that order, exactly once per call.
 *
 * `runSubmitAnswer` is the dependency-injected orchestration core, kept
 * separate from the public Server Action (app/actions/answers.ts, which
 * carries the "use server" directive) for two reasons:
 *  1. testability -- every trusted read, every pure calculator, the RPC
 *     boundary, `now`, and the battle RNG are all swappable, so
 *     orchestration (sequencing and field-mapping) can be unit-tested
 *     without a real database or a real service-role client;
 *  2. a "use server" file's exports are transformed into client-callable
 *     Server Action references by Next.js, which requires
 *     serializable-only parameters -- `SubmitAnswerDeps` contains
 *     function values, so this module (and `runSubmitAnswer`) must live
 *     outside that file entirely, not merely be un-exported from it.
 *
 * Browser trust boundary: the ONLY values this module accepts that
 * originated from the browser are `clientEventId`, `sessionId`, `cardId`,
 * `correct`, and `responseTimeMs` (SubmitAnswerInput). `userId` must come
 * from the caller's own requireActiveTester() call (app/actions/answers.ts
 * does this) -- never from `input`, and this module has no field for it
 * to arrive through input at all. Every other trusted value -- session
 * mode, combo, enemy state, card progress, FSRS state, the estimated
 * rating, the battle result, every `expected*` snapshot field -- is
 * either read here via the ordinary authenticated/RLS-scoped DAL or
 * computed here from that trusted state. None of it can be overridden by
 * the caller.
 *
 * D3b hardening: the FIRST thing this module does with a validated input
 * is an early replay lookup by `clientEventId` -- see the top of
 * `runSubmitAnswer` and getAnswerEventByClientEventId's own docs
 * (lib/learning/progress-dal.ts). This exists because
 * commit_answer_transaction() honors a replay of an already-processed
 * `client_event_id` regardless of whether the session is still active
 * (10.3: "the session is not required to still be active"), but this
 * module's own getActiveSessionById() only ever returns an *active*
 * session. Without the early check, a legitimate transport-retry (the
 * original commit succeeded, but the client never saw the response)
 * submitted after the session was later explicitly finished would be
 * wrongly rejected as NOT_FOUND_OR_INACCESSIBLE before ever reaching the
 * RPC's own idempotency check -- silently weakening the database's
 * documented replay guarantee. The early lookup also means a genuine
 * replay never re-runs rating/FSRS/battle or consumes RNG, and never
 * calls commitAnswerTransaction() a second time.
 */

import { getActiveSessionById } from "@/lib/sessions/dal";
import {
  getAnswerEventByClientEventId,
  getCardProgress,
  getRecentAnswerHistory,
  getXpEventsForAnswerEvent,
} from "@/lib/learning/progress-dal";
import { estimateRating } from "@/lib/learning/rating";
import { progressToFsrsCard, advanceFsrs } from "@/lib/learning/fsrs";
import { calculateBattleResult } from "@/lib/learning/battle";
import {
  commitAnswerTransaction,
  CommitAnswerTransactionError,
  COMMIT_ANSWER_ERROR_CODES,
} from "@/lib/learning/commit-answer";
import type {
  CommitAnswerInput,
  CommitAnswerReplayResult,
  CommitAnswerResult,
  CommittedXpEventRow,
} from "@/lib/learning/commit-answer";
import type { EnemyId } from "@/lib/learning/config";

// =============================================================================
// Browser input contract
// =============================================================================

/**
 * Exactly what the browser may supply for one answer. Nothing else --
 * see the module header for the full trust-boundary statement. In
 * particular: no userId, no sessionMode, no card/progress/FSRS/combo/
 * enemy/rating/damage/XP/queue value, and no expected_* snapshot field.
 */
export interface SubmitAnswerInput {
  readonly clientEventId: string;
  readonly sessionId: string;
  readonly cardId: string;
  readonly correct: boolean;
  readonly responseTimeMs: number;
  /**
   * Runtime Cutover RC-D: the OPEN selection_claims id the displayed card
   * was claimed under, for a v1 session -- `null` for a legacy session
   * (this field is meaningless there and is ignored by this module's own
   * legacy flow below). The browser gets this opaquely from the matching
   * card-fetch result (lib/sessions/dal.ts's NextSessionCard `claimId`)
   * and must never be asked to construct or guess one -- see
   * lib/learning/engine-router.ts, which routes a v1 session's answer to
   * commitLearningEngineAnswer(claimId, ...) instead of this module.
   * Optional (as opposed to required-but-nullable) so every existing
   * legacy caller -- which has no concept of a claim at all -- is
   * unaffected and need not be touched to keep compiling.
   */
  readonly claimId?: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// =============================================================================
// Application-facing result contract
// =============================================================================

export type SubmitAnswerErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND_OR_INACCESSIBLE"
  | "STALE_STATE"
  | "COMMIT_FAILED";

export interface SubmitAnswerError {
  readonly ok: false;
  readonly code: SubmitAnswerErrorCode;
  /** Always a generic, server-safe message -- never a raw DB error, SQLSTATE detail, table name, or another user's data. */
  readonly message: string;
}

/** Narrow, UI-safe shape of one awarded XP event: only what a battle UI needs to show, never the full ledger row (user_id, session_id, source_answer_event_id, ...). */
export interface SubmitAnswerXpEvent {
  readonly reason: CommittedXpEventRow["reason"];
  readonly amount: number;
}

interface SubmitAnswerSharedFields {
  /**
   * Runtime Cutover RC-D: widened to admit `null` for a v1 answer whose
   * card never touched FSRS at all (the v1 Active Pool/repair mechanisms
   * have no per-answer FSRS grade concept the way legacy's Review mode
   * always does -- only an OUTSIDE-pool review answer has one). Legacy
   * always supplies a non-null value, unchanged.
   */
  readonly rating: "Again" | "Hard" | "Good" | "Easy" | null;
  readonly correct: boolean;
  readonly damage: number;
  readonly critical: boolean;
  readonly comboAfter: number;
  readonly enemyHpAfter: number;
  readonly enemyDefeated: boolean;
  readonly dailyGoalJustCompleted: boolean;
  readonly xpEvents: readonly SubmitAnswerXpEvent[];
  readonly totalXpAwarded: number;
  /**
   * Runtime Cutover RC-D (spec section 24, "plumb only"): whether this
   * answer transitioned the card ACQUIRED -> LEARNED (v1) or produced the
   * equivalent legacy 'card_learned'/'card_relearned' xp_events reason.
   * Not read by session-screen.tsx yet -- RC-E owns activating the
   * mastery toast; this field only makes the information available to a
   * future caller without a second round trip.
   */
  readonly cardMasteredJustNow: boolean;
  /**
   * Runtime Cutover RC-D (spec section 24): the authoritative v1
   * has_achieved_full_mastery false -> true transition for this answer's
   * deck. Always `null` for legacy -- commit_answer_transaction() never
   * updates has_achieved_full_mastery live (docs/
   * LEARNING_ENGINE_V1_RUNTIME_CUTOVER_TODO.md, "Stale
   * user_deck_learning_state"), so legacy has no authoritative value to
   * report here, and `null` (never fabricated `false`) says so honestly.
   */
  readonly fullMasteryJustAchieved: boolean | null;
}

/**
 * A freshly-committed answer. `newEnemy*`/profile-derived fields are only
 * meaningful here (never on replay, see SubmitAnswerReplaySuccess) --
 * sourced from the RPC's returned `session`/`profile` snapshots, not from
 * this module's own pre-commit calculation, so the browser-facing result
 * always reflects what Postgres actually persisted.
 */
export interface SubmitAnswerFreshSuccess extends SubmitAnswerSharedFields {
  readonly isReplay: false;
  /** Null unless enemyDefeated -- the newly spawned enemy, from the committed session row. */
  readonly newEnemyType: EnemyId | null;
  readonly newEnemyMaxHp: number | null;
  readonly newEnemyHp: number | null;
  readonly totalXp: number;
  readonly level: number;
  readonly currentStreak: number;
  readonly longestStreak: number;
  readonly lastDailyGoalCompletedOn: string | null;
}

/**
 * An idempotent replay of an already-processed client_event_id. Only
 * fields reliably reconstructable from the historical answer_event +
 * xp_events are present -- `session`/`profile` are null on a replay
 * result (commit-answer.ts), so new-enemy and profile-derived fields
 * (level/XP/streak) are NOT reconstructable and are deliberately absent
 * from this type entirely, not null-faked. A caller that needs them must
 * separately refetch current state.
 */
export interface SubmitAnswerReplaySuccess extends SubmitAnswerSharedFields {
  readonly isReplay: true;
}

export type SubmitAnswerSuccess = SubmitAnswerFreshSuccess | SubmitAnswerReplaySuccess;

export interface SubmitAnswerOk {
  readonly ok: true;
  readonly data: SubmitAnswerSuccess;
}

export type SubmitAnswerResult = SubmitAnswerOk | SubmitAnswerError;

// =============================================================================
// Dependency injection -- see module header for why this exists.
// =============================================================================

export interface SubmitAnswerDeps {
  readonly getAnswerEventByClientEventId: typeof getAnswerEventByClientEventId;
  readonly getXpEventsForAnswerEvent: typeof getXpEventsForAnswerEvent;
  readonly getActiveSessionById: typeof getActiveSessionById;
  readonly getCardProgress: typeof getCardProgress;
  readonly getRecentAnswerHistory: typeof getRecentAnswerHistory;
  readonly estimateRating: typeof estimateRating;
  readonly progressToFsrsCard: typeof progressToFsrsCard;
  readonly advanceFsrs: typeof advanceFsrs;
  readonly calculateBattleResult: typeof calculateBattleResult;
  readonly commitAnswerTransaction: typeof commitAnswerTransaction;
  /** Single answer timestamp for the whole logical submission -- called once, reused for every FSRS timestamp need. */
  readonly now: () => Date;
  /** Battle RNG. Math.random in production; injectable for tests. */
  readonly random: () => number;
}

export const defaultSubmitAnswerDeps: SubmitAnswerDeps = {
  getAnswerEventByClientEventId,
  getXpEventsForAnswerEvent,
  getActiveSessionById,
  getCardProgress,
  getRecentAnswerHistory,
  estimateRating,
  progressToFsrsCard,
  advanceFsrs,
  calculateBattleResult,
  commitAnswerTransaction,
  now: () => new Date(),
  random: Math.random,
};

// =============================================================================
// Validation
// =============================================================================

function invalidInput(message: string): SubmitAnswerError {
  return { ok: false, code: "INVALID_INPUT", message };
}

/**
 * Runtime-validates the browser-supplied payload -- `SubmitAnswerInput`'s
 * compile-time type does not survive the network/serialization boundary,
 * so a malformed/malicious payload must be caught here before any DB
 * read. `responseTimeMs` has no upper bound because none exists in the
 * schema (`answer_events.response_time_ms` is only `CHECK (>= 0)`,
 * docs/DATABASE_SCHEMA.md 4.8) -- inventing one here would be exactly the
 * kind of unauthorized invariant this project's conventions avoid.
 */
/** Exported for lib/learning/engine-router.ts's v1 answer path (Runtime Cutover RC-D), which reuses this exact generic-shape validation before its own engine-specific claimId requirement check. */
export function validateInput(input: SubmitAnswerInput): SubmitAnswerError | null {
  if (!isValidUuid(input.clientEventId)) {
    return invalidInput("clientEventId must be a valid UUID.");
  }
  if (!isValidUuid(input.sessionId)) {
    return invalidInput("sessionId must be a valid UUID.");
  }
  if (!isValidUuid(input.cardId)) {
    return invalidInput("cardId must be a valid UUID.");
  }
  if (typeof input.correct !== "boolean") {
    return invalidInput("correct must be a boolean.");
  }
  if (!Number.isInteger(input.responseTimeMs) || input.responseTimeMs < 0) {
    return invalidInput("responseTimeMs must be a non-negative integer.");
  }
  if (input.claimId != null && !isValidUuid(input.claimId)) {
    return invalidInput("claimId must be a valid UUID, null, or omitted.");
  }
  return null;
}

// =============================================================================
// Result shaping
// =============================================================================

function shapeXpEvents(xpEvents: readonly CommittedXpEventRow[]): readonly SubmitAnswerXpEvent[] {
  return xpEvents.map((event) => ({ reason: event.reason, amount: event.amount }));
}

/**
 * Derives the browser-safe result from the RPC's actual output -- not
 * from this module's own pre-commit `battleResult`/`grade` values -- so
 * the result always reflects what Postgres actually persisted, and so
 * the exact same derivation applies uniformly to both fresh and replay
 * (`answer_event`/`xp_events` are present in both; only `session`/
 * `profile` differ).
 *
 * `fsrs_rating`/`enemy_hp_after` are nullable on the `answer_events`
 * table in general (docs/DATABASE_SCHEMA.md 4.8), but this module always
 * supplies both for every answer it submits -- so for an answer_event
 * this module itself just created (fresh) or is replaying the result of
 * (replay, but still one this same trusted path originally created), they
 * are expected non-null. Throws rather than silently substituting a
 * fabricated value if that expectation is ever violated.
 */
function shapeSuccess(result: CommitAnswerResult): SubmitAnswerSuccess {
  const { answer_event, xp_events, daily_goal_just_completed } = result;

  if (answer_event.fsrs_rating === null) {
    throw new Error("submitAnswer: committed answer_event unexpectedly has a null fsrs_rating");
  }
  if (answer_event.enemy_hp_after === null) {
    throw new Error("submitAnswer: committed answer_event unexpectedly has a null enemy_hp_after");
  }

  const enemyDefeated = answer_event.enemy_hp_after === 0;

  const shared: SubmitAnswerSharedFields = {
    rating: answer_event.fsrs_rating,
    correct: answer_event.correct,
    damage: answer_event.damage,
    critical: answer_event.critical,
    comboAfter: answer_event.combo,
    enemyHpAfter: answer_event.enemy_hp_after,
    enemyDefeated,
    dailyGoalJustCompleted: daily_goal_just_completed,
    xpEvents: shapeXpEvents(xp_events),
    totalXpAwarded: xp_events.reduce((sum, event) => sum + event.amount, 0),
    cardMasteredJustNow: xp_events.some((event) => event.reason === "card_learned" || event.reason === "card_relearned"),
    // Legacy never computes an authoritative live has_achieved_full_mastery transition -- see SubmitAnswerSharedFields's own doc comment.
    fullMasteryJustAchieved: null,
  };

  if (result.is_replay) {
    return { isReplay: true, ...shared };
  }

  const { session, profile } = result;

  return {
    isReplay: false,
    ...shared,
    newEnemyType: enemyDefeated ? session.current_enemy_type : null,
    newEnemyMaxHp: enemyDefeated ? session.current_enemy_max_hp : null,
    newEnemyHp: enemyDefeated ? session.current_enemy_hp : null,
    totalXp: profile.total_xp,
    level: profile.level,
    currentStreak: profile.current_streak,
    longestStreak: profile.longest_streak,
    lastDailyGoalCompletedOn: profile.last_daily_goal_completed_on,
  };
}

// =============================================================================
// Orchestration core
// =============================================================================

/**
 * Runs the full trusted answer-submission flow for an already-authenticated
 * `userId`. See the module header for the full sequencing/trust
 * rationale. Deliberately does NOT pre-read `session_review_cards` /
 * `session_learning_queue`: commit_answer_transaction() itself locks and
 * authoritatively validates review-queue membership/completion and
 * learning-cooldown/forced-reappearance eligibility (10.3) using only
 * `sessionMode` + `cardId` + the session's own `learning_draw_index` --
 * none of which this module's calculations need as input, so reading
 * those two tables here would be purely redundant with what Postgres
 * already re-derives. Likewise does not duplicate the
 * card-belongs-to-session's-deck check the RPC also performs.
 *
 * A thrown error from a trusted DAL read (a genuine database failure, as
 * opposed to a `null` "not found/inaccessible" result) is deliberately
 * NOT caught here -- it propagates, consistent with how
 * lib/auth/dal.ts's getAuthContext() treats a real query error as
 * neither of its known states. Only commitAnswerTransaction()'s own
 * thrown errors are caught and mapped, per the stale-snapshot/idempotency
 * contract below.
 */
export async function runSubmitAnswer(
  input: SubmitAnswerInput,
  userId: string,
  deps: SubmitAnswerDeps = defaultSubmitAnswerDeps,
): Promise<SubmitAnswerResult> {
  const validationError = validateInput(input);
  if (validationError) {
    return validationError;
  }

  // Early replay short-circuit (D3b hardening) -- MUST run before any
  // session/progress/history read and before any rating/FSRS/battle
  // calculation. See the module header for why: getActiveSessionById()
  // below only returns an *active* session, but commit_answer_transaction()
  // honors a replay even for a session that has since been finished, so
  // without this check a legitimate transport-retry could be wrongly
  // rejected as NOT_FOUND_OR_INACCESSIBLE. Scoped entirely by RLS -- see
  // getAnswerEventByClientEventId's own docs.
  //
  // A found row whose session_id/card_id do NOT match this input is
  // deliberately NOT treated as a replay here (that would incorrectly
  // paper over a client bug -- the same client_event_id reused for a
  // different logical answer). It falls through to the normal flow below,
  // where commitAnswerTransaction() performs the same identity check
  // itself and authoritatively rejects it.
  const existingAnswerEvent = await deps.getAnswerEventByClientEventId(input.clientEventId);
  if (
    existingAnswerEvent &&
    existingAnswerEvent.session_id === input.sessionId &&
    existingAnswerEvent.card_id === input.cardId
  ) {
    const xpEvents = await deps.getXpEventsForAnswerEvent(existingAnswerEvent.id);
    const replayResult: CommitAnswerReplayResult = {
      is_replay: true,
      answer_event: existingAnswerEvent,
      xp_events: xpEvents,
      daily_goal_just_completed: xpEvents.some((event) => event.reason === "daily_goal_completed"),
      user_card_progress: null,
      session: null,
      profile: null,
    };
    return { ok: true, data: shapeSuccess(replayResult) };
  }

  const [session, progress, recentAnswerHistory] = await Promise.all([
    deps.getActiveSessionById(input.sessionId),
    deps.getCardProgress(input.cardId),
    deps.getRecentAnswerHistory(input.cardId),
  ]);

  // Uniformly "not found" whether the row genuinely doesn't exist or RLS
  // excluded it (another user's session/card) -- never distinguishable,
  // so this never confirms another user's resource exists (matches
  // lib/sessions/dal.ts / lib/learning/progress-dal.ts's own contract).
  if (!session || !progress) {
    return {
      ok: false,
      code: "NOT_FOUND_OR_INACCESSIBLE",
      message: "Session or card progress not found.",
    };
  }

  // sessions.current_enemy_hp/current_enemy_max_hp/current_enemy_type are
  // nullable columns (docs/DATABASE_SCHEMA.md 4.5); start_or_resume_session()
  // always populates a valid enemy for a newly created session and resume
  // never touches them, so this should never trip in practice -- but this
  // module must not silently fabricate battle state if it somehow did.
  const { current_enemy_hp: enemyHpBefore, current_enemy_max_hp: enemyMaxHp, current_enemy_type: enemyType } =
    session;
  if (enemyHpBefore === null || enemyMaxHp === null || enemyType === null) {
    return {
      ok: false,
      code: "COMMIT_FAILED",
      message: "Session is missing required battle state.",
    };
  }

  const now = deps.now();

  const grade = deps.estimateRating({
    correct: input.correct,
    responseTimeMs: input.responseTimeMs,
    // Post-increment contract locked in Phase C3: rating.ts's seenCount
    // includes the current answer, but progress.seen_count (read before
    // this answer is processed) does not yet.
    seenCount: progress.seen_count + 1,
    recentAnswerHistory,
  });

  const card = deps.progressToFsrsCard(progress, now);
  const fsrsUpdate = deps.advanceFsrs(card, now, grade);

  const battleResult = deps.calculateBattleResult({
    correct: input.correct,
    responseTimeMs: input.responseTimeMs,
    comboBefore: session.current_combo,
    enemyHpBefore,
    random: deps.random,
  });

  const commitInput: CommitAnswerInput = {
    clientEventId: input.clientEventId,
    userId,
    sessionId: input.sessionId,
    cardId: input.cardId,

    expectedCardStatusBefore: progress.card_status,
    expectedSeenCountBefore: progress.seen_count,
    expectedCorrectStreakBefore: progress.correct_streak,
    expectedWrongStreakBefore: progress.wrong_streak,
    expectedFsrsDueBefore: progress.fsrs_due_at,
    expectedSessionEnemyHpBefore: enemyHpBefore,
    expectedSessionComboBefore: session.current_combo,
    // Always supplied regardless of mode -- required by the RPC's
    // signature either way; only compared server-side in Learning mode.
    expectedSessionLearningDrawIndex: session.learning_draw_index,

    correct: input.correct,
    responseTimeMs: input.responseTimeMs,
    sessionMode: session.current_mode,

    fsrsRating: grade,
    fsrsDueAt: fsrsUpdate.fsrs_due_at,
    fsrsStability: fsrsUpdate.fsrs_stability,
    fsrsDifficulty: fsrsUpdate.fsrs_difficulty,
    fsrsElapsedDays: fsrsUpdate.fsrs_elapsed_days,
    fsrsScheduledDays: fsrsUpdate.fsrs_scheduled_days,
    fsrsReps: fsrsUpdate.fsrs_reps,
    fsrsLapses: fsrsUpdate.fsrs_lapses,
    fsrsLearningSteps: fsrsUpdate.fsrs_learning_steps,
    fsrsState: fsrsUpdate.fsrs_state,
    fsrsLastReviewAt: fsrsUpdate.fsrs_last_review_at,

    baseDamage: battleResult.baseDamage,
    speedBonus: battleResult.speedBonus,
    critical: battleResult.critical,
    comboAfter: battleResult.comboAfter,
    damage: battleResult.damage,
    enemyHpAfter: battleResult.enemyHpAfter,
    enemyDefeated: battleResult.enemyDefeated,
    newEnemyType: battleResult.newEnemyType,
    newEnemyMaxHp: battleResult.newEnemyMaxHp,
    newEnemyHp: battleResult.newEnemyHp,
  };

  let commitResult: CommitAnswerResult;
  try {
    commitResult = await deps.commitAnswerTransaction(commitInput);
  } catch (error) {
    if (
      error instanceof CommitAnswerTransactionError &&
      error.code === COMMIT_ANSWER_ERROR_CODES.STALE_SNAPSHOT
    ) {
      // No commit occurred (the RPC performs no writes on a stale-snapshot
      // rejection). Per the idempotency contract: a caller retrying the
      // *same* logical answer after an unknown-outcome transport failure
      // must reuse this same clientEventId; but a genuinely stale
      // snapshot means the caller must re-fetch/recompute against current
      // state and resubmit with a NEW clientEventId, since it is now a
      // different logical answer (computed against different inputs).
      // This module generates neither id itself -- deciding which applies
      // is the caller's responsibility.
      return {
        ok: false,
        code: "STALE_STATE",
        message: "This answer was computed against outdated state. Please try again.",
      };
    }

    return {
      ok: false,
      code: "COMMIT_FAILED",
      message: "Something went wrong submitting your answer. Please try again.",
    };
  }

  return { ok: true, data: shapeSuccess(commitResult) };
}
