import "server-only";

/**
 * Learning Engine v1 -- Runtime Cutover RC-D: the live Session routing
 * seam. This is the ONLY place that decides, per call, whether a
 * next-card or answer request is served by the legacy engine
 * (get_next_session_card() / lib/learning/submit-answer.ts's
 * runSubmitAnswer -> commit_answer_transaction()) or by the v1 engine
 * (RC-B's claimNextLearningEngineCard() / RC-C's
 * commitLearningEngineAnswer()).
 *
 * The routing decision is always the SAME session's own persisted
 * `sessions.engine_version` -- pinned exactly once at session creation by
 * start_or_resume_session() (RC-D migration 20261017000000) -- read fresh
 * on every call via lib/sessions/dal.ts, never cached across calls, never
 * supplied by the client, and never re-derived from
 * learning_engine_v1_rollout (that table only ever influences a BRAND
 * NEW session's assignment; this module never reads it). This is what
 * "prevent all mixed-engine operation" means in practice: every call this
 * module makes is routed by a value the caller cannot influence.
 *
 * Callers (app/session/page.tsx, app/actions/sessions.ts,
 * app/actions/answers.ts) are responsible for resolving the
 * authenticated caller's own user id (requireOnboardedTester()/
 * requireActiveTester()) and passing it in -- this module never derives
 * identity itself, matching every other trusted orchestration module in
 * this codebase.
 */

import { createClient } from "@/lib/supabase/server";
import {
  getActiveSessionById,
  getNextSessionCard,
  getSessionEngineVersion,
  type NextSessionCard,
  type SessionRow,
} from "@/lib/sessions/dal";
import { claimNextLearningEngineCard } from "@/lib/learning-engine/runtime/claim-next-card";
import {
  commitLearningEngineAnswer,
  CommitRetryExhaustedError,
  type CommitLearningEngineAnswerResult,
} from "@/lib/learning-engine/runtime/commit-answer";
import {
  runSubmitAnswer,
  defaultSubmitAnswerDeps,
  validateInput,
  type SubmitAnswerInput,
  type SubmitAnswerResult,
  type SubmitAnswerSuccess,
  type SubmitAnswerXpEvent,
} from "@/lib/learning/submit-answer";
import type { CommittedXpEventRow } from "@/lib/learning-engine/runtime/commit-answer-dal";
import type { EnemyId } from "@/lib/learning/config";

// =============================================================================
// Next-card routing (RC-D sections 7/8/9)
// =============================================================================

/**
 * Routes a next-card request by the session's own pinned engine_version.
 * A legacy session is completely unchanged: the exact same
 * getNextSessionCard() call as before this module existed. A v1 session
 * never calls get_next_session_card() or reads session_review_cards/
 * session_learning_queue -- it uses claimNextLearningEngineCard() (RC-B)
 * exclusively, whose idempotent fast path (an existing OPEN claim) is
 * what makes a page reload/resume return the identical card (RC-D
 * section 9).
 */
export async function getNextSessionCardForEngine(userId: string, sessionId: string): Promise<NextSessionCard> {
  const session = await getActiveSessionById(sessionId);
  if (session === null) {
    return { status: "not_found" };
  }

  if (session.engine_version !== "v1") {
    return getNextSessionCard(sessionId);
  }

  return getNextLearningEngineSessionCard(userId, session);
}

async function getCardFrontBack(cardId: string): Promise<{ readonly front: string; readonly back: string } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("cards")
    .select("front, back")
    .eq("id", cardId)
    .maybeSingle<{ front: string; back: string }>();

  if (error) {
    throw new Error("Failed to load claimed card content", { cause: error });
  }

  return data;
}

/**
 * RC-D section 13: adapts RC-B's claim output into the exact same
 * presentation shape the Session UI already consumes for a legacy card
 * -- the UI never learns the card came from v1 (no source/policy/
 * scheduler-revision/repair-reason field is ever added to this shape).
 * `session`'s shared Battle fields (enemy/combo) come from the `sessions`
 * row, identically to legacy -- RC-B's claim never touches them.
 */
async function getNextLearningEngineSessionCard(userId: string, session: SessionRow): Promise<NextSessionCard> {
  // Defensive only, mirroring get_next_session_card()'s own
  // SESSION_MISSING_BATTLE_STATE guard -- start_or_resume_session()
  // always populates a valid enemy, so this should never trip.
  if (session.current_enemy_type === null || session.current_enemy_hp === null || session.current_enemy_max_hp === null) {
    return { status: "error", reason: "SESSION_MISSING_BATTLE_STATE" };
  }

  const claim = await claimNextLearningEngineCard(userId, session.id);

  if (claim.cardId === null) {
    // A legitimate scheduler decision: nothing is currently selectable
    // for this deck (e.g. every card on cooldown). Not an anomaly.
    return { status: "no_card", reason: "LEARNING_ENGINE_V1_NO_CARD" };
  }

  const card = await getCardFrontBack(claim.cardId);
  if (card === null) {
    // Anomaly: claim_next_learning_engine_card() already validates the
    // card belongs to this session's deck and is not soft-deleted before
    // ever claiming it, so this should never trip under normal
    // operation -- surfaced rather than silently papered over.
    return { status: "error", reason: "LEARNING_ENGINE_V1_CLAIM_INVALID" };
  }

  return {
    status: "ok",
    sessionId: session.id,
    // Unused by v1 selection (RC-D section 19) -- a fixed, valid literal
    // only to satisfy the shared presentation shape's type.
    sessionMode: "learning",
    cardId: claim.cardId,
    front: card.front,
    back: card.back,
    enemyType: session.current_enemy_type as EnemyId,
    enemyHp: session.current_enemy_hp,
    enemyMaxHp: session.current_enemy_max_hp,
    combo: session.current_combo,
    claimId: claim.claimId,
  };
}

