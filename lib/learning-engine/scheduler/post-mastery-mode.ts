/**
 * Learning Engine v1 -- Post-Mastery mode predicate and the historical
 * Full-Mastery unlock rule (Phase 7 of the implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections
 * 25.1 ("persistent deck unlock") and 25.5 ("new cards added after Full
 * Mastery"), as sharpened by the Phase 7 brief's sections 2-6.
 *
 * Two deliberately SEPARATE concepts, never collapsed into one:
 *
 *   1. `computeHasAchievedFullMastery` -- the HISTORICAL, monotonic,
 *      deck-level unlock event ("has this deck ever reached
 *      mastered_count === total_cards"). Once true, always true. This is
 *      the Phase 1 schema's own `user_deck_learning_state.
 *      has_achieved_full_mastery` column (supabase/migrations/
 *      20261001000000_learning_engine_v1_additive_schema.sql) -- a future
 *      trusted commit path is the only thing that ever WRITES this value;
 *      this function only computes what the NEXT value should be, given
 *      the CURRENT value and the current mastered/total counts.
 *
 *   2. `shouldUsePostMasteryMode` -- the CURRENT scheduler-mode decision,
 *      re-evaluated on every single chooseNextCard() draw. This does NOT
 *      require `mastered_count === total_cards` right now -- only that
 *      the deck has HISTORICALLY unlocked (#1) AND no card currently
 *      requires ordinary within-day Active acquisition (section 4-5 of
 *      the Phase 7 brief). A newly-added batch of cards can freely be
 *      ACQUIRED-but-not-yet-LEARNED while the deck is already back in
 *      Post-Mastery mode (section 5's "500 Mastered + 20 ACQUIRED -> POST
 *      MASTERY, do not wait for 520/520").
 *
 * This predicate deliberately TRUSTS `hasAchievedFullMastery` as given --
 * it never re-derives or infers that flag from the current card
 * composition itself (Phase 7 brief section 19's "unlock = false, 500/500
 * current Mastered somehow -> follow historical unlock semantics / do not
 * infer silently if impossible"). Flipping that flag from false to true is
 * exclusively `computeHasAchievedFullMastery`'s job, called by whichever
 * future trusted commit path actually detects the unlock event -- not this
 * module, and not chooseNextCard() itself.
 */

import type { CardStatus } from "@/lib/learning-engine/state";

// =============================================================================
// Section 3 of the Phase 7 brief: the historical Full-Mastery unlock
// =============================================================================

export interface ComputeHasAchievedFullMasteryInput {
  /** The deck's CURRENT persisted `has_achieved_full_mastery` value, before this check. */
  readonly currentlyUnlocked: boolean;
  readonly masteredCount: number;
  readonly totalCards: number;
}

/**
 * Section 3: "if mastered_count == total_cards then has_achieved_full_
 * mastery = true. Once true: true -> always true." Monotonic by
 * construction -- `currentlyUnlocked` short-circuits to `true` before any
 * count comparison runs, so a later drop in `masteredCount` (a lapse) or
 * rise in `totalCards` (new cards added) can never flip this back to
 * `false` through this function. `totalCards <= 0` is treated as "not yet
 * unlocked" (an empty deck trivially satisfies `masteredCount ===
 * totalCards === 0` but has demonstrated no actual mastery evidence) --
 * defensive, not a spec-stated case.
 */
export function computeHasAchievedFullMastery(input: ComputeHasAchievedFullMasteryInput): boolean {
  if (input.currentlyUnlocked) {
    return true;
  }
  if (input.totalCards <= 0) {
    return false;
  }
  return input.masteredCount >= input.totalCards;
}

// =============================================================================
// Sections 4-6 of the Phase 7 brief: the current-mode predicate
// =============================================================================

/** The minimal per-card shape this predicate needs. */
export interface ModeDecisionCard {
  readonly cardStatus: CardStatus;
}

/**
 * Section 5: "ordinary Active acquisition work" is exactly a card still
 * progressing through first-time within-day acquisition -- NEW (whether
 * already admitted to Active or still awaiting admission in the reservoir
 * -- both count as "requiring / awaiting Active acquisition") or LEARNING
 * (any stage: FRESH/LEARNING_1/LEARNING_2, section 5's explicit list).
 *
 * Deliberately EXCLUDES:
 *   - ACQUIRED/LEARNED: section 5's "VERY IMPORTANT: ACQUIRED cards do NOT
 *     block return to Post-Mastery mode... they continue their long-term
 *     progression through FSRS_DUE/NEAR_DUE while the deck is already back
 *     in Post-Mastery mode."
 *   - FORGOTTEN: section 6's "local relearning is not new acquisition" --
 *     a lapsed previously-mastered card lapsing into FORGOTTEN/Relearning
 *     must never be mistaken for a newly-added card needing ordinary
 *     acquisition, or the historical unlock's whole point (Post-Mastery
 *     mode surviving routine lapses) would break.
 */
export function hasOrdinaryActiveAcquisitionWork(cards: readonly ModeDecisionCard[]): boolean {
  return cards.some((card) => card.cardStatus === "NEW" || card.cardStatus === "LEARNING");
}

export interface ShouldUsePostMasteryModeInput {
  /** The deck's current persisted `has_achieved_full_mastery` -- trusted as given, never re-derived here (see this module's header). */
  readonly hasAchievedFullMastery: boolean;
  readonly cards: readonly ModeDecisionCard[];
}

/**
 * Section 4: "After a deck has historically unlocked Full Mastery,
 * Post-Mastery mode may operate whenever there is NO card requiring
 * ordinary Active acquisition. It does NOT require all cards to currently
 * be Mastered." The exact truth table (section 4):
 *
 *   hasAchievedFullMastery=true  AND acquisition work exists     -> false (ORDINARY)
 *   hasAchievedFullMastery=true  AND no acquisition work         -> true  (POST_MASTERY)
 *   hasAchievedFullMastery=false (any card composition)          -> false (ORDINARY)
 */
export function shouldUsePostMasteryMode(input: ShouldUsePostMasteryModeInput): boolean {
  if (!input.hasAchievedFullMastery) {
    return false;
  }
  return !hasOrdinaryActiveAcquisitionWork(input.cards);
}
