import "server-only";

/**
 * Narrowest possible trusted TypeScript boundary around the
 * `commit_answer_transaction()` Postgres RPC
 * (supabase/migrations/20260923200000_commit_answer_transaction.sql,
 * docs/DATABASE_SCHEMA.md 10.3-10.6). Persistence only: accepts one
 * fully-computed answer-transaction payload, calls the RPC via the
 * service-role client, and returns a typed, validated result.
 *
 * This module performs NO calculations. It must never:
 * - infer a rating
 * - invoke FSRS
 * - calculate damage, select an enemy, or otherwise run battle logic
 * - increment seen_count/streaks or derive card lifecycle
 * - calculate XP, level, or Daily Goal/streak
 * - manipulate review/learning queue state
 * All of that is `commit_answer_transaction()`'s own responsibility
 * (re-derived server-side in Postgres, per 10.3) or the future
 * submitAnswer()'s responsibility (calling rating.ts/fsrs.ts/battle.ts
 * *before* constructing the CommitAnswerInput this module accepts). The
 * one exception is `fsrsRating`: converting the already-decided `Grade`
 * enum value to its canonical RPC-expected string name ('Again'/'Hard'/
 * 'Good'/'Easy') is a lossless format conversion, not an inference -- see
 * fsrsGradeToRatingText below.
 *
 * ---
 *
 * Browser trust boundary:
 * - `userId` is accepted as a parameter here ONLY because this is an
 *   internal, server-only persistence module -- never a Server Action,
 *   never directly reachable from client code. `import "server-only"`
 *   enforces this at build time (same pattern as
 *   lib/supabase/service-role.ts / service-role-guard.ts).
 * - The future submitAnswer() (which DOES call this) must derive
 *   `userId` from `requireActiveTester()` (lib/auth/dal.ts) -- i.e. the
 *   verified authenticated session -- and must never accept a
 *   browser-supplied user id for this parameter, under any circumstance.
 * - This module deliberately does NOT call requireActiveTester() itself:
 *   doing so here would mix orchestration (auth, rating/FSRS/battle
 *   calculation, retry policy) into what should stay a pure persistence
 *   boundary. That responsibility belongs to submitAnswer().
 * - commit_answer_transaction() itself independently re-verifies
 *   ownership of the session/card/progress against the supplied `userId`
 *   regardless of what this module or its caller assumed (10.3) -- this
 *   module's job is only to shape and forward the call, not to also
 *   police it.
 *
 * Uses ONLY getServiceRoleClient() (lib/supabase/service-role.ts) --
 * never the authenticated cookie client (this RPC has no grant for
 * `authenticated` at all) and never a separately constructed privileged
 * client. Does not touch or weaken the local/remote safety guard that
 * function already enforces.
 */

import { Rating } from "ts-fsrs";
import type { Grade } from "ts-fsrs";

import { getServiceRoleClient } from "@/lib/supabase/service-role";
import type { EnemyId } from "@/lib/learning/config";
import type { FsrsStateValue } from "@/lib/learning/fsrs";

const RPC_NAME = "commit_answer_transaction";

// =============================================================================
// Input contract -- one field per RPC parameter, 1:1, in the same order and
// grouping as the migration's CREATE FUNCTION parameter list (lines 57-105).
// Do not add, omit, or rename a field without re-checking the migration.
// =============================================================================

type CardStatus = "NEW" | "LEARNING" | "LEARNED" | "FORGOTTEN";
type SessionMode = "review" | "learning";

export interface CommitAnswerInput {
  // identity / idempotency (p_client_event_id, p_user_id, p_session_id, p_card_id)
  /** Client-generated idempotency key. NEVER generated here -- forwarded exactly as received, so a retry of the same logical answer reuses the same id and replays instead of double-processing. */
  readonly clientEventId: string;
  /** Must come from requireActiveTester() in submitAnswer() -- see the module-level trust-boundary note above. */
  readonly userId: string;
  readonly sessionId: string;
  readonly cardId: string;

