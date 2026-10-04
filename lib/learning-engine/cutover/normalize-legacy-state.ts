/**
 * Learning Engine v1 -- Runtime Cutover RC-A: pure one-time
 * legacy-state-normalization logic.
 *
 * Source of truth: the approved Runtime Cutover Architecture plan
 * sections 3/4 (state-normalization plan), R1 (legacy LEARNING), R2
 * (legacy FORGOTTEN historical mastery), and the resolved pre-RC-A
 * invariant check + its approval (legacy FORGOTTEN repair-obligation
 * completeness, synthetic-anchor semantics, deterministic RNG).
 *
 * Pure and deterministic throughout: no database access, no clock
 * reads, no hidden `Math.random()` call. The only randomness
 * (FORGOTTEN's repair-gap sample) is injected via a `RandomSource` the
 * caller builds deterministically (lib/learning-engine/cutover/
 * deterministic-random.ts) -- this module never constructs its own
 * RandomSource.
 *
 * This module computes a target state only. It never calls any database
 * function, never decides the per-deck synthetic ordering itself beyond
 * the one ordinal it is handed, and is not wired into any live
 * application code path (RC-A scope: "do not create live v1 claims
 * through normal Session UI... do not route live answers into v1").
 *
 * ---------------------------------------------------------------------
 * Legacy -> v1 mapping, per legacy card_status
 * ---------------------------------------------------------------------
 * NEW: a true no-op. Legacy NEW already matches
 * lib/learning-engine/state.ts's own INITIAL_CARD_STATE (learning_stage
 * null, pool_status null, relearning_phase null, has_ever_been_mastered
 * false, no repair state) -- this module still returns a complete,
 * explicit target for it (never special-cased away) so every caller has
 * one uniform contract, but a caller MAY skip persisting it as a pure
 * optimization (documented, never required for correctness).
 *
 * LEARNING (R1, APPROVED): re-enters the v1 acquisition ladder from
 * FRESH -- "fresh under v1 acquisition evidence", not "never seen
 * before". Does NOT infer LEARNING_1/LEARNING_2 from legacy
 * seen_count/correct_streak/wrong_streak/history, because legacy never
 * recorded the same-day retrieval evidence v1's ladder requires. This is
 * intentionally conservative, per the approved decision.
 *
 * LEARNED: preserves the already-audited plan (pool_status -> OUTSIDE;
 * has_ever_been_mastered -> true, matching the Phase 1 backfill's own
 * `card_status = 'LEARNED'` rule, unchanged here).
 *
 * FORGOTTEN (R2 + the approved pre-RC-A repair-completeness rule):
 * has_ever_been_mastered forced true (the one-time legacy-normalization
 * inference the pre-RC-A audit approved -- NEVER encoded as a general
 * v1 invariant; see the module-level warning below) by first
 * constructing a SYNTHETIC "was LEARNED, about to fail a long-term
 * review" pre-state and feeding it through the real, unmodified
 * `applyLongTermWrong()` (lib/learning-engine/transitions.ts) -- the
 * exact function a real long-term/Near-Due Wrong uses -- rather than
 * hand-duplicating its field assignments. A complete `RepairObligation`
 * is then constructed via the real, unmodified `createRepairObligation()`
 * (lib/learning-engine/repair-scheduler.ts), seeded with a caller-supplied
 * deterministic RandomSource and a caller-supplied, per-deck-stable
 * synthetic ordinal (NOT a reconstructed historical position -- see that
 * parameter's own doc comment below).
 *
 * ---------------------------------------------------------------------
 * WARNING -- do not generalize the FORGOTTEN inference
 * ---------------------------------------------------------------------
 * "legacy FORGOTTEN implies has_ever_been_mastered = true" is true only
 * because the AUDITED LEGACY runtime's only path to FORGOTTEN requires
 * the card to have been LEARNED moments before (commit_answer_transaction()'s
 * review-mode double-Wrong branch, which only ever operates on a card
 * already in the review queue, which is seeded exclusively from
 * card_status = 'LEARNED' rows). This is NOT a permanent v1 lifecycle
 * rule: under the real v1 engine, a never-mastered ACQUIRED card can
 * fail a long-term/Near-Due review and become FORGOTTEN
 * (applyLongTermWrong accepts cardStatus ACQUIRED as a valid
 * precondition) without ever having been mastered. This module's
 * `computeNormalizedForgottenCard` is a ONE-TIME LEGACY NORMALIZATION
 * helper, deliberately kept in this cutover-only module rather than
 * folded into lib/learning-engine/transitions.ts, precisely so it can
 * never be mistaken for or accidentally reused as a general v1
 * transition.
 */

import {
  INITIAL_CARD_STATE,
  type CardStatus as LearningEngineCardStatus,
  type LearningEngineCardState,
  type LearningStage,
  type PoolStatus,
  type RelearningPhase,
} from "@/lib/learning-engine/state";
import { applyLongTermWrong } from "@/lib/learning-engine/transitions";
import { createRepairObligation, type RepairObligation } from "@/lib/learning-engine/repair-scheduler";
import type { RandomSource } from "@/lib/learning-engine/cutover/deterministic-random";

