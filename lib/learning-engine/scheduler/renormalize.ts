/**
 * Learning Engine v1 -- empty-source removal and renormalization (Phase
 * 6B of the implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 21
 * ("Empty-source renormalization"):
 *
 *   1. remove any source with zero eligible cards;
 *   2. renormalize remaining weights to sum to 1;
 *   3. sample from the normalized distribution.
 *
 * This module implements steps 1-2 only -- step 3 is
 * lib/learning-engine/scheduler/weighted-random.ts, fed by this
 * module's output. Pure: no eligibility determination happens here
 * either (that's each source-selector's job, Phase 6C/6D) -- this module
 * only takes a plain `available` boolean per source (computed by the
 * caller from "does this source currently have >=1 eligible candidate")
 * and does the weight-masking arithmetic.
 */

import type { SourceWeights } from "@/lib/learning-engine/scheduler/source-policy";

export interface SourceAvailability {
  readonly active: boolean;
  readonly due: boolean;
  readonly near: boolean;
}

const EMPTY_WEIGHTS: SourceWeights = { active: 0, due: 0, near: 0 };

/**
 * Section 21's worked example: nominal ACTIVE 0.90 / NEAR 0.10 with NEAR
 * empty renormalizes to ACTIVE 1.00. "Never attempt to draw from an
 * empty source" is enforced structurally here, not just documented: an
 * unavailable source's weight is unconditionally zeroed before the
 * renormalizing division, so it can never receive a nonzero share
 * regardless of its nominal weight in `weights`.
 *
 * If every source is unavailable, returns EMPTY_WEIGHTS (all zero)
 * rather than throwing or dividing by zero -- that is section 35.1's
 * "all sources temporarily unavailable" case, a normal (if rare) input
 * this function must represent cleanly. The caller (Phase 6E's
 * next-card.ts) is responsible for recognizing all-zero output and
 * routing to the documented ALL_SOURCES_TEMPORARILY_UNAVAILABLE /
 * emergency-fallback handling -- this function does not make that
 * decision itself, it only reports "nothing is available to normalize."
 */
export function renormalizeSourceWeights(weights: SourceWeights, availability: SourceAvailability): SourceWeights {
  const masked: SourceWeights = {
    active: availability.active ? weights.active : 0,
    due: availability.due ? weights.due : 0,
    near: availability.near ? weights.near : 0,
  };

  const total = masked.active + masked.due + masked.near;
  if (total <= 0) {
    return EMPTY_WEIGHTS;
  }

  return {
    active: masked.active / total,
    due: masked.due / total,
    near: masked.near / total,
  };
}
