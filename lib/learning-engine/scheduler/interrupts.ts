/**
 * Learning Engine v1 -- GLOBAL interrupt layer (Phase 6D of the
 * implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections
 * 22.1 (repair hard cap), 22.2 (Critical Due), 23/24 (pipeline order: Gate
 * 1 repair hard cap, Gate 2 Critical Due, Gate 3 ordinary source
 * selection), 34.2 (scheduling invariants).
 *
 * Reuses, never duplicates: Phase 4's findMandatoryRepairInterrupt
 * (lib/learning-engine/repair-scheduler.ts) for Gate 1; Phase 6A's
 * hasCriticalDueAppearedRecently (lib/learning-engine/scheduler/
 * position.ts) for the 5-global-question gap; Phase 6C's
 * selectDueCandidates (lib/learning-engine/scheduler/due-selection.ts) and
 * Phase 5's computeDueWeight (lib/learning-engine/fsrs/priority.ts) for
 * Critical Due's own candidate set and weighting ("use the normal Due
 * weighting formula... do not invent a separate Critical Due weight
 * formula").
 *
 * Pure and deterministic throughout: no database access, no hidden
 * Math.random() call -- the only randomness is the injected RandomSource,
 * consumed only for an exact tie-break (Gate 1) or the weighted draw
 * within the Critical Due candidate set (Gate 2).
 *
 * ---------------------------------------------------------------------
 * Typed global interrupt boundary (Phase 6D brief section 13)
 * ---------------------------------------------------------------------
 * `GlobalInterruptResult` below is deliberately a closed union of exactly
 * the two GLOBAL interrupts (repair hard cap, Critical Due) plus `null`.
 * Active starvation (lib/learning-engine/scheduler/
 * active-internal-selection.ts) is NOT a member of this union and cannot
 * be expressed as one -- it is not a global interrupt, never forces the
 * top-level source to become ACTIVE, and only ever applies once ordinary
 * source selection (a later phase) has already chosen ACTIVE on its own.
 * Keeping it a structurally separate type (rather than, say, a third
 * union member with a different `source`/`reason` shape) is what makes
 * "active_starvation globally forces ACTIVE" difficult to express through
 * this module's own API, per the brief's explicit ask.
 */

import { CRITICAL_DUE_R_THRESHOLD } from "@/lib/learning-engine/config";
import { hasCriticalDueAppearedRecently } from "@/lib/learning-engine/scheduler/position";
import { selectDueCandidates } from "@/lib/learning-engine/scheduler/due-selection";
import { computeDueWeight } from "@/lib/learning-engine/fsrs/priority";
import { findMandatoryRepairInterrupt } from "@/lib/learning-engine/repair-scheduler";
import { weightedRandomChoice, type RandomSource } from "@/lib/learning-engine/scheduler/weighted-random";
import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

export type { RandomSource };

// =============================================================================
// Section 13 of the Phase 6D brief: the typed GLOBAL interrupt boundary
// =============================================================================

/** Gate 1 (section 22.1): a repair whose hard cap has been reached forces the next GLOBAL question. */
export interface GlobalRepairHardCapInterrupt {
  readonly cardId: string;
  readonly source: "ACTIVE";
  readonly reason: "repair_hard_cap";
}

/** Gate 2 (section 22.2): at least one eligible FSRS_DUE card has fallen to or below the Critical Due Retrievability threshold, and none has been presented recently enough to defer it. */
export interface GlobalCriticalDueInterrupt {
  readonly cardId: string;
  readonly source: "FSRS_DUE";
  readonly reason: "critical_due_interrupt";
  /** Exposed for a future decision trace -- this module does not persist it itself. */
  readonly retrievability: number;
}

/**
 * The only two GLOBAL interrupts in v1, or `null` if neither fires this
 * draw (ordinary source selection, a later phase, then proceeds
 * unimpeded). Deliberately closed -- see this module's header for why
 * Active starvation can never be a member.
 */
export type GlobalInterruptResult = GlobalRepairHardCapInterrupt | GlobalCriticalDueInterrupt | null;

// =============================================================================
// Gate 1 (section 22.1/35.2): repair hard cap
// =============================================================================

/**
 * Section 22.1: "a repair target may never be delayed beyond 6 intervening
 * cards." Extracts every pending repair obligation from `cards` (Phase 4's
 * RepairObligation, carried on SchedulableCardRow.repairObligation -- see
 * lib/learning-engine/scheduler/snapshot.ts) and delegates priority/
 * tie-break entirely to Phase 4's findMandatoryRepairInterrupt (oldest
 * Wrong / earliest hard cap wins, injected RNG only for an exact tie) --
 * not reimplemented here. Returns `null` when no repair's hard cap has
 * been reached yet, never when obligations merely exist.
 */
