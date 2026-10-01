/**
 * Learning Engine v1 -- FSRS_DUE source candidate selection (Phase 6C of
 * the implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 17
 * ("Due card priority").
 *
 * Reuses, never duplicates: Phase 5's deriveRetrievability
 * (lib/learning-engine/fsrs/adapter.ts), classifyDueSource/
 * deriveCardIntervalProgress (lib/learning-engine/fsrs/
 * due-classification.ts), and computeDueWeight (lib/learning-engine/
 * fsrs/priority.ts); Phase 4's isGovernedByRepairObligation
 * (lib/learning-engine/repair-scheduler.ts) to exclude repair/relearning
 * cards. "Do not multiply by days overdue" (section 17) -- no such
 * parameter exists anywhere in this module.
 */

import { classifyDueSource, deriveCardIntervalProgress } from "@/lib/learning-engine/fsrs/due-classification";
import { computeDueWeight } from "@/lib/learning-engine/fsrs/priority";
import { deriveRetrievability } from "@/lib/learning-engine/fsrs/adapter";
import { isGovernedByRepairObligation } from "@/lib/learning-engine/repair-scheduler";
import { weightedRandomChoice, type RandomSource } from "@/lib/learning-engine/scheduler/weighted-random";
import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

export interface DueCandidate {
  readonly card: SchedulableCardRow;
  readonly retrievability: number;
}

function toDueCandidate(card: SchedulableCardRow, now: Date): DueCandidate | null {
  // "belong to this user/deck": trivially true -- `cards` is already
  // scoped to one deck by the caller's snapshot, nothing to filter here.
  if (card.poolStatus !== "OUTSIDE") {
    return null;
  }
  if (isGovernedByRepairObligation(card)) {
    return null;
  }
  const intervalProgress = deriveCardIntervalProgress(card.fsrsCard, now);
  if (classifyDueSource(intervalProgress) !== "FSRS_DUE") {
    return null;
  }
  const retrievability = deriveRetrievability(card.fsrsCard, now);
  return { card, retrievability };
}

export function selectDueCandidates(cards: readonly SchedulableCardRow[], now: Date): readonly DueCandidate[] {
  const candidates: DueCandidate[] = [];
  for (const card of cards) {
    const candidate = toDueCandidate(card, now);
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

export interface DueSelectionResult {
  readonly cardId: string;
  readonly weight: number;
  /** Exposed for Phase 6E's decision-trace construction -- this module does not persist it itself. */
  readonly retrievability: number;
  readonly candidateCount: number;
}

/**
 * Section 17: `w_due(i) = min(3.0, sqrt((1 - R_i) / (1 - r_d)))`, sampled
 * via the shared weighted-random primitive. `null` for a genuinely empty
 * candidate set, never a throw (Phase 6C brief section 9).
 */
export function chooseDueCard(
  cards: readonly SchedulableCardRow[],
  now: Date,
  desiredRetention: number,
  random: RandomSource,
): DueSelectionResult | null {
  const candidates = selectDueCandidates(cards, now);
  if (candidates.length === 0) {
    return null;
  }

  const weighted = candidates.map((candidate) => {
    const weight = computeDueWeight(candidate.retrievability, desiredRetention);
    return {
      item: { cardId: candidate.card.cardId, weight, retrievability: candidate.retrievability },
      weight,
    };
  });

  const winner = weightedRandomChoice(weighted, random);
  return { cardId: winner.cardId, weight: winner.weight, retrievability: winner.retrievability, candidateCount: candidates.length };
}
