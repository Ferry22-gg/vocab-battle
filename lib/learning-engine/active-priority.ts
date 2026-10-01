/**
 * Learning Engine v1 -- Active card priority: normal-Correct cooldown
 * eligibility, stage weights, and the aging multiplier (Phase 3 of the
 * implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections
 * 11.1 (Correct cooldown), 19 (Active card priority), 19.1 (aging
 * multiplier), 22.3 (Active starvation -- counter maintenance only; the
 * 40-draw guarantee itself is Phase 6).
 *
 * Pure and deterministic throughout: no database access, no clock reads,
 * no RNG, no mutation of input.
 *
 * ---------------------------------------------------------------------
 * Why no separate "reset active_draws_since_eligible when cooldown
 * clears" function
 * ---------------------------------------------------------------------
 * The only way a card acquires a non-null correctCooldownUntilPosition is
 * by being answered Correct on a normal (non-repair) within-day
 * retrieval -- which requires it to have just been the selected card on
 * that very draw. advanceActiveDrawCounters already resets a selected
 * card's counter to 0 on that same draw, and this module never advances
 * the counter for a card that isEligibleForNormalSelection reports
 * ineligible (i.e. while its cooldown is in force) -- so the counter sits
 * frozen at 0 for the card's entire cooldown window and is already
 * exactly right the moment the cooldown clears and the card becomes a
 * selection candidate again. No second write path is needed to keep
 * "survived N draws since becoming eligible" correct across a cooldown
 * cycle.
 */

import { AGING_MULTIPLIER_BUCKETS, CORRECT_MIN_GAP, STAGE_BASE_WEIGHT } from "@/lib/learning-engine/config";

// =============================================================================
// Section 11.1: normal-Correct cooldown
// =============================================================================

export interface CooldownCardState {
  readonly correctCooldownUntilPosition: number | null;
}

/**
 * Section 11.1: "After a normal stage-advancing Correct: card is
 * ineligible for the next 5 intervening cards." `position` is an opaque,
 * caller-owned monotonic counter (one per Active-source draw, or
 * whichever unit the future scheduler uses consistently) -- this module
 * has no opinion on what it represents beyond "larger means later",
 * matching the position fields' own storage-only treatment in
 * supabase/migrations/20261001000000_learning_engine_v1_additive_schema.sql.
 *
 * `correctCooldownUntilPosition` is, per its own name, the first position
 * the card is ELIGIBLE again -- "ineligible until [this] position" -- not
 * the last position it is still blocked at. If the Correct happens at
 * position N, the 5 intervening cards occupy positions N+1..N+5, so the
 * earliest legal reappearance is N+6: `position + CORRECT_MIN_GAP + 1`,
 * not `position + CORRECT_MIN_GAP` (which would make N+5 itself eligible,
 * leaving only 4 intervening cards blocked -- an off-by-one caught in
 * review; see this function's and isEligibleForNormalSelection's tests in
 * tests/unit/learning-engine-active-priority.test.ts for the exact N+1
 * through N+6 boundary this fixes).
 */
export function applyCorrectCooldown(position: number): number {
  return position + CORRECT_MIN_GAP + 1;
}

/**
 * True once `currentPosition` has reached (or passed) the stored
 * cooldown target, or immediately if no cooldown is in force. "Not
 * guaranteed to appear immediately on card 6. It returns to weighted
 * selection" (section 11.1) -- this function only answers the gating
 * question (is the card a candidate at all); computeActiveWeight decides
 * how likely it is to actually be picked once eligible.
 */
export function isEligibleForNormalSelection(card: CooldownCardState, currentPosition: number): boolean {
  return card.correctCooldownUntilPosition === null || currentPosition >= card.correctCooldownUntilPosition;
}

// =============================================================================
// Section 19/19.1: stage weight and aging multiplier
// =============================================================================

export type ActiveEligibleStage = "FRESH" | "LEARNING_1" | "LEARNING_2";

/** Section 19: base weight before the aging multiplier. FRESH=1.00, LEARNING_1=1.20, LEARNING_2=1.10 -- not monotonic by design (the spec weights LEARNING_1 above both its neighbors). */
export function stageBaseWeight(stage: ActiveEligibleStage): number {
  return STAGE_BASE_WEIGHT[stage];
}

/**
 * Section 19.1: the soft aging multiplier for however many Active-source
 * selections this card has survived since it last became eligible
 * (see advanceActiveDrawCounters). Buckets are inclusive of their
 * `minDraws` floor; AGING_MULTIPLIER_BUCKETS is ordered ascending, so the
 * last bucket whose floor `draws` meets or exceeds applies (20+ draws all
 * share the final 1.40 bucket -- there is no upper bound).
 */
export function agingMultiplier(activeDrawsSinceEligible: number): number {
  let multiplier: number = AGING_MULTIPLIER_BUCKETS[0].multiplier;
  for (const bucket of AGING_MULTIPLIER_BUCKETS) {
    if (activeDrawsSinceEligible >= bucket.minDraws) {
      multiplier = bucket.multiplier;
    }
  }
  return multiplier;
}

export interface ActivePriorityCardState {
  readonly learningStage: ActiveEligibleStage;
  readonly activeDrawsSinceEligible: number;
}

/**
 * Section 19: `active_weight = stage_base_weight * aging_multiplier`.
 * "Only normally eligible Active cards participate" -- this function
 * does not itself check isEligibleForNormalSelection; the caller must
 * only invoke it for cards already known to be eligible (and FRESH/
 * LEARNING_1/LEARNING_2 -- never NEW-unpresented, which has no
 * learningStage yet and belongs to buildFirstPassOrder instead, and
 * never FORGOTTEN, which has no learningStage at all and is Phase 4's
 * repair scheduler's responsibility, not ordinary stage-weighted
 * selection).
 */
export function computeActiveWeight(card: ActivePriorityCardState): number {
  return stageBaseWeight(card.learningStage) * agingMultiplier(card.activeDrawsSinceEligible);
}

// =============================================================================
// Section 19.1/22.3: active_draws_since_eligible bookkeeping
// =============================================================================

export interface ActiveDrawCounterCard {
  readonly cardId: string;
  readonly activeDrawsSinceEligible: number;
  /** Whether this card is currently a normal-selection candidate (isEligibleForNormalSelection) -- the caller computes this per card before calling, since it depends on the current position, which this function does not take. */
  readonly eligible: boolean;
}

/**
 * Advances active_draws_since_eligible for one Active-source draw: the
 * selected card's counter resets to 0 (it survived 0 further draws, as
 * of right now); every OTHER currently-eligible card's counter
 * increments by 1 (it survived one more draw without being selected);
 * every currently-ineligible (on-cooldown) card is left untouched -- see
 * this module's header comment for why that alone keeps the counter
 * correct across a full cooldown cycle with no separate reset step.
 *
 * Returns a cardId -> new-counter-value map for every card in `cards`
 * (including unchanged ineligible ones, so a caller can apply this
 * uniformly without special-casing).
 */
export function advanceActiveDrawCounters(
  cards: readonly ActiveDrawCounterCard[],
  selectedCardId: string,
): ReadonlyMap<string, number> {
  const next = new Map<string, number>();

  for (const card of cards) {
    if (card.cardId === selectedCardId) {
      next.set(card.cardId, 0);
    } else if (card.eligible) {
      next.set(card.cardId, card.activeDrawsSinceEligible + 1);
    } else {
      next.set(card.cardId, card.activeDrawsSinceEligible);
    }
  }

  return next;
}