/** The four legacy card_status values this one-time normalization ever reads. ACQUIRED does not exist in the legacy enum, so it is never a valid input here. */
export type LegacyCardStatus = "NEW" | "LEARNING" | "LEARNED" | "FORGOTTEN";

/**
 * The complete v1-shaped target state for one `user_card_progress` row,
 * one-to-one with the parameters of the RC-A migration's
 * `normalize_card_progress_for_learning_engine_v1()` trusted function.
 * Always fully populated (never a sparse "patch") -- RC-A's normalization
 * always knows, and always writes, every one of these fields.
 */
export interface NormalizedCardProgressTarget {
  readonly cardStatus: LearningEngineCardStatus;
  readonly learningStage: LearningStage;
  readonly poolStatus: PoolStatus;
  readonly relearningPhase: RelearningPhase;
  readonly hasEverBeenMastered: boolean;

  /**
   * The `user_card_progress.repair_pending` DATABASE COLUMN's value --
   * NOT the same thing as `LearningEngineCardState.repairPending` (the
   * pure transition-function field, scoped only to the WITHIN-DAY
   * repair mechanism; see lib/learning-engine/state.ts's own doc
   * comment). The DB column instead mirrors "does a `RepairObligation`
   * object exist for this card at all" (lib/learning-engine/
   * repair-scheduler.ts's `RepairObligation` doc comment: "the existence
   * of this object IS repair_pending = true"), which is true for BOTH
   * the within-day mechanism (`applyWrong`) AND the long-term relearning
   * mechanism (`applyLongTermWrong`'s `REPAIR_PENDING` phase) -- the two
   * are governed together by `isGovernedByRepairObligation`, but only
   * the within-day one ever touches the narrower TS state field of the
   * same name. For a FORGOTTEN card normalized by this module,
   * `repairPending` here is `true` precisely because `repairWrongPosition`
   * / `repairTargetPosition` / `repairHardCapPosition` below are
   * populated -- even though `applyLongTermWrong()` itself leaves
   * `LearningEngineCardState.repairPending` at `false` (it only sets
   * `relearningPhase`). Do not "simplify" this by copying
   * `LearningEngineCardState.repairPending` verbatim into this field --
   * that would silently produce `repair_pending = false` with non-null
   * repair positions, which is exactly the inconsistent shape the RC-A
   * SQL function's own structural-completeness check rejects.
   */
  readonly repairPending: boolean;
  readonly repairWrongPosition: number | null;
  readonly repairTargetPosition: number | null;
  readonly repairHardCapPosition: number | null;
}

const NEW_TARGET: NormalizedCardProgressTarget = {
  cardStatus: "NEW",
  learningStage: null,
  poolStatus: null,
  relearningPhase: null,
  hasEverBeenMastered: false,
  repairPending: false,
  repairWrongPosition: null,
  repairTargetPosition: null,
  repairHardCapPosition: null,
};

const LEARNING_TARGET: NormalizedCardProgressTarget = {
  cardStatus: "LEARNING",
  learningStage: "FRESH",
  poolStatus: "ACTIVE",
  relearningPhase: null,
  hasEverBeenMastered: false,
  repairPending: false,
  repairWrongPosition: null,
  repairTargetPosition: null,
  repairHardCapPosition: null,
};

const LEARNED_TARGET: NormalizedCardProgressTarget = {
  cardStatus: "LEARNED",
  learningStage: null,
  poolStatus: "OUTSIDE",
  relearningPhase: null,
  hasEverBeenMastered: true,
  repairPending: false,
  repairWrongPosition: null,
  repairTargetPosition: null,
  repairHardCapPosition: null,
};

/**
 * The synthetic pre-state fed into the real `applyLongTermWrong()` to
 * derive a legacy FORGOTTEN card's target card-lifecycle fields. Not a
 * claim that this card was ever actually in this exact state -- it is
 * the minimal state satisfying `applyLongTermWrong`'s own documented
 * precondition (`cardStatus` ACQUIRED or LEARNED, `poolStatus` OUTSIDE)
 * that also encodes R2's approved `hasEverBeenMastered = true` inference
 * and the "no historical FSRS-review-count evidence exists" decision
 * (approved plan section 3: mastery counters stay at their column
 * default of 0 for legacy-sourced rows).
 */
const SYNTHETIC_FORGOTTEN_PRE_STATE: LearningEngineCardState = {
  ...INITIAL_CARD_STATE,
  cardStatus: "LEARNED",
  poolStatus: "OUTSIDE",
  hasEverBeenMastered: true,
};

