/**
 * Learning Engine v1 -- RANDOM_MASTERED source: strong-Mastered
 * eligibility and the deterministic shuffle bag (Phase 7 of the
 * implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections
 * 25.3 ("Post-Mastery source set") and 25.4 ("Random Mastered sampling"),
 * as sharpened by Phase 7 brief sections 12-15.
 *
 * Reuses, never duplicates: Phase 4's isGovernedByRepairObligation
 * (lib/learning-engine/repair-scheduler.ts); Phase 5's
 * deriveCardIntervalProgress/classifyDueSource (lib/learning-engine/fsrs/
 * due-classification.ts); Phase 3's buildFirstPassOrder (lib/learning-
 * engine/active-pool.ts) for the shuffle algorithm itself -- the exact
 * same Fisher-Yates shuffle the first-pass queue already uses, not a
 * second shuffle implementation.
 */

import { isGovernedByRepairObligation } from "@/lib/learning-engine/repair-scheduler";
import { classifyDueSource, deriveCardIntervalProgress } from "@/lib/learning-engine/fsrs/due-classification";
import { buildFirstPassOrder, type RandomSource } from "@/lib/learning-engine/active-pool";
import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

export type { RandomSource };

// =============================================================================
// Phase 7 brief section 12: strong-Mastered eligibility
// =============================================================================

/**
 * Phase 7 brief section 12's exact filter:
 *   LEARNED (Mastered)
 *   AND has_ever_been_mastered = true (redundant with LEARNED under
 *     invariant 34.1 -- "LEARNED implies has_ever_been_mastered" -- kept
 *     as defense-in-depth, not a second independent condition)
 *   AND poolStatus OUTSIDE
 *   AND interval_progress < 0.75 (STRONG_OUTSIDE, i.e. not Near-Due/Due)
 *   AND not Relearning (not repair/relearning-governed)
 *
 * "not Due" and "not Near-Due" are both exactly "classifyDueSource ===
 * STRONG_OUTSIDE" (lib/learning-engine/fsrs/due-classification.ts's own
 * three-way classification is already exhaustive and mutually exclusive --
 * there is no fourth state to separately check). A LEARNED card can never
 * actually carry a non-null relearningPhase under the engine's own
 * invariants (a long-term Wrong immediately flips cardStatus to FORGOTTEN,
 * never leaving it LEARNED), so isGovernedByRepairObligation is
 * unreachable-but-defensive here, the same posture every other Phase 6
 * selector already takes toward impossible-but-cheap-to-guard states.
 *
 * ACQUIRED-but-not-yet-Mastered cards are excluded by the `cardStatus !==
 * "LEARNED"` check alone -- they never enter RANDOM_MASTERED; they
 * continue participating only through their own legitimate Due/Near-Due
 * eligibility (Phase 7 brief section 12: "ACQUIRED-but-not-Mastered cards
 * must NOT participate in RANDOM_MASTERED").
 */
function isStrongMasteredCandidate(card: SchedulableCardRow, now: Date): boolean {
  if (card.cardStatus !== "LEARNED") {
    return false;
  }
  if (!card.hasEverBeenMastered) {
    return false;
  }
  if (card.poolStatus !== "OUTSIDE") {
    return false;
  }
  if (isGovernedByRepairObligation(card)) {
    return false;
  }
  const intervalProgress = deriveCardIntervalProgress(card.fsrsCard, now);
  return classifyDueSource(intervalProgress) === "STRONG_OUTSIDE";
}

export function selectStrongMasteredCandidateIds(cards: readonly SchedulableCardRow[], now: Date): readonly string[] {
  const ids: string[] = [];
  for (const card of cards) {
    if (isStrongMasteredCandidate(card, now)) {
      ids.push(card.cardId);
    }
  }
  return ids;
}

// =============================================================================
// Phase 7 brief sections 13-15: the deterministic shuffle bag
// =============================================================================

export interface ShuffleBagDrawResult {
  readonly cardId: string | null;
  readonly bagAfter: readonly string[] | null;
}