  // expected-before snapshot (p_expected_*) -- staleness baseline; NULL-safely
  // compared server-side (IS DISTINCT FROM) against currently-locked state
  readonly expectedCardStatusBefore: CardStatus;
  readonly expectedSeenCountBefore: number;
  readonly expectedCorrectStreakBefore: number;
  readonly expectedWrongStreakBefore: number;
  /** Nullable: a card with no prior FSRS due date has fsrs_due_at = NULL. */
  readonly expectedFsrsDueBefore: Date | null;
  /** Nullable: sessions.current_enemy_hp is a nullable column. */
  readonly expectedSessionEnemyHpBefore: number | null;
  readonly expectedSessionComboBefore: number;
  /**
   * Required on every call regardless of session_mode -- the RPC only
   * *compares* this when sessionMode is "learning" (Learning-mode
   * eligibility path), but it is not an optional/defaulted SQL parameter,
   * so a value must always be supplied. Pass the session's current
   * learning_draw_index even for a Review-mode answer; it will simply be
   * ignored.
   */
  readonly expectedSessionLearningDrawIndex: number;

  // answer facts (p_correct, p_response_time_ms, p_session_mode)
  readonly correct: boolean;
  readonly responseTimeMs: number;
  readonly sessionMode: SessionMode;

  // FSRS result (p_fsrs_*) -- ts-fsrs output, never recomputed by this module
  /** The rating estimator's output. Converted to its RPC-expected string name (fsrsGradeToRatingText) -- Rating.Manual is rejected, matching Grade's own compile-time exclusion of it. */
  readonly fsrsRating: Grade;
  readonly fsrsDueAt: Date;
  readonly fsrsStability: number;
  readonly fsrsDifficulty: number;
  readonly fsrsElapsedDays: number;
  readonly fsrsScheduledDays: number;
  readonly fsrsReps: number;
  readonly fsrsLapses: number;
  readonly fsrsLearningSteps: number;
  readonly fsrsState: FsrsStateValue;
  readonly fsrsLastReviewAt: Date;

  // battle result (p_base_damage .. p_new_enemy_hp) -- structurally
  // identical field names to lib/learning/battle.ts's BattleCalculationResult
  // (minus comboBonus, which has no RPC parameter -- see that module)
  readonly baseDamage: number;
  readonly speedBonus: number;
  readonly critical: boolean;
  readonly comboAfter: number;
  readonly damage: number;
  readonly enemyHpAfter: number;
  readonly enemyDefeated: boolean;
  readonly newEnemyType: EnemyId | null;
  readonly newEnemyMaxHp: number | null;
  readonly newEnemyHp: number | null;
}

/**
 * Lossless format conversion from ts-fsrs's numeric Grade enum to the
 * string name commit_answer_transaction() (and answer_events.fsrs_rating's
 * CHECK constraint) expects. Not a rating inference -- the rating was
 * already decided by rating.ts; this only re-encodes that decision.
 * Rejects Rating.Manual defensively, even though Grade's type already
 * excludes it at every normal call site (same defense-in-depth pattern as
 * lib/learning/fsrs.ts's advanceFsrs).
 */
/** Exported for lib/learning/engine-router.ts's v1 adapter (Runtime Cutover RC-D), which needs the identical Grade -> rating-text conversion for a v1 answer's prepareLearningEngineAnswer()-estimated fsrsGrade. */
export function fsrsGradeToRatingText(grade: Grade): "Again" | "Hard" | "Good" | "Easy" {
  if ((grade as Rating) === Rating.Manual) {
    throw new Error("commitAnswerTransaction: Manual is not a valid fsrsRating");
  }
  return Rating[grade] as "Again" | "Hard" | "Good" | "Easy";
}

