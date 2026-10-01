/**
 * Learning Engine v1 -- NEAR_DUE source candidate selection (Phase 6C of
 * the implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 18
 * ("Near-Due card priority").
 *
 * Reuses, never duplicates: Phase 5's classifyDueSource/
 * deriveCardIntervalProgress (lib/learning-engine/fsrs/
 * due-classification.ts) and computeNearDueWeight (lib/learning-engine/
 * fsrs/priority.ts); Phase 4's isGovernedByRepairObligation
 * (lib/learning-engine/repair-scheduler.ts). "R must still be logged but
 * is not multiplied into Near-Due priority in v1" (section 18) -- no
 * retrievability call appears anywhere in this module, unlike
 * due-selection.ts.
 */

import { classifyDueSource, deriveCardIntervalProgress } from "@/lib/learning-engine/fsrs/due-classification";
import { computeNearDueWeight } from "@/lib/learning-engine/fsrs/priority";
import { isGovernedByRepairObligation } from "@/lib/learning-engine/repair-scheduler";
import { weightedRandomChoice, type RandomSource } from "@/lib/learning-engine/scheduler/weighted-random";
import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

export interface NearDueCandidate {
  readonly card: SchedulableCardRow;
  readonly intervalProgress: number;
}

function toNearDueCandidate(card: SchedulableCardRow, now: Date): NearDueCandidate | null {
  if (card.poolStatus !== "OUTSIDE") {
    return null;
  }
  if (isGovernedByRepairObligation(card)) {
    return null;
  }
  const intervalProgress = deriveCardIntervalProgress(card.fsrsCard, now);
  // Narrowed explicitly (rather than passing the possibly-null value
  // straight into classifyDueSource the way due-selection.ts does) so
  // the stored `intervalProgress` field below can be a plain `number`,
  // not `number | null` -- computeNearDueWeight requires a real number.
  if (intervalProgress === null) {
    return null;
  }
  if (classifyDueSource(intervalProgress) !== "NEAR_DUE") {
    return null;
  }
  return { card, intervalProgress };
}

export function selectNearDueCandidates(cards: readonly SchedulableCardRow[], now: Date): readonly NearDueCandidate[] {
  const candidates: NearDueCandidate[] = [];
  for (const card of cards) {
    const candidate = toNearDueCandidate(card, now);
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

export interface NearDueSelectionResult {
  readonly cardId: string;
  readonly weight: number;
  /** Exposed for Phase 6E's decision-trace construction -- this module does not persist it itself. */
  readonly intervalProgress: number;
  readonly candidateCount: number;
}

/**
 * Section 18: `w_near = 1 + 0.5 * (p - 0.75) / 0.25`, sampled via the
 * shared weighted-random primitive. `null` for a genuinely empty
 * candidate set, never a throw (Phase 6C brief section 9).
 */
export function chooseNearDueCard(
  cards: readonly SchedulableCardRow[],
  now: Date,
  random: RandomSource,
): NearDueSelectionResult | null {
  const candidates = selectNearDueCandidates(cards, now);
  if (candidates.length === 0) {
    return null;
  }

  const weighted = candidates.map((candidate) => {
    const weight = computeNearDueWeight(candidate.intervalProgress);
    return {
      item: { cardId: candidate.card.cardId, weight, intervalProgress: candidate.intervalProgress },
      weight,
    };
  });

  const winner = weightedRandomChoice(weighted, random);
  return { cardId: winner.cardId, weight: winner.weight, intervalProgress: winner.intervalProgress, candidateCount: candidates.length };
}