/**
 * Phase 7 brief section 15 (bag reconciliation): strips any bag entry
 * that is no longer in the current eligible set (a card that lapsed,
 * became Due/Near-Due, etc. since the bag was last built) and any
 * duplicate id, while preserving the remaining entries' relative order --
 * "preserve still-valid remaining entries... never duplicate IDs."
 * Deliberately does NOT insert newly-eligible ids that are not already in
 * `bag` -- a shuffle bag's whole contract is "this round's fixed, already-
 * shuffled draw order"; a card that becomes eligible mid-cycle joins only
 * on the NEXT rebuild (when the bag next empties), exactly mirroring how a
 * physical shuffled deck is not re-shuffled mid-hand to insert a new card.
 * This is this review's own interpretation of an otherwise-unspecified
 * case (section 15 lists only removal rules, never insertion), analogous
 * to the first-pass queue's "next batch" interpretation from the Phase 6E
 * clarification -- flagged in the Phase 7 report rather than treated as
 * the only possible reading.
 */
export function reconcileShuffleBag(bag: readonly string[] | null, eligibleIds: readonly string[]): readonly string[] {
  if (bag === null) {
    return [];
  }
  const eligibleSet = new Set(eligibleIds);
  const seen = new Set<string>();
  const reconciled: string[] = [];
  for (const id of bag) {
    if (eligibleSet.has(id) && !seen.has(id)) {
      reconciled.push(id);
      seen.add(id);
    }
  }
  return reconciled;
}

/**
 * Phase 7 brief section 13: "gather current eligible strong Mastered IDs;
 * shuffle using injected RandomSource; consume without replacement;
 * preserve remaining bag state across decisions; when exhausted, rebuild/
 * reshuffle using the then-current eligible set." One draw = reconcile the
 * existing bag against `eligibleIds` (section 15), then:
 *   - if anything valid remains, consume its FRONT entry (the bag is
 *     already in shuffled order from when it was built -- no re-shuffle on
 *     every draw, only on rebuild) -- this is what "without replacement
 *     until exhaustion" and "broad coverage before reshuffle" both reduce
 *     to;
 *   - otherwise (bag was empty, fully stale, or never existed) rebuild a
 *     fresh shuffle from `eligibleIds` via Phase 3's buildFirstPassOrder,
 *     unchanged, and consume its front entry the same way.
 * Returns `{ cardId: null, bagAfter: null }` only when `eligibleIds` is
 * itself empty -- never throws (Phase 6C's "prefer null" convention,
 * carried into Phase 7).
 */
export function drawFromShuffleBag(
  bag: readonly string[] | null,
  eligibleIds: readonly string[],
  random: RandomSource,
): ShuffleBagDrawResult {
  const reconciled = reconcileShuffleBag(bag, eligibleIds);

  if (reconciled.length > 0) {
    const [drawn, ...rest] = reconciled;
    return { cardId: drawn, bagAfter: rest.length > 0 ? rest : null };
  }

  if (eligibleIds.length === 0) {
    return { cardId: null, bagAfter: null };
  }

  const shuffled = buildFirstPassOrder(eligibleIds, random);
  const [drawn, ...rest] = shuffled;
  return { cardId: drawn, bagAfter: rest.length > 0 ? rest : null };
}

// =============================================================================
// Composition: the RANDOM_MASTERED source selector Phase 7's scheduler
// orchestration calls
// =============================================================================

export interface RandomMasteredSelectionResult {
  readonly cardId: string;
  readonly bagAfter: readonly string[] | null;
}

/**
 * The full RANDOM_MASTERED draw: current eligibility (section 12) feeding
 * the shuffle bag (sections 13-15). `null` only when no strong-Mastered
 * candidate currently exists at all.
 */
export function chooseRandomMasteredCard(
  cards: readonly SchedulableCardRow[],
  now: Date,
  bag: readonly string[] | null,
  random: RandomSource,
): RandomMasteredSelectionResult | null {
  const eligibleIds = selectStrongMasteredCandidateIds(cards, now);
  const draw = drawFromShuffleBag(bag, eligibleIds, random);
  if (draw.cardId === null) {
    return null;
  }
  return { cardId: draw.cardId, bagAfter: draw.bagAfter };
}