function toRpcParams(input: CommitAnswerInput): Record<string, unknown> {
  return {
    p_client_event_id: input.clientEventId,
    p_user_id: input.userId,
    p_session_id: input.sessionId,
    p_card_id: input.cardId,

    p_expected_card_status_before: input.expectedCardStatusBefore,
    p_expected_seen_count_before: input.expectedSeenCountBefore,
    p_expected_correct_streak_before: input.expectedCorrectStreakBefore,
    p_expected_wrong_streak_before: input.expectedWrongStreakBefore,
    p_expected_fsrs_due_before: input.expectedFsrsDueBefore,
    p_expected_session_enemy_hp_before: input.expectedSessionEnemyHpBefore,
    p_expected_session_combo_before: input.expectedSessionComboBefore,
    p_expected_session_learning_draw_index: input.expectedSessionLearningDrawIndex,

    p_correct: input.correct,
    p_response_time_ms: input.responseTimeMs,
    p_session_mode: input.sessionMode,

    p_fsrs_rating: fsrsGradeToRatingText(input.fsrsRating),
    p_fsrs_due_at: input.fsrsDueAt,
    p_fsrs_stability: input.fsrsStability,
    p_fsrs_difficulty: input.fsrsDifficulty,
    p_fsrs_elapsed_days: input.fsrsElapsedDays,
    p_fsrs_scheduled_days: input.fsrsScheduledDays,
    p_fsrs_reps: input.fsrsReps,
    p_fsrs_lapses: input.fsrsLapses,
    p_fsrs_learning_steps: input.fsrsLearningSteps,
    p_fsrs_state: input.fsrsState,
    p_fsrs_last_review_at: input.fsrsLastReviewAt,

    p_base_damage: input.baseDamage,
    p_speed_bonus: input.speedBonus,
    p_critical: input.critical,
    p_combo_after: input.comboAfter,
    p_damage: input.damage,
    p_enemy_hp_after: input.enemyHpAfter,
    p_enemy_defeated: input.enemyDefeated,
    p_new_enemy_type: input.newEnemyType,
    p_new_enemy_max_hp: input.newEnemyMaxHp,
    p_new_enemy_hp: input.newEnemyHp,
  };
}

// =============================================================================
// Result contract -- mirrors exactly what the migration's two
// `return jsonb_build_object(...)` sites construct (fresh: lines 766-783;
// replay: lines 226-242). `answer_event`/`user_card_progress`/`session` are
// `to_jsonb(<row>)` dumps of the full table row, so every column of
// `answer_events`/`user_card_progress`/`sessions` (inspected directly from
// their CREATE TABLE migrations) is modeled -- no invented fields, none
// omitted. `xp_events` is a `jsonb_agg` of `to_jsonb(xp_events row)`.
// `profile` is a hand-built narrow projection (NOT a full row) of exactly
// the 5 fields the migration names in `jsonb_build_object`.
//
// All timestamp/date columns arrive as plain JSON strings (ISO 8601 for
// timestamptz, "YYYY-MM-DD" for date) -- jsonb has no native date type, and
// supabase-js does not parse them back into JS Date objects.
// =============================================================================

export interface CommittedAnswerEventRow {
  readonly id: string;
  readonly client_event_id: string;
  readonly user_id: string;
  readonly card_id: string;
  readonly deck_id: string;
  readonly session_id: string;
  readonly answered_at: string;
  readonly correct: boolean;
  readonly response_time_ms: number;
  readonly session_mode: SessionMode;
  readonly card_seen_count_at_answer: number;
  readonly correct_streak_before: number;
  readonly wrong_streak_before: number;
  readonly previous_answer: boolean | null;
  readonly card_status_before: CardStatus;
  /** bigint in Postgres (milliseconds); returned as a JS number here, which is exact for any realistic time-since-last-seen value. */
  readonly time_since_last_seen: number | null;
  readonly previous_review_interval: number | null;
  readonly card_status_after: CardStatus;
  readonly correct_streak_after: number;
  readonly wrong_streak_after: number;
  readonly fsrs_rating: "Again" | "Hard" | "Good" | "Easy" | null;
  readonly fsrs_due_before: string | null;
  readonly fsrs_due_after: string | null;
  readonly base_damage: number;
  readonly speed_bonus: number;
  readonly combo: number;
  readonly damage: number;
  readonly critical: boolean;
  readonly enemy_hp_before: number | null;
  readonly enemy_hp_after: number | null;
  readonly created_at: string;
}

