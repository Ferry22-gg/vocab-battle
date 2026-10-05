import "server-only";

/**
 * Learning Engine v1 -- Runtime Cutover RC-B corrective: claim-time
 * `active_draws_since_eligible` bookkeeping.
 *
 * ---------------------------------------------------------------------
 * Why this exists (pre-check B finding)
 * ---------------------------------------------------------------------
 * Spec clarification 9 (section 22.3) ties the counter's advance to a
 * SELECTION event: "increment by 1 only when ... an ACTIVE source slot
 * actually occurred... [and] a DIFFERENT card was selected" -- a fact true
 * the moment a decision is made, independent of whether that selection is
 * ever answered. The existing TEST-ONLY simulation harness
 * (tests/helpers/learning-engine-simulation.ts) already binds the advance
 * to exactly this moment: it calls advanceActiveDrawCounters()
 * unconditionally whenever `decision.source === "ACTIVE"`, BEFORE applying
 * the scripted answer outcome. RC-B's original claim transaction
 * (supabase/migrations/20261009000000_learning_engine_v1_runtime_cutover_rc_b_selection_claim.sql)
 * never persisted this -- a gap identified during RC-C's pre-check B and
 * closed here, forward-only, by
 * supabase/migrations/20261011000000_learning_engine_v1_runtime_cutover_rc_b_active_draw_counters.sql,
 * before the corrective migration date's own trusted RPC. RC-C's answer-
 * commit transaction must NOT touch this counter at all -- it is now
 * exclusively a claim-time concern.
 *
 * Concretely, this means: a successful ACTIVE-source claim persists the
 * counter update immediately. A later ANSWERED or ABANDONED outcome for
 * that same claim never revisits it -- including an abandoned claim, whose
 * selection genuinely occurred and therefore genuinely consumed one Active
 * opportunity for every other eligible card, regardless of whether an
 * answer ever followed. A lost-response retry that hits the OPEN-claim
 * fast path never recomputes or re-applies anything (no second
 * chooseNextCard() call happens on that path at all).
 *
 * ---------------------------------------------------------------------
 * Single source of truth -- no duplicated policy
 * ---------------------------------------------------------------------
 * This module reuses, unchanged:
 *   - lib/learning-engine/scheduler/active-selection.ts's
 *     selectOrdinaryActiveCandidates, for the exact "ordinary Active
 *     candidate" set (cooldown-clear, not repair/relearning-governed,
 *     FRESH/LEARNING_1/LEARNING_2 or a never-presented NEW+ACTIVE card);
 *   - lib/learning-engine/active-priority.ts's advanceActiveDrawCounters,
 *     for the exact reset-to-0/+1/frozen counter arithmetic (section
 *     19.1/22.3).
 * The only new logic here is bookkeeping: projecting this decision's own
 * `admittedCardIds` onto the pre-refill snapshot cards (an exact mirror of
 * next-card.ts's internal, non-exported computeVirtualActiveRefill's
 * poolStatus overlay -- reapplying an already-decided admission list, never
 * re-deciding one), so the candidate set this function scans is the same
 * post-refill view chooseNextCard() itself saw when it produced this
 * decision.
 *
 * ---------------------------------------------------------------------
 * Which decisions advance the counter
 * ---------------------------------------------------------------------
 * Exactly `decision.source === "ACTIVE"` -- the same condition the
 * simulation harness uses, verified against every SelectionReason that can
 * report it (lib/learning-engine/scheduler/next-card.ts,
 * lib/learning-engine/scheduler/interrupts.ts):
 *   ACTIVE source (advances):   active_first_pass, active_starvation,
 *     repair_target, spaced_confirmation, active_weighted_selection,
 *     emergency_cooldown_relaxation, repair_hard_cap (a GLOBAL interrupt,
 *     but still reports source "ACTIVE" -- interrupts.ts's
 *     GlobalRepairHardCapInterrupt), and the Post-Mastery relearning-
 *     servicing tier's own repair_target/spaced_confirmation (also
 *     reported with source "ACTIVE" -- next-card.ts's
 *     choosePostMasteryModeCard).
 *   NOT ACTIVE source (never advances): critical_due_interrupt (source
 *     "FSRS_DUE" -- interrupts.ts's GlobalCriticalDueInterrupt),
 *     due_weighted_selection ("FSRS_DUE"), near_due_weighted_selection
 *     ("NEAR_DUE"), random_mastered_shuffle_bag ("RANDOM_MASTERED"),
 *     no_card_all_unavailable (source null).
 *
 * Pure: no database access, no clock reads, no RNG, no mutation of input.
 */

