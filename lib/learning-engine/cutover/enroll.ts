import "server-only";

/**
 * Learning Engine v1 -- Runtime Cutover RC-D: the minimal trusted,
 * per-user enrollment orchestration RC-A intentionally left unbuilt (RC-A's
 * own header: "no function in this migration deletes or inserts rows
 * here; that trusted write path is explicitly out of RC-A's scope").
 *
 * Never imported by any Server Action, API route, or Session UI code
 * path -- this is an operational/test-setup primitive, invoked by a
 * trusted operator or by integration-test fixture setup using a
 * dedicated test-owned identity (RC-D section 29: never a real tester
 * yet).
 *
 * PRE-RC-E SAFETY CORRECTION (second pass): enrollment is now ATOMIC with
 * respect to Session creation and with respect to a concurrent duplicate
 * enrollment call. The original RC-D shape here called three separate
 * RPCs in sequence -- normalize (many individual round trips), then admit
 * -- each its own committed transaction. That left a real TOCTOU race:
 *
 *   T1: checks for an active legacy Session -- finds none, proceeds.
 *   T2: start_or_resume_session() creates a new legacy Session, commits.
 *   T1: normalizes this user's user_card_progress rows against shared
 *       state -- these commit (each normalize call was its own
 *       transaction).
 *   T1: calls admit_user_to_learning_engine_v1() last -- it now sees T2's
 *       active legacy Session and correctly rejects.
 *
 *   Result: no rollout row, user remains operationally legacy, but
 *   user_card_progress has already been mutated into v1-shaped state --
 *   exactly the mixed-state condition this module exists to prevent. The
 *   final admission guard alone was too late: normalization had already
 *   committed.
 *
 * The fix: this module no longer calls normalize/recompute/admit as
 * separate round trips at all. It now does exactly two things:
 *
 *   1. prepareLearningEngineV1NormalizationForUser() (lib/learning-engine/
 *      cutover/prepare-normalization.ts) -- a READ-ONLY, pure-computation
 *      step. Reuses the exact same, already-reviewed RC-A normalization
 *      policy (computeNormalizedCardProgress()/assignForgottenOrdinals(),
 *      the real createRepairObligation() underneath) that the one-time
 *      global cutover script uses -- this module performs NO
 *      normalization computation of its own.
 *   2. commitLearningEngineV1Enrollment() (lib/learning-engine/cutover/dal.ts)
 *      -- hands that prepared payload to ONE atomic trusted transaction
 *      (commit_learning_engine_v1_enrollment(), migration
 *      20261020000000_learning_engine_v1_enrollment_atomic_commit.sql)
 *      that locks the user's profile row (the SAME row
 *      start_or_resume_session() locks before creating a Session),
 *      re-checks rollout/active-Session state under that lock, applies
 *      every prepared card normalization, recomputes deck state, and
 *      admits -- all inside one transaction. See that migration's own
 *      header for the full race analysis and why this lock order closes
 *      it. No legacy Session can ever be created between "normalization
 *      applied" and "rollout row committed": either outcome is possible,
 *      never a mix of the two.
 *
 * getLearningEngineV1RolloutRow()/getActiveLegacySessionForUser() below
 * remain as FAST-PATH pre-checks only (skip the read-heavy prepare step
 * for the common already-enrolled/active-session cases) -- never the
 * authoritative guard. The atomic transaction is authoritative on its
 * own; these pre-checks are a performance optimization layered on top,
 * not a substitute for it.
 */

import {
  prepareLearningEngineV1NormalizationForUser,
  LEARNING_ENGINE_V1_CUTOVER_NORMALIZATION_VERSION,
} from "@/lib/learning-engine/cutover/prepare-normalization";
import {
  commitLearningEngineV1Enrollment,
  getActiveLegacySessionForUser,
  getLearningEngineV1RolloutRow,
  type LearningEngineV1RolloutRow,
} from "@/lib/learning-engine/cutover/dal";

export interface EnrollUserInLearningEngineV1Result {
  readonly cardsNormalized: number;
  readonly cardsSkippedNew: number;
  readonly decksRecomputed: number;
  readonly rollout: LearningEngineV1RolloutRow;
}

/**
 * Thrown when enrollment is rejected because this user currently has an
 * ACTIVE, engine_version='legacy' session -- see this module's header.
 * The caller must have the user explicitly finish that session
 * (lib/sessions/dal.ts's finishSession(), normal product UI) and retry;
 * this function never finishes it on their behalf. `sessionId` is always
 * the real, authoritative session id -- whether this was caught by the
 * fast-path pre-check or (the rare race case) returned by the atomic
 * transaction itself.
 */
export class ActiveLegacySessionEnrollmentError extends Error {
  readonly userId: string;
  readonly sessionId: string;

  constructor(userId: string, sessionId: string) {
    super(
      `enrollUserInLearningEngineV1: user ${userId} has an active legacy session (${sessionId}) -- ` +
        "it must be finished before this user can be enrolled in Learning Engine v1.",
    );
    this.name = "ActiveLegacySessionEnrollmentError";
    this.userId = userId;
    this.sessionId = sessionId;
  }
}

export async function enrollUserInLearningEngineV1(userId: string): Promise<EnrollUserInLearningEngineV1Result> {
  // Fast-path pre-checks only -- see module header. Neither is required
  // for correctness; both just avoid unnecessary work in the common case.
  const existingRollout = await getLearningEngineV1RolloutRow(userId);
  if (existingRollout !== null) {
    return {
      cardsNormalized: 0,
      cardsSkippedNew: 0,
      decksRecomputed: 0,
      rollout: existingRollout,
    };
  }

  const activeLegacySession = await getActiveLegacySessionForUser(userId);
  if (activeLegacySession !== null) {
    throw new ActiveLegacySessionEnrollmentError(userId, activeLegacySession.id);
  }

  const prepared = await prepareLearningEngineV1NormalizationForUser(userId);

  const result = await commitLearningEngineV1Enrollment(userId, {
    normalizationVersion: LEARNING_ENGINE_V1_CUTOVER_NORMALIZATION_VERSION,
    cards: prepared.cardsToNormalize,
    deckIds: prepared.deckIds,
  });

  if (result.status === "active_legacy_session") {
    // The rare race: a legacy session was created after the fast-path
    // pre-check above passed, but before this transaction committed. The
    // atomic transaction itself is what caught it -- nothing was
    // normalized (see migration 20261020000000's header).
    throw new ActiveLegacySessionEnrollmentError(userId, result.sessionId);
  }

  if (result.status === "already_enrolled") {
    // The rare race in the other direction: a concurrent enrollment call
    // for this same user committed first. Converges to the same true
    // no-op the fast-path check above returns.
    return {
      cardsNormalized: 0,
      cardsSkippedNew: prepared.cardsSkippedNew,
      decksRecomputed: 0,
      rollout: result.rollout,
    };
  }

  return {
    cardsNormalized: result.cardsNormalized,
    cardsSkippedNew: prepared.cardsSkippedNew,
    decksRecomputed: result.decksRecomputed,
    rollout: result.rollout,
  };
}
