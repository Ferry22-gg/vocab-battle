import "server-only";

/**
 * Learning Engine v1 -- Runtime Cutover RC-D: the minimal trusted,
 * per-user enrollment orchestration RC-A intentionally left unbuilt (RC-A's
 * own header: "no function in this migration deletes or inserts rows
 * here; that trusted write path is explicitly out of RC-A's scope").
 *
 * This is the ONLY intended caller of
 * admitUserToLearningEngineV1() (lib/learning-engine/cutover/dal.ts).
 * Never imported by any Server Action, API route, or Session UI code
 * path -- this is an operational/test-setup primitive, invoked by a
 * trusted operator or by integration-test fixture setup using a
 * dedicated test-owned identity (RC-D section 29: never a real tester
 * yet).
 *
 * Order matters and is NOT optional:
 *   1. Normalize every one of this user's existing (user, deck) pairs
 *      that has pre-existing legacy progress, via the exact same
 *      reusable normalization run the RC-A one-time global cutover
 *      script uses (scripts/learning-engine-v1-cutover-normalize.ts),
 *      scoped to this one user only.
 *   2. Only after that succeeds, admit the user
 *      (admitUserToLearningEngineV1()) -- writing the
 *      learning_engine_v1_rollout row.
 *
 * This ordering is what makes "a learning_engine_v1_rollout row exists"
 * a safe, sufficient v1-readiness signal for start_or_resume_session()
 * (RC-D's own migration header, 20261017000000): by the time this
 * function returns, every (user, deck) pair this user could possibly
 * start a NEW v1 session against -- past (already had progress) or
 * future (duplicate_starter_deck() always seeds fresh NEW rows, already
 * v1-safe with no normalization needed) -- is guaranteed safe for
 * chooseNextCard().
 *
 * Idempotent: re-running this for an already-enrolled user is safe
 * (normalization re-applies the identical deterministic target state;
 * admitUserToLearningEngineV1() is ON CONFLICT DO NOTHING).
 */

import { runLearningEngineV1CutoverNormalization } from "@/scripts/learning-engine-v1-cutover-normalize";
import { admitUserToLearningEngineV1, type LearningEngineV1RolloutRow } from "@/lib/learning-engine/cutover/dal";

export interface EnrollUserInLearningEngineV1Result {
  readonly cardsNormalized: number;
  readonly cardsSkippedNew: number;
  readonly decksRecomputed: number;
  readonly rollout: LearningEngineV1RolloutRow;
}

export async function enrollUserInLearningEngineV1(userId: string): Promise<EnrollUserInLearningEngineV1Result> {
  const normalization = await runLearningEngineV1CutoverNormalization({ userId });
  const rollout = await admitUserToLearningEngineV1(userId);

  return {
    cardsNormalized: normalization.cardsNormalized,
    cardsSkippedNew: normalization.cardsSkippedNew,
    decksRecomputed: normalization.decksRecomputed,
    rollout,
  };
}