import { advanceActiveDrawCounters, type ActiveDrawCounterCard } from "@/lib/learning-engine/active-priority";
import { selectOrdinaryActiveCandidates } from "@/lib/learning-engine/scheduler/active-selection";
import type { NextCardSource } from "@/lib/learning-engine/scheduler/next-card";
import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

export interface ActiveDrawCounterUpdate {
  readonly cardId: string;
  readonly before: number;
  readonly after: number;
}

export interface ComputeClaimTimeActiveDrawCounterUpdatesInput {
  /** The snapshot's own pre-refill cards (snapshot.cards) -- never the already-projected view, since this function performs that projection itself from `admittedCardIds`. */
  readonly cards: readonly SchedulableCardRow[];
  /** decision.admittedCardIds -- the NEW cards this SAME decision virtually admitted to ACTIVE. */
  readonly admittedCardIds: readonly string[];
  /** The scheduler_position this decision was computed against (snapshot.deckState.schedulerPosition) -- the same value chooseNextCard() used for isEligibleForNormalSelection/isGovernedByRepairObligation gating. */
  readonly schedulerPosition: number;
  /** decision.source. */
  readonly source: NextCardSource;
  /** decision.cardId. */
  readonly selectedCardId: string | null;
}

/**
 * Returns the claim-time `active_draws_since_eligible` deltas for one
 * decision, or an empty array when this decision's source is not
 * "ACTIVE" (see module header for the exact source/reason table) or it
 * selected no card at all. Every entry's `before` is the candidate's own
 * pre-decision value (as read from the snapshot), matching the trusted
 * claim RPC's own expected-before-value validation contract.
 */
export function computeClaimTimeActiveDrawCounterUpdates(
  input: ComputeClaimTimeActiveDrawCounterUpdatesInput,
): readonly ActiveDrawCounterUpdate[] {
  if (input.source !== "ACTIVE" || input.selectedCardId === null) {
    return [];
  }

  const admittedSet = new Set(input.admittedCardIds);
  const projectedCards = input.cards.map((card) =>
    admittedSet.has(card.cardId) ? { ...card, poolStatus: "ACTIVE" as const } : card,
  );

  const ordinaryCandidates = selectOrdinaryActiveCandidates(projectedCards, input.schedulerPosition);
  if (ordinaryCandidates.length === 0) {
    // A repair_hard_cap/repair_target/spaced_confirmation draw still
    // consumes an Active-source slot but may find zero ordinary
    // candidates (e.g. a lone card currently in relearning) -- correctly
    // nothing to age.
    return [];
  }

  const counterInputs: ActiveDrawCounterCard[] = ordinaryCandidates.map((candidate) => ({
    cardId: candidate.card.cardId,
    activeDrawsSinceEligible: candidate.card.activeDrawsSinceEligible,
    eligible: true,
  }));

  const updates = advanceActiveDrawCounters(counterInputs, input.selectedCardId);
  const beforeByCardId = new Map(ordinaryCandidates.map((candidate) => [candidate.card.cardId, candidate.card.activeDrawsSinceEligible]));

  const result: ActiveDrawCounterUpdate[] = [];
  for (const [cardId, after] of updates) {
    const before = beforeByCardId.get(cardId);
    if (before === undefined) {
      // Cannot happen: `updates`'s keys are exactly `counterInputs`'s
      // cardIds, which are exactly `beforeByCardId`'s keys.
      continue;
    }
    result.push({ cardId, before, after });
  }
  return result;
}
