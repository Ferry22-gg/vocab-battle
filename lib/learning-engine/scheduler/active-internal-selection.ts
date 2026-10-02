/**
 * Learning Engine v1 -- ACTIVE-source internal selection (Phase 6D of the
 * implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 22.3
 * (Active starvation) and the approved ACTIVE-source internal ordering
 * documented in lib/learning-engine/scheduler/active-selection.ts's module
 * header (reproduced by the Phase 6D brief sections 8-12):
 *
 *   1. Active starvation guarantee
 *   2. target-reached Repair candidate (reached its sampled target, but
 *      NOT yet its hard cap -- a hard-cap-reached repair is a GLOBAL
 *      interrupt, lib/learning-engine/scheduler/interrupts.ts, and never
 *      reaches this module)
 *   3. due Spaced Confirmation candidate
 *   4. ordinary weighted Active candidate
 *
 * This module is reached ONLY after ordinary top-level source selection
 * (a later phase) has already chosen ACTIVE as this draw's source. It has
 * no part in, and must never be able to force, that choice -- see
 * ActiveInternalSelection's own doc comment and lib/learning-engine/
 * scheduler/interrupts.ts's header for how the two stay structurally
 * separate.
 *
 * Reuses, never duplicates: Phase 6C's selectOrdinaryActiveCandidates/
 * findActiveStarvationCandidates/chooseActiveCard (lib/learning-engine/
 * scheduler/active-selection.ts); Phase 4's isRepairTargetReached/
 * isRepairHardCapReached/selectRepairCandidate (lib/learning-engine/
 * repair-scheduler.ts); Phase 6C's selectDueSpacedConfirmationCard
 * (lib/learning-engine/scheduler/spaced-confirmation-selection.ts). No
 * formula from any of those modules is reimplemented here -- this module
 * is purely a priority composition over their existing outputs.
 *
 * Pure and deterministic throughout: the only randomness is the injected
 * RandomSource, consumed only where an underlying selector itself needs
 * it (an exact starvation/repair tie-break, or the Critical-due-free
 * ordinary weighted draw) -- never a direct Math.random() call.
 *
 * Does NOT mutate active_draws_since_eligible, repair obligations, or any
 * other scheduling state (Phase 6D brief section 15: "selectors only
 * decide"). Does NOT implement the global interrupts, ordinary source
 * selection, or the full next-card pipeline -- see this module's header
 * and lib/learning-engine/scheduler/interrupts.ts for the explicit
 * boundary.
 */

import {
  chooseActiveCard,
  findActiveStarvationCandidates,
  selectOrdinaryActiveCandidates,
  type OrdinaryActiveCandidate,
} from "@/lib/learning-engine/scheduler/active-selection";
import {
  isRepairHardCapReached,
  isRepairTargetReached,
  selectRepairCandidate,
  type RepairObligation,
} from "@/lib/learning-engine/repair-scheduler";
import { selectDueSpacedConfirmationCard } from "@/lib/learning-engine/scheduler/spaced-confirmation-selection";
import type { RandomSource } from "@/lib/learning-engine/scheduler/weighted-random";
import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

export type { RandomSource };

// =============================================================================
// Section 13 of the Phase 6D brief: the ACTIVE-internal result type
// =============================================================================

/**
 * The result of ACTIVE-source internal selection, once ordinary source
 * selection has ALREADY chosen ACTIVE (a precondition this type cannot
 * itself enforce, but which every reason below presupposes). Deliberately
 * a *different*, structurally unrelated type from lib/learning-engine/
 * scheduler/interrupts.ts's GlobalInterruptResult -- there is no `source`
 * field here, and no shared member between the two unions, so
 * "active_starvation globally forces ACTIVE" cannot be expressed by
 * passing a value of this type where a GlobalInterruptResult is expected,
 * or vice versa.
 */
export type ActiveInternalSelection =
  | {
      readonly cardId: string;
      readonly reason: "active_starvation";
      /** Exposed for a future decision trace. */
      readonly activeDrawsSinceEligible: number;
    }
  | {
      readonly cardId: string;
      readonly reason: "repair_target";
      /** Exposed for a future decision trace -- the priority key this candidate won on. */
      readonly wrongPosition: number;
    }
  | {
      readonly cardId: string;
      readonly reason: "spaced_confirmation";
      /** Exposed for a future decision trace -- the priority key this candidate won on. */
      readonly correctCooldownUntilPosition: number;
    }
  | {
      readonly cardId: string;
      readonly reason: "active_weighted_selection";
      readonly weight: number;
      readonly candidateCount: number;
    }
  | null;

// =============================================================================
// Step 1 (section 22.3/Phase 6D brief section 8): Active starvation
// =============================================================================

/**
 * Section 22.3/Phase 6D brief section 8: "If an eligible ordinary Active
 * card has survived 40 Active-source selections without being selected,
 * guarantee it on the NEXT ACTIVE source slot." Participants are exactly
 * Phase 6C's ordinary eligible Active candidates (selectOrdinaryActiveCandidates
 * -- already excludes cooldown-blocked and repair/relearning-governed
 * cards, and already folds in the Phase 6C NEW+ACTIVE -> effectiveStage
 * FRESH correction); this function only adds the priority rule among
 * those at or past the threshold: highest activeDrawsSinceEligible first,
 * injected RNG only on an exact tie (Phase 6D brief section 8's approved
 * tie-break -- no timestamps, no other aging rule). Returns `null` for a
 * genuinely empty starvation set, never throws.
 */