// =============================================================================
// Answer routing (RC-D sections 10/11/12)
// =============================================================================

/**
 * Routes an answer submission by the session's own pinned engine_version
 * -- read WITHOUT an active-session filter (getSessionEngineVersion(),
 * not getActiveSessionById()) so a genuine idempotent replay can still be
 * routed correctly even after the session has since been explicitly
 * finished (lib/learning/submit-answer.ts's own documented contract: "the
 * session is not required to still be active" for a replay).
 *
 * A session id that does not exist or is not visible to this caller
 * falls through to the legacy path, which already has its own correct,
 * well-tested NOT_FOUND_OR_INACCESSIBLE handling for exactly that case --
 * this never creates a new error class for "unknown session".
 *
 * Never trusts a client-supplied engine_version -- there is no such
 * field on SubmitAnswerInput at all.
 */
export async function submitAnswerForEngine(input: SubmitAnswerInput, userId: string): Promise<SubmitAnswerResult> {
  const engineVersion = await getSessionEngineVersion(input.sessionId);

  if (engineVersion === "v1") {
    return runSubmitLearningEngineAnswer(input, userId);
  }

  return runSubmitAnswer(input, userId, defaultSubmitAnswerDeps);
}

async function runSubmitLearningEngineAnswer(input: SubmitAnswerInput, userId: string): Promise<SubmitAnswerResult> {
  const validationError = validateInput(input);
  if (validationError) {
    return validationError;
  }

  const claimId = input.claimId ?? null;
  if (claimId === null) {
    return { ok: false, code: "INVALID_INPUT", message: "claimId is required for this session." };
  }

  let commitResult: CommitLearningEngineAnswerResult;
  try {
    commitResult = await commitLearningEngineAnswer(userId, input.sessionId, claimId, {
      clientEventId: input.clientEventId,
      correct: input.correct,
      responseTimeMs: input.responseTimeMs,
      timeToFirstActionMs: null,
    });
  } catch (error) {
    if (error instanceof CommitRetryExhaustedError) {
      // Mirrors runSubmitAnswer's own STALE_STATE mapping: no commit
      // occurred under persistent staleness, so the caller must
      // re-fetch/recompute against current state and resubmit with a NEW
      // clientEventId (a different logical answer).
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

  return { ok: true, data: shapeLearningEngineAnswerSuccess(commitResult, input.correct) };
}

/**
 * RC-D section 12 (corrected by the post-RC-D Battle-replay-fidelity
 * review): adapts RC-C's commit result into the exact same
 * SubmitAnswerSuccess shape the Session UI already consumes for a
 * legacy answer, so Battle UI feedback (damage/critical/combo/
 * enemy-defeat/XP/Daily-Goal) keeps working unchanged through the common
 * adapter -- for BOTH a fresh commit and a genuine replay.
 *
 * `result.battle` is never null (CommitLearningEngineAnswerResult's own
 * contract, enforced by commit-answer.ts) -- a replay's damage/critical/
 * comboAfter/enemyHpAfter are read from the historical persisted
 * answer_events row (supabase/migrations/20261018000000_learning_engine_v1_battle_replay_fidelity.sql),
 * never recomputed and never a placeholder. This function therefore
 * never special-cases a replay for any Battle field at all -- the two
 * engine outcomes (fresh/replay) differ only in whether session/profile
 * are available for the fresh-only new-enemy/XP-total/level/streak
 * fields, exactly mirroring legacy's own `shapeSuccess()` shape one
 * module over.
 */
/** v1's own CommittedXpEventRow (lib/learning-engine/runtime/commit-answer-dal.ts) is a narrower, differently-typed row than legacy's (lib/learning/commit-answer.ts) -- both only ever need {reason, amount} here, so this maps directly rather than reusing legacy's own shapeXpEvents, which is typed specifically to its own richer row shape. */
function shapeLearningEngineXpEvents(xpEvents: readonly CommittedXpEventRow[]): readonly SubmitAnswerXpEvent[] {
  return xpEvents.map((event) => ({ reason: event.reason, amount: event.amount }));
}

function shapeLearningEngineAnswerSuccess(result: CommitLearningEngineAnswerResult, inputCorrect: boolean): SubmitAnswerSuccess {
  const xpEvents = shapeLearningEngineXpEvents(result.xpEvents);
  const totalXpAwarded = result.xpEvents.reduce((sum, event) => sum + event.amount, 0);

  const shared = {
    rating: result.rating,
    correct: inputCorrect,
    damage: result.battle.damage,
    critical: result.battle.critical,
    comboAfter: result.battle.comboAfter,
    enemyHpAfter: result.battle.enemyHpAfter,
    enemyDefeated: result.battle.enemyDefeated,
    dailyGoalJustCompleted: result.dailyGoalJustCompleted,
    xpEvents,
    totalXpAwarded,
    cardMasteredJustNow: result.cardMasteredJustNow,
    fullMasteryJustAchieved: result.fullMasteryJustAchieved,
  };

  if (result.isReplay) {
    return { isReplay: true, ...shared };
  }

  const session = result.session as
    | { current_enemy_type: string | null; current_enemy_max_hp: number | null; current_enemy_hp: number | null }
    | null;
  const profile = result.profile as
    | { total_xp: number; level: number; current_streak: number; longest_streak: number; last_daily_goal_completed_on: string | null }
    | null;

  if (session === null || profile === null) {
    throw new Error("shapeLearningEngineAnswerSuccess: fresh commit result unexpectedly missing session/profile");
  }

  return {
    isReplay: false,
    ...shared,
    newEnemyType: result.battle.enemyDefeated ? (session.current_enemy_type as EnemyId | null) : null,
    newEnemyMaxHp: result.battle.enemyDefeated ? session.current_enemy_max_hp : null,
    newEnemyHp: result.battle.enemyDefeated ? session.current_enemy_hp : null,
    totalXp: profile.total_xp,
    level: profile.level,
    currentStreak: profile.current_streak,
    longestStreak: profile.longest_streak,
    lastDailyGoalCompletedOn: profile.last_daily_goal_completed_on,
  };
}

// =============================================================================
// Combined answer + next-card orchestration (Alpha performance optimization
// #2) -- collapses the Session UI's two separate browser round trips
// (submitAnswer, then a separate getNextSessionCardAction) into one. This
// is OUTER orchestration only: it calls the exact same `submitAnswerForEngine`
// and `getNextSessionCardForEngine` above, unchanged, in the same order the
// browser previously enforced via two round trips (commit, THEN next-card --
// the next card must be selected from post-answer state, so this sequencing
// is a correctness requirement, not merely an artifact of two round trips).
// Neither underlying trusted RPC/transaction is touched, merged, or made to
// do more than it already did.
// =============================================================================

export interface SubmitAnswerAndAdvanceResult {
  readonly answerResult: SubmitAnswerResult;
  /**
   * `null` when either (a) the answer commit itself failed (`answerResult.ok
   * === false`) -- next-card is never attempted in that case -- or (b) the
   * commit succeeded but the next-card fetch itself threw an unexpected
   * error. `nextCardFailed` disambiguates the two: only case (b) sets it
   * `true`. A legitimate modeled outcome (no card currently selectable,
   * session not found, etc.) is NOT a failure -- it comes back as an
   * ordinary `NextSessionCard` value here (`status: "no_card"` / etc.),
   * exactly as `getNextSessionCardForEngine` already returns it to its
   * other caller (app/actions/sessions.ts).
   */
  readonly nextCard: NextSessionCard | null;
  /**
   * True only when the answer commit succeeded but fetching the next card
   * threw. The caller must preserve the already-committed `answerResult`
   * and retry ONLY the next-card fetch (the existing getNextSessionCardAction
   * round trip remains available for exactly this) -- never resubmit the
   * answer merely because this is true.
   */
  readonly nextCardFailed: boolean;
}

/**
 * Submits one answer, then -- only if that commit succeeded -- fetches the
 * next card, in a single server-side call. The next-card fetch is wrapped
 * so it can never cause this function to throw: a thrown error from
 * `getNextSessionCardForEngine` (as opposed to one of its normal modeled
 * outcomes) is caught and reported via `nextCardFailed`, so a browser-side
 * failure to retrieve the next card never loses visibility of the answer
 * that already committed successfully.
 */
export async function submitAnswerAndAdvance(
  input: SubmitAnswerInput,
  userId: string,
): Promise<SubmitAnswerAndAdvanceResult> {
  const answerResult = await submitAnswerForEngine(input, userId);

  if (!answerResult.ok) {
    return { answerResult, nextCard: null, nextCardFailed: false };
  }

  try {
    const nextCard = await getNextSessionCardForEngine(userId, input.sessionId);
    return { answerResult, nextCard, nextCardFailed: false };
  } catch {
    return { answerResult, nextCard: null, nextCardFailed: true };
  }
}

// =============================================================================
// Session finish (RC-D section 16/17) -- re-exported here only so callers
// never need to decide between an engine-aware vs. engine-unaware finish
// path; finish_session() itself already branches on engine_version
// server-side (RC-D migration 20261017000000), so this module adds no
// logic of its own beyond naming the single call site callers should use.
// =============================================================================
export { finishSession } from "@/lib/sessions/dal";
