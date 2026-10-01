/**
 * Learning Engine v1 -- ACTIVE source candidate selection (Phase 6C of
 * the implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 3
 * ("NEW"), 8.2 (Fresh limit: "FRESH means the card has not yet achieved
 * its first successful retrieval"), and 19 ("Active card priority").
 *
 * Reuses, never duplicates: Phase 3's computeActiveWeight (stage weight x
 * aging multiplier) and isEligibleForNormalSelection (Correct cooldown
 * gate), both from lib/learning-engine/active-priority.ts; Phase 4's
 * isGovernedByRepairObligation, from lib/learning-engine/
 * repair-scheduler.ts, to exclude repair/relearning-governed cards.
 *
 * Does NOT implement the Active starvation override (section 22.3) --
 * that is Phase 6D's job. This module only exposes
 * findActiveStarvationCandidates, the raw filtered candidate list Phase
 * 6D needs; it performs no priority resolution and does not increment or
 * reset active_draws_since_eligible (that bookkeeping remains
 * advanceActiveDrawCounters's job, called by whichever later phase
 * actually drives a draw loop).
 *
 * ---------------------------------------------------------------------
 * Fixed in review: NEW cards are ordinary Active candidates too
 * ---------------------------------------------------------------------
 * An earlier version of this module required card_status === "LEARNING"
 * for ordinary Active eligibility, which silently excluded every
 * card_status = NEW / pool_status = ACTIVE card from ordinary weighted
 * selection entirely -- contradicting section 3 ("a card may already be
 * placed in ACTIVE while still NEW... entering Active does not change
 * NEW -> LEARNING") and section 8.2's own definition of FRESH, which
 * lib/learning-engine/active-pool.ts's isFresh() already treats a
 * never-presented NEW+ACTIVE card as satisfying (for Active Pool sizing
 * purposes) -- this module now extends that identical principle to
 * weighted selection: such a card participates at the FRESH base weight
 * (1.00), WITHOUT this selector ever mutating card_status. NEW ->
 * LEARNING remains exclusively lib/learning-engine/transitions.ts's
 * applyFirstPresentation's responsibility, invoked later at
 * presentation/claim integration -- selection stays pure, read-only, and
 * free of lifecycle side effects.
 *
 * ---------------------------------------------------------------------
 * Approved ACTIVE-source internal ordering (for Phase 6D/6E -- not
 * implemented here)
 * ---------------------------------------------------------------------
 * Once the overall source selection has already chosen ACTIVE as this
 * draw's source (a decision this module has no part in -- see
 * lib/learning-engine/scheduler/source-policy.ts), the approved order in
 * which Phase 6D/6E must resolve a card WITHIN that source is:
 *   1. Active starvation guarantee (section 22.3; this module's
 *      findActiveStarvationCandidates provides the raw candidate set,
 *      not the winner)
 *   2. a target-reached Repair candidate (reuse Phase 4's
 *      isRepairTargetReached/selectRepairCandidate in
 *      lib/learning-engine/repair-scheduler.ts -- do not duplicate)
 *   3. a due Spaced Confirmation candidate (lib/learning-engine/
 *      scheduler/spaced-confirmation-selection.ts's
 *      selectDueSpacedConfirmationCard)
 *   4. an ordinary weighted Active candidate (this module's
 *      chooseActiveCard)
 * This ordering is internal to the ACTIVE source only. It does not
 * change, and sits entirely below, the two GLOBAL interrupts that
 * already precede source selection itself: Repair HARD CAP (Phase 4's
 * findMandatoryRepairInterrupt) remains the first global interrupt,
 * Critical Due remains the second -- both are evaluated, and can both
 * short-circuit the whole pipeline, before source selection (and
 * therefore before this ordering) is ever reached. Spaced Confirmation
 * never receives its own global source-weight percentage (per the Phase
 * 6C review decision) -- it is reached only via this internal ordering,
 * after ACTIVE has already been chosen as the draw's source.
 */

import { ACTIVE_STARVATION_MAX_DRAWS } from "@/lib/learning-engine/config";
import {
  computeActiveWeight,
  isEligibleForNormalSelection,
  type ActiveEligibleStage,
} from "@/lib/learning-engine/active-priority";
import { isGovernedByRepairObligation } from "@/lib/learning-engine/repair-scheduler";
import { weightedRandomChoice, type RandomSource } from "@/lib/learning-engine/scheduler/weighted-random";
import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

/**
 * One card narrowed to an ordinary Active candidate. `effectiveStage` is
 * the stage used for WEIGHTING -- proven (by construction, not by cast)
 * to be one of the three stages computeActiveWeight accepts -- and may
 * differ from the card's own literal `learningStage`: a never-presented
 * NEW card has `learningStage === null` (section 3) but an
 * `effectiveStage` of "FRESH" (section 8.2), since this selector treats
 * it as Fresh for weighting purposes without claiming it IS, lifecycle-
 * wise, in the FRESH learning_stage.
 */
export interface OrdinaryActiveCandidate {
  readonly card: SchedulableCardRow;
  readonly effectiveStage: ActiveEligibleStage;
}