export interface CommittedUserCardProgressRow {
  readonly id: string;
  readonly user_id: string;
  readonly card_id: string;
  readonly card_status: CardStatus;
  readonly seen_count: number;
  readonly correct_streak: number;
  readonly wrong_streak: number;
  readonly last_seen_at: string | null;
  readonly last_answer_correct: boolean | null;
  readonly first_mastered_at: string | null;
  readonly last_mastered_at: string | null;
  readonly fsrs_due_at: string | null;
  readonly fsrs_stability: number | null;
  readonly fsrs_difficulty: number | null;
  readonly fsrs_elapsed_days: number;
  readonly fsrs_scheduled_days: number;
  readonly fsrs_reps: number;
  readonly fsrs_lapses: number;
  readonly fsrs_learning_steps: number;
  readonly fsrs_state: FsrsStateValue | null;
  readonly fsrs_last_review_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CommittedSessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly deck_id: string;
  readonly status: "active" | "completed";
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly last_active_at: string;
  readonly active_duration_sec: number;
  readonly resume_count: number;
  readonly end_reason: "user_finished" | "timeout" | "error" | null;
  readonly current_mode: SessionMode;
  readonly started_with_reviews: boolean;
  readonly reviews_completed_at: string | null;
  readonly learning_draw_index: number;
  readonly current_enemy_type: EnemyId | null;
  readonly current_enemy_max_hp: number | null;
  readonly current_enemy_hp: number | null;
  readonly current_combo: number;
  readonly total_answers: number;
  readonly correct_answers: number;
  readonly wrong_answers: number;
  readonly enemies_defeated: number;
  readonly longest_combo: number;
  readonly critical_hits: number;
  readonly xp_gained: number;
  readonly daily_goal_progress: number;
  readonly daily_goal_completed: boolean;
  readonly continued_after_daily_goal: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CommittedXpEventRow {
  readonly id: string;
  readonly user_id: string;
  readonly session_id: string | null;
  readonly card_id: string | null;
  readonly source_answer_event_id: string | null;
  readonly amount: number;
  readonly reason:
    | "correct_answer"
    | "card_learned"
    | "card_relearned"
    | "enemy_defeated"
    | "daily_goal_completed"
    | "admin_adjustment";
  readonly performed_by_user_id: string | null;
  readonly note: string | null;
  readonly created_at: string;
}

export interface CommittedProfileSnapshot {
  readonly total_xp: number;
  readonly level: number;
  readonly current_streak: number;
  readonly longest_streak: number;
  readonly last_daily_goal_completed_on: string | null;
}

export interface CommitAnswerFreshResult {
  readonly is_replay: false;
  readonly answer_event: CommittedAnswerEventRow;
  readonly xp_events: readonly CommittedXpEventRow[];
  readonly daily_goal_just_completed: boolean;
  readonly user_card_progress: CommittedUserCardProgressRow;
  readonly session: CommittedSessionRow;
  readonly profile: CommittedProfileSnapshot;
}

/**
 * A replay of an already-processed client_event_id (10.3): the historical
 * answer_event/xp_events are returned, but user_card_progress/session/
 * profile are `null` -- the migration deliberately never fabricates
 * current-looking state for what may be a stale retry. Callers must not
 * treat a replay as representing current live state.
 */
export interface CommitAnswerReplayResult {
  readonly is_replay: true;
  readonly answer_event: CommittedAnswerEventRow;
  readonly xp_events: readonly CommittedXpEventRow[];
  readonly daily_goal_just_completed: boolean;
  readonly user_card_progress: null;
  readonly session: null;
  readonly profile: null;
}

export type CommitAnswerResult = CommitAnswerFreshResult | CommitAnswerReplayResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates enough of the RPC's returned shape to catch malformed/
 * unexpected output before it reaches any caller -- the envelope fields
 * (`is_replay`, presence/absence of `answer_event`/`xp_events`/
 * `daily_goal_just_completed`/`user_card_progress`/`session`/`profile`
 * per variant) are checked explicitly; the contents of the nested
 * full-row objects are trusted structurally (they are Postgres's own
 * `to_jsonb(<row>)` dump of a table this module's TypeScript types above
 * already model field-for-field from the table DDL, not independently
 * reconstructed data that could drift on its own). Throws on any
 * violation rather than returning a best-effort guess.
 */
function parseCommitAnswerResult(raw: unknown): CommitAnswerResult {
  if (!isRecord(raw)) {
    throw new Error(`commit_answer_transaction: expected a JSON object result, got ${typeof raw}`);
  }
  if (typeof raw.is_replay !== "boolean") {
    throw new Error("commit_answer_transaction: result is missing boolean is_replay");
  }
  if (!isRecord(raw.answer_event)) {
    throw new Error("commit_answer_transaction: result is missing answer_event");
  }
  if (!Array.isArray(raw.xp_events)) {
    throw new Error("commit_answer_transaction: result is missing xp_events array");
  }
  if (typeof raw.daily_goal_just_completed !== "boolean") {
    throw new Error("commit_answer_transaction: result is missing boolean daily_goal_just_completed");
  }

  if (raw.is_replay) {
    if (raw.user_card_progress !== null || raw.session !== null || raw.profile !== null) {
      throw new Error(
        "commit_answer_transaction: replay result must have null user_card_progress/session/profile",
      );
    }
    return {
      is_replay: true,
      answer_event: raw.answer_event as unknown as CommittedAnswerEventRow,
      xp_events: raw.xp_events as unknown as CommittedXpEventRow[],
      daily_goal_just_completed: raw.daily_goal_just_completed,
      user_card_progress: null,
      session: null,
      profile: null,
    };
  }

  if (!isRecord(raw.user_card_progress) || !isRecord(raw.session) || !isRecord(raw.profile)) {
    throw new Error(
      "commit_answer_transaction: fresh result is missing user_card_progress/session/profile",
    );
  }

  return {
    is_replay: false,
    answer_event: raw.answer_event as unknown as CommittedAnswerEventRow,
    xp_events: raw.xp_events as unknown as CommittedXpEventRow[],
    daily_goal_just_completed: raw.daily_goal_just_completed,
    user_card_progress: raw.user_card_progress as unknown as CommittedUserCardProgressRow,
    session: raw.session as unknown as CommittedSessionRow,
    profile: raw.profile as unknown as CommittedProfileSnapshot,
  };
}

// =============================================================================
// Error handling
// =============================================================================

/**
 * SQLSTATEs commit_answer_transaction() intentionally raises (per its
 * `using errcode = ...` clauses), for callers that want to branch on
 * them. Most notably `STALE_SNAPSHOT` (Postgres's standard
 * "serialization_failure" class), which the migration uses specifically
 * for its stale-pre-answer-snapshot check (10.3) -- the signal the future
 * submitAnswer() needs to detect a legitimate refetch-and-retry
 * condition, as distinct from every other rejection.
 */
export const COMMIT_ANSWER_ERROR_CODES = {
  STALE_SNAPSHOT: "40001",
  INVALID_INPUT: "22023",
  FORBIDDEN: "42501",
  AUTH_REQUIRED: "28000",
} as const;

/**
 * Preserves the Postgres SQLSTATE (`code`) as a first-class field so
 * callers can branch (e.g. on COMMIT_ANSWER_ERROR_CODES.STALE_SNAPSHOT)
 * without parsing message text. The raw Postgres/Supabase error object is
 * kept only in `cause`, for server-side diagnostics -- never surface
 * `cause` (or the raw driver error) to browser-facing responses; this
 * error's own `message` is always a generic, server-safe string.
 * `code` is `undefined` for a non-Postgres failure (e.g. a malformed
 * result shape caught by parseCommitAnswerResult).
 */
export class CommitAnswerTransactionError extends Error {
  readonly code: string | undefined;

  constructor(message: string, options: { code?: string; cause: unknown }) {
    super(message, { cause: options.cause });
    this.name = "CommitAnswerTransactionError";
    this.code = options.code;
  }
}

// =============================================================================
// The wrapper itself
// =============================================================================

/**
 * Calls commit_answer_transaction() with one fully-computed answer
 * payload via the service-role client, and returns a validated, typed
 * result. See the module header for the full trust-boundary contract.
 */
export async function commitAnswerTransaction(input: CommitAnswerInput): Promise<CommitAnswerResult> {
  const supabase = getServiceRoleClient();

  const { data, error } = await supabase.rpc(RPC_NAME, toRpcParams(input));

  if (error) {
    throw new CommitAnswerTransactionError(`${RPC_NAME} RPC call failed`, {
      code: error.code,
      cause: error,
    });
  }

  return parseCommitAnswerResult(data);
}
