/**
 * Learning Engine v1 -- Runtime Cutover RC-A: one-time legacy-state
 * normalization script.
 *
 * NOT part of the live application. Never imported by any Server
 * Action, API route, or Session UI code path -- this is an operational
 * tool an operator runs once, manually, against the local/staging
 * Supabase stack, using the service-role key. Requires a TypeScript-
 * capable runner (e.g. `pnpm dlx tsx scripts/learning-engine-v1-cutover-normalize.ts`)
 * -- this project has no such runner wired into package.json yet; adding
 * one is an operational decision for whoever actually executes the
 * one-time cutover, deliberately left open here since RC-A explicitly
 * does not perform a live cutover (approved plan section 17/19).
 *
 * What this script does, in order, for every (user, deck) pair that has
 * at least one `user_card_progress` row:
 *   1. Reads every card's current legacy card_status (NEW/LEARNING/
 *      LEARNED/FORGOTTEN).
 *   2. For the deck's FORGOTTEN cards only, assigns stable synthetic
 *      ordinals (ascending card_id) via assignForgottenOrdinals().
 *   3. Computes each card's complete v1-normalized target state via the
 *      pure lib/learning-engine/cutover/normalize-legacy-state.ts
 *      module (NEW is a no-op and is skipped; LEARNING/LEARNED/FORGOTTEN
 *      are persisted via normalizeCardProgress()).
 *   4. Once every card in a deck has been normalized, recomputes that
 *      deck's mastered_count/has_achieved_full_mastery via
 *      recomputeUserDeckLearningState().
 *
 * Idempotent: re-running this script is safe. normalizeCardProgress()'s
 * expected-legacy-card_status check means a card ALREADY normalized to
 * its v1 target (card_status unchanged for LEARNING/LEARNED/FORGOTTEN --
 * only learning_stage/pool_status/etc. change) will simply be
 * re-written with the identical target state the deterministic RNG
 * reproduces -- not silently skipped, not double-applied.
 *
 * Does NOT touch sessions.engine_version, learning_engine_v1_rollout,
 * selection_claims, or user_card_progress.last_presented_scheduler_position
 * -- those are live-runtime concerns for RC-B/RC-C/RC-D, out of RC-A's
 * normalization scope.
 *
 * The read + per-card target computation this script performs (grouping
 * by deck, assigning FORGOTTEN ordinals, deriving a deterministic seed,
 * calling computeNormalizedCardProgress()) now lives in
 * lib/learning-engine/cutover/prepare-normalization.ts, shared with the
 * pre-RC-E atomic per-user enrollment path
 * (lib/learning-engine/cutover/enroll.ts) so both compute IDENTICAL
 * targets from IDENTICAL rows -- this script's own behavior/output
 * (NormalizationSummary) is unchanged by that extraction.
 */

import {
  computeNormalizationTargets,
  readLegacyCardRowsForNormalization,
  LEARNING_ENGINE_V1_CUTOVER_NORMALIZATION_VERSION,
} from "@/lib/learning-engine/cutover/prepare-normalization";
import { normalizeCardProgress, recomputeUserDeckLearningState } from "@/lib/learning-engine/cutover/dal";

interface NormalizationSummary {
  readonly cardsNormalized: number;
  readonly cardsSkippedNew: number;
  readonly decksRecomputed: number;
}

/**
 * `userId`: omitted for the original RC-A global cutover run --
 * normalizes every (user, deck) pair with any pre-existing legacy
 * progress. Supplied to scope the entire run to that one user's own
 * (user, deck) pairs only -- used by tests exercising this script
 * directly; the live per-user enrollment path
 * (lib/learning-engine/cutover/enroll.ts) no longer calls this function
 * at all (pre-RC-E correction: it composes
 * prepareLearningEngineV1NormalizationForUser() with the atomic
 * commit_learning_engine_v1_enrollment() transaction instead, so that
 * normalization and rollout admission commit together). Behavior and
 * idempotency here are otherwise unchanged either way.
 */
export async function runLearningEngineV1CutoverNormalization(options?: {
  readonly userId?: string;
}): Promise<NormalizationSummary> {
  const rows = await readLegacyCardRowsForNormalization(options?.userId);
  const { cardsToNormalize, cardsSkippedNew, deckIdsByUser } = computeNormalizationTargets(
    rows,
    LEARNING_ENGINE_V1_CUTOVER_NORMALIZATION_VERSION,
  );

  for (const card of cardsToNormalize) {
    await normalizeCardProgress({
      userId: card.userId,
      cardId: card.cardId,
      expectedLegacyCardStatus: card.expectedLegacyCardStatus,
      target: card.target,
      normalizationVersion: LEARNING_ENGINE_V1_CUTOVER_NORMALIZATION_VERSION,
    });
  }

  let decksRecomputed = 0;
  for (const [userId, deckIds] of deckIdsByUser) {
    for (const deckId of deckIds) {
      await recomputeUserDeckLearningState(userId, deckId);
      decksRecomputed += 1;
    }
  }

  return {
    cardsNormalized: cardsToNormalize.length,
    cardsSkippedNew,
    decksRecomputed,
  };
}

// Deliberately no top-level self-invocation here: this project has no
// TypeScript script runner wired into package.json yet (no `tsx`/
// `ts-node` dependency), and wiring one up is an operational decision
// for whoever actually executes the one-time cutover -- out of RC-A's
// scope (approved plan: "do not perform live cutover"). An operator
// invokes runLearningEngineV1CutoverNormalization() from a small
// wrapper at that time, e.g. via `pnpm dlx tsx` or a Node REPL import.
