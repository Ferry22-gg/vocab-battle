/**
 * Learning Engine v1 -- generic weighted-random selection primitive
 * (Phase 6A of the implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 17
 * ("Then sample using weighted random: P(i) = w(i) / sum(w)") -- the same
 * formula underlies source selection, Active/Due/Near-Due card selection,
 * and the Critical Due set, so this is the one shared implementation all
 * of Phase 6C/6D's per-source selectors compose rather than each
 * reimplementing their own sampling loop.
 *
 * Pure: the only randomness is the injected `RandomSource` (re-exported
 * from lib/learning-engine/active-pool.ts, the same contract used
 * throughout this engine) -- no module under lib/learning-engine/
 * scheduler/ calls Math.random() directly, anywhere.
 */

import type { RandomSource } from "@/lib/learning-engine/active-pool";

export type { RandomSource };

export interface WeightedCandidate<T> {
  readonly item: T;
  readonly weight: number;
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`weightedRandomChoice: ${message}`);
  }
}

/**
 * Samples one item from `candidates` with probability proportional to
 * its weight (`P(i) = w(i) / sum(w)`). Requires at least one candidate
 * with a positive total weight -- an empty or all-zero-weight candidate
 * list is a caller error (e.g. failing to remove an empty source first,
 * lib/learning-engine/scheduler/renormalize.ts's job), not a case this
 * function silently papers over by guessing.
 *
 * Implementation: a single cumulative-weight scan, consuming exactly one
 * `random()` call -- deterministic and fully reproducible given the same
 * candidates (in the same order) and the same RandomSource sequence
 * (section 24: "seeded reproducibility").
 */
export function weightedRandomChoice<T>(candidates: readonly WeightedCandidate<T>[], random: RandomSource): T {
  invariant(candidates.length > 0, "requires at least one candidate");

  const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  invariant(totalWeight > 0, "requires a positive total weight (did you forget to remove empty sources first?)");

  let roll = random() * totalWeight;
  for (const candidate of candidates) {
    roll -= candidate.weight;
    if (roll < 0) {
      return candidate.item;
    }
  }

  // Floating-point fallback only: a `random()` draw arbitrarily close to
  // 1 combined with cumulative subtraction error could in principle leave
  // `roll` not-quite-negative after the last candidate. Returning the
  // last candidate here (rather than throwing) is correct, not a guess --
  // it is exactly where the cumulative scan was heading.
  return candidates[candidates.length - 1].item;
}