export function findRepairHardCapInterrupt(
  cards: readonly SchedulableCardRow[],
  schedulerPosition: number,
  random: RandomSource,
): GlobalRepairHardCapInterrupt | null {
  const obligations = cards
    .map((card) => card.repairObligation)
    .filter((obligation): obligation is NonNullable<typeof obligation> => obligation !== null);

  const winner = findMandatoryRepairInterrupt(obligations, schedulerPosition, random);
  if (winner === null) {
    return null;
  }

  return { cardId: winner.cardId, source: "ACTIVE", reason: "repair_hard_cap" };
}

// =============================================================================
// Gate 2 (section 22.2): Critical Due
// =============================================================================

/**
 * Section 22.2/7's exact policy boundary, extracted as its own pure
 * predicate so the `R <= 0.60` comparison itself is directly unit-testable
 * at exact floating-point boundaries (0.599999 / 0.600000 / 0.600001),
 * independent of real FSRS timing ever landing exactly on the threshold.
 * `findCriticalDueInterrupt` below is the only caller; it does not inline
 * this comparison itself.
 */
export function isCriticalDue(retrievability: number): boolean {
  return retrievability <= CRITICAL_DUE_R_THRESHOLD;
}

export interface CriticalDueInterruptInput {
  readonly cards: readonly SchedulableCardRow[];
  readonly now: Date;
  readonly desiredRetention: number;
  readonly schedulerPosition: number;
  /** DeckSchedulerState.lastCriticalDuePosition -- null if no Critical Due has ever been force-selected for this deck. */
  readonly lastCriticalDuePosition: number | null;
  readonly random: RandomSource;
}

/**
 * Section 22.2: "Critical Due definition: R <= 0.60. If at least one
 * Critical Due card exists and no Critical Due card has been presented in
 * the last 5 global questions, force one Critical Due card. Within the
 * critical set, use the normal Due weight formula."
 *
 * Only eligible FSRS_DUE candidates may enter the Critical Due set (Phase
 * 6D brief section 5) -- reuses Phase 6C's selectDueCandidates verbatim
 * (which already restricts to poolStatus OUTSIDE, excludes
 * repair/relearning-governed cards, and classifies FSRS_DUE via Phase 5's
 * due-classification), then narrows to `retrievability <= CRITICAL_DUE_R_
 * THRESHOLD`. Weighting within that narrowed set is Phase 5's
 * computeDueWeight, unchanged -- "do not invent a separate Critical Due
 * weight formula" (Phase 6D brief section 7).
 *
 * This function does NOT itself check whether a repair hard-cap interrupt
 * already won this draw (Phase 6D brief section 5's third condition) --
 * that ordering is findGlobalInterrupt's job, below; this function is
 * exported standalone so a caller/test can exercise Critical Due
 * selection in isolation without needing to also construct a repair-free
 * card set.
 */
export function findCriticalDueInterrupt(input: CriticalDueInterruptInput): GlobalCriticalDueInterrupt | null {
  if (hasCriticalDueAppearedRecently(input.schedulerPosition, input.lastCriticalDuePosition)) {
    return null;
  }

  const dueCandidates = selectDueCandidates(input.cards, input.now);
  const criticalCandidates = dueCandidates.filter((candidate) => isCriticalDue(candidate.retrievability));
  if (criticalCandidates.length === 0) {
    return null;
  }

  const weighted = criticalCandidates.map((candidate) => ({
    item: candidate,
    weight: computeDueWeight(candidate.retrievability, input.desiredRetention),
  }));

  const winner = weightedRandomChoice(weighted, input.random);
  return {
    cardId: winner.card.cardId,
    source: "FSRS_DUE",
    reason: "critical_due_interrupt",
    retrievability: winner.retrievability,
  };
}

// =============================================================================
// Section 3/23/24 of the Phase 6D brief: the composed GLOBAL interrupt gate
// =============================================================================

export interface GlobalInterruptInput {
  readonly cards: readonly SchedulableCardRow[];
  readonly schedulerPosition: number;
  readonly now: Date;
  readonly desiredRetention: number;
  readonly lastCriticalDuePosition: number | null;
  readonly random: RandomSource;
}

/**
 * The full GLOBAL interrupt gate, in the spec's own fixed priority order:
 * "1. Repair hard cap, 2. Critical Due, 3. ordinary source selection"
 * (section 3 of the Phase 6D brief; sections 23/24 of the spec). Returns
 * as soon as Gate 1 fires, WITHOUT evaluating Gate 2 at all -- "no Repair
 * hard-cap interrupt already won" (section 5) is enforced structurally by
 * this short-circuit, not by threading extra state into
 * findCriticalDueInterrupt. `null` means neither gate fired; a later
 * phase's ordinary source selection should proceed unimpeded.
 */
export function findGlobalInterrupt(input: GlobalInterruptInput): GlobalInterruptResult {
  const repairInterrupt = findRepairHardCapInterrupt(input.cards, input.schedulerPosition, input.random);
  if (repairInterrupt !== null) {
    return repairInterrupt;
  }

  return findCriticalDueInterrupt({
    cards: input.cards,
    now: input.now,
    desiredRetention: input.desiredRetention,
    schedulerPosition: input.schedulerPosition,
    lastCriticalDuePosition: input.lastCriticalDuePosition,
    random: input.random,
  });
}