/**
 * Computes one legacy FORGOTTEN card's complete, internally-consistent
 * v1 target state.
 *
 * `syntheticWrongPosition` is a ONE-TIME SYNTHETIC ORDERING COORDINATE,
 * NOT a reconstructed historical Wrong position:
 *   - it exists only to let the real `createRepairObligation()` produce
 *     a complete target/hard-cap window for a legacy backlog that has no
 *     real v1 `scheduler_position` history to anchor to;
 *   - stable ordering is defined by ascending `card_id` within each deck
 *     (see `assignForgottenOrdinals` below) -- the ordinal, not the
 *     card's real historical Wrong instant, which no longer exists in
 *     any recoverable form;
 *   - it does NOT claim the historical Wrong occurred at v1
 *     `scheduler_position = syntheticWrongPosition`;
 *   - because the v1 scheduler epoch begins at `scheduler_position = 0`
 *     (approved plan R3), some synthetic ordinals -- and therefore some
 *     resulting `repair_target_position`/`repair_hard_cap_position`
 *     values -- may be numerically GREATER than the deck's current
 *     `scheduler_position` (which is exactly 0 at cutover). This is
 *     PERMITTED ONLY for this one-time legacy-normalization path. Normal
 *     v1 Wrong handling (`applyWrong`/`applyLongTermWrong`, invoked by a
 *     real future answer-commit transaction) always uses the REAL
 *     current `scheduler_position` at the moment of a real Wrong, never
 *     a synthetic ordinal -- confirmed by the pre-RC-A invariant audit:
 *     no schema CHECK constraint and no pure-scheduler code anywhere
 *     assumes `repair_wrong_position <= scheduler_position`, or that a
 *     repair's positions must originate from an already-committed v1
 *     answer (see this module's test file for the audit trail).
 *   - the ordinary 3-6-intervening-card / hard-cap semantics remain
 *     EXACT relative to this synthetic anchor: `createRepairObligation()`
 *     is called completely unmodified, so
 *     `targetPosition - wrongPosition` and `hardCapPosition - wrongPosition`
 *     obey the identical formula a real Wrong would produce.
 *
 * `random` must be a deterministic `RandomSource` (lib/learning-engine/
 * cutover/deterministic-random.ts's `createDeterministicRandom`), never
 * `Math.random` -- see that module's header for why.
 */
export function computeNormalizedForgottenCard(
  syntheticWrongPosition: number,
  random: RandomSource,
  cardId: string,
): NormalizedCardProgressTarget {
  const postState = applyLongTermWrong(SYNTHETIC_FORGOTTEN_PRE_STATE);
  const obligation: RepairObligation = createRepairObligation({
    cardId,
    wrongPosition: syntheticWrongPosition,
    random,
  });

  return {
    cardStatus: postState.cardStatus,
    learningStage: postState.learningStage,
    poolStatus: postState.poolStatus,
    relearningPhase: postState.relearningPhase,
    hasEverBeenMastered: postState.hasEverBeenMastered,
    // See NormalizedCardProgressTarget.repairPending's own doc comment --
    // deliberately NOT postState.repairPending (which stays false;
    // applyLongTermWrong never touches that narrower TS field).
    repairPending: true,
    repairWrongPosition: obligation.wrongPosition,
    repairTargetPosition: obligation.targetPosition,
    repairHardCapPosition: obligation.hardCapPosition,
  };
}

/**
 * Assigns the stable per-deck synthetic ordinal each legacy FORGOTTEN
 * card needs (0, 1, 2, ... by ascending `card_id` within the deck) --
 * staggered, not clustered, so that many FORGOTTEN cards in the same
 * deck do not all share an identical `repair_hard_cap_position` (which
 * would otherwise force a long unbroken run of mandatory repair-hard-cap
 * interrupts immediately after cutover for any tester with many
 * relearning cards -- a UX pile-up risk flagged during the pre-RC-A
 * audit, not a validity defect). A pure function of the input card-id
 * set alone, so "stable ordering produces stable synthetic anchors"
 * (RC-A test requirement) holds for any caller that passes the same set.
 */
export function assignForgottenOrdinals(forgottenCardIds: readonly string[]): ReadonlyMap<string, number> {
  const sorted = [...forgottenCardIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const ordinals = new Map<string, number>();
  sorted.forEach((cardId, index) => {
    ordinals.set(cardId, index);
  });
  return ordinals;
}

/**
 * The single entry point covering all four legacy card_status values.
 * Returns the complete target state for every case -- callers decide
 * for themselves whether skipping the NEW case's write is worth the
 * optimization (see NEW_TARGET's own doc comment); this function never
 * special-cases it away.
 *
 * `forgottenOrdinal`/`random` are required only for the FORGOTTEN case
 * and are ignored (and may be any value) for every other legacy status
 * -- kept as plain required parameters rather than made conditionally
 * optional so a caller cannot forget to supply them for a FORGOTTEN row
 * by accident.
 */
export function computeNormalizedCardProgress(input: {
  readonly legacyCardStatus: LegacyCardStatus;
  readonly cardId: string;
  readonly forgottenOrdinal: number;
  readonly random: RandomSource;
}): NormalizedCardProgressTarget {
  switch (input.legacyCardStatus) {
    case "NEW":
      return NEW_TARGET;
    case "LEARNING":
      return LEARNING_TARGET;
    case "LEARNED":
      return LEARNED_TARGET;
    case "FORGOTTEN":
      return computeNormalizedForgottenCard(input.forgottenOrdinal, input.random, input.cardId);
  }
}