export function selectActiveStarvationCandidate(
  cards: readonly SchedulableCardRow[],
  schedulerPosition: number,
  random: RandomSource,
): OrdinaryActiveCandidate | null {
  const ordinary = selectOrdinaryActiveCandidates(cards, schedulerPosition);
  const starved = findActiveStarvationCandidates(ordinary);
  if (starved.length === 0) {
    return null;
  }

  const maxDraws = Math.max(...starved.map((candidate) => candidate.card.activeDrawsSinceEligible));
  const oldest = starved.filter((candidate) => candidate.card.activeDrawsSinceEligible === maxDraws);

  if (oldest.length === 1) {
    return oldest[0];
  }

  const index = Math.min(Math.floor(random() * oldest.length), oldest.length - 1);
  return oldest[index];
}

// =============================================================================
// Step 2 (section 10 of the Phase 6D brief): target-reached Repair, NOT
// hard-cap-reached
// =============================================================================

/**
 * Section 10 of the Phase 6D brief: "A repair may have reached its
 * sampled target without having reached its hard cap. Such a card... may
 * be selected when ACTIVE is the chosen source." Deliberately excludes
 * any repair whose hard cap HAS been reached -- that repair is a GLOBAL
 * interrupt (lib/learning-engine/scheduler/interrupts.ts's
 * findRepairHardCapInterrupt) and, per the pipeline's own ordering, would
 * already have forced the draw before ordinary source selection -- and
 * therefore before this module -- ever ran. A caller that (incorrectly)
 * invoked this module without first checking the global interrupt gate
 * would still not double-select such a repair here, since
 * isRepairHardCapReached filters it out regardless.
 *
 * Collision priority among multiple simultaneously target-reached repairs
 * reuses Phase 4's selectRepairCandidate unchanged (oldest Wrong /
 * earliest hard cap wins, injected RNG only on an exact tie -- section 10:
 * "reuse the approved Phase 4 rule").
 */
export function selectTargetReachedRepairCandidate(
  cards: readonly SchedulableCardRow[],
  schedulerPosition: number,
  random: RandomSource,
): RepairObligation | null {
  const eligible: RepairObligation[] = [];
  for (const card of cards) {
    const obligation = card.repairObligation;
    if (obligation === null) {
      continue;
    }
    if (isRepairTargetReached(obligation, schedulerPosition) && !isRepairHardCapReached(obligation, schedulerPosition)) {
      eligible.push(obligation);
    }
  }

  return selectRepairCandidate(eligible, random);
}

// =============================================================================
// Section 12 of the Phase 6D brief: the ACTIVE internal composition
// =============================================================================

/**
 * The pure composition layer for ACTIVE-source selection (Phase 6D brief
 * section 12), executed in this exact order:
 *
 *   starvation candidate?            -> "active_starvation"
 *   else target-reached repair?      -> "repair_target"
 *   else due spaced confirmation?    -> "spaced_confirmation"
 *   else ordinary Active candidate?  -> "active_weighted_selection"
 *   else                             -> null
 *
 * Every step delegates entirely to an already-reviewed Phase 3/4/6C
 * primitive -- this function reimplements no formula of its own, it only
 * sequences them. Each step's RandomSource draw (if any) happens only
 * when that step actually has a candidate set to resolve a winner/tie
 * from; a step that returns no candidates consumes no random() call,
 * keeping the whole sequence exactly as deterministic as its underlying
 * primitives already are (section 14 of the Phase 6D brief).
 */
export function selectActiveInternalCard(
  cards: readonly SchedulableCardRow[],
  schedulerPosition: number,
  random: RandomSource,
): ActiveInternalSelection {
  const starvation = selectActiveStarvationCandidate(cards, schedulerPosition, random);
  if (starvation !== null) {
    return {
      cardId: starvation.card.cardId,
      reason: "active_starvation",
      activeDrawsSinceEligible: starvation.card.activeDrawsSinceEligible,
    };
  }

  const repairTarget = selectTargetReachedRepairCandidate(cards, schedulerPosition, random);
  if (repairTarget !== null) {
    return { cardId: repairTarget.cardId, reason: "repair_target", wrongPosition: repairTarget.wrongPosition };
  }

  const spacedConfirmation = selectDueSpacedConfirmationCard(cards, schedulerPosition, random);
  if (spacedConfirmation !== null) {
    return {
      cardId: spacedConfirmation.cardId,
      reason: "spaced_confirmation",
      correctCooldownUntilPosition: spacedConfirmation.correctCooldownUntilPosition,
    };
  }

  const ordinary = chooseActiveCard(cards, schedulerPosition, random);
  if (ordinary !== null) {
    return {
      cardId: ordinary.cardId,
      reason: "active_weighted_selection",
      weight: ordinary.weight,
      candidateCount: ordinary.candidateCount,
    };
  }

  return null;
}