function toOrdinaryActiveCandidate(card: SchedulableCardRow, schedulerPosition: number): OrdinaryActiveCandidate | null {
  if (card.poolStatus !== "ACTIVE") {
    return null;
  }
  // Excludes a REPAIR_PENDING or SPACED_CONFIRMATION_PENDING card from
  // ordinary Active weighting -- the latter is handled entirely through
  // lib/learning-engine/scheduler/spaced-confirmation-selection.ts's
  // separate channel, never folded in here. A NEW card can never
  // actually be repair/relearning-governed under the engine's own
  // invariants (repair_pending/relearning_phase only ever apply to
  // card_status LEARNING/FORGOTTEN), but this check runs before the
  // card_status branch below so it applies uniformly to both cases,
  // rather than being duplicated inside each one.
  if (isGovernedByRepairObligation(card)) {
    return null;
  }
  if (!isEligibleForNormalSelection(card, schedulerPosition)) {
    return null;
  }

  // Case A: a NEW card admitted to Active but never yet presented
  // (section 3: "entering Active does not change NEW -> LEARNING... the
  // transition occurs on first actual presentation in a session").
  // Section 8.2 defines FRESH as "has not yet achieved its first
  // successful retrieval" -- trivially true of a never-presented NEW
  // card, so it is treated as FRESH for weighting here, exactly as
  // lib/learning-engine/active-pool.ts's isFresh() already treats it for
  // Active Pool sizing. This branch never mutates card_status -- see
  // this module's header for why that must stay exclusively
  // applyFirstPresentation's job, invoked later, not here.
  if (card.cardStatus === "NEW") {
    return { card, effectiveStage: "FRESH" };
  }

  // Case B: ordinary within-day acquisition (FRESH/LEARNING_1/
  // LEARNING_2) -- a FORGOTTEN card never has card_status LEARNING or a
  // non-null learningStage at all, so it is already excluded by this
  // branch's own condition without needing a separate check.
  if (card.cardStatus === "LEARNING" && (card.learningStage === "FRESH" || card.learningStage === "LEARNING_1" || card.learningStage === "LEARNING_2")) {
    return { card, effectiveStage: card.learningStage };
  }

  return null;
}

/**
 * The full ordinary Active candidate set: pool_status ACTIVE, an
 * ordinary acquisition stage, clear of normal Correct cooldown, and not
 * governed by any repair/relearning obligation. Exported on its own
 * (not just as chooseActiveCard's internal filter step) so Phase 6D can
 * scan this exact set for starvation candidates without re-deriving
 * eligibility itself.
 */
export function selectOrdinaryActiveCandidates(
  cards: readonly SchedulableCardRow[],
  schedulerPosition: number,
): readonly OrdinaryActiveCandidate[] {
  const candidates: OrdinaryActiveCandidate[] = [];
  for (const card of cards) {
    const candidate = toOrdinaryActiveCandidate(card, schedulerPosition);
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

export interface ActiveSelectionResult {
  readonly cardId: string;
  readonly weight: number;
  readonly candidateCount: number;
}

/**
 * Section 19: `active_weight = stage_base_weight * aging_multiplier`,
 * sampled via the shared weighted-random primitive. Returns `null` for a
 * genuinely empty candidate set (no eligible ordinary Active card right
 * now) rather than throwing -- Phase 6E's orchestration decides what to
 * do about an empty source, not this selector (Phase 6C brief section
 * 9).
 */
export function chooseActiveCard(
  cards: readonly SchedulableCardRow[],
  schedulerPosition: number,
  random: RandomSource,
): ActiveSelectionResult | null {
  const candidates = selectOrdinaryActiveCandidates(cards, schedulerPosition);
  if (candidates.length === 0) {
    return null;
  }

  const weighted = candidates.map((candidate) => {
    const weight = computeActiveWeight({
      learningStage: candidate.effectiveStage,
      activeDrawsSinceEligible: candidate.card.activeDrawsSinceEligible,
    });
    return { item: { cardId: candidate.card.cardId, weight }, weight };
  });

  const winner = weightedRandomChoice(weighted, random);
  return { cardId: winner.cardId, weight: winner.weight, candidateCount: candidates.length };
}

/**
 * Section 22.3/Phase 6C brief section 7: the raw material Phase 6D needs
 * to enforce "an eligible Active card that survives 40 Active-source
 * selections without being selected is guaranteed on the next Active
 * slot." This function only filters `candidates` (already eligible, via
 * selectOrdinaryActiveCandidates) down to those at or past the
 * threshold -- it does NOT pick a winner among them (oldest-survivor-
 * first + RNG tie-break, per the confirmed Phase 6 architecture
 * decision, is Phase 6D's job) and does not touch
 * active_draws_since_eligible itself.
 */
export function findActiveStarvationCandidates(
  candidates: readonly OrdinaryActiveCandidate[],
  threshold: number = ACTIVE_STARVATION_MAX_DRAWS,
): readonly OrdinaryActiveCandidate[] {
  return candidates.filter((candidate) => candidate.card.activeDrawsSinceEligible >= threshold);
}
