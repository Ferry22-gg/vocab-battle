/**
 * Learning Engine v1 -- Due and Near-Due priority primitives (Phase 5 of
 * the implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 17
 * ("Due card priority") and 18 ("Near-Due card priority").
 *
 * These are the per-candidate WEIGHT primitives only -- "Do not perform
 * source selection yet" (Phase 5 brief, sections 7/8). Weighted-random
 * sampling across a source's candidates (`P(i) = w(i) / sum(w)`),
 * choosing between ACTIVE/FSRS_DUE/NEAR_DUE sources, and the Dynamic
 * Source Weight modes are all Phase 6.
 */

import { DUE_WEIGHT_CAP, NEAR_DUE_END_PROGRESS, NEAR_DUE_START_PROGRESS } from "@/lib/learning-engine/config";

/**
 * Section 17: `w_due(i) = min(3.0, sqrt((1 - R_i) / (1 - r_d)))`.
 *
 *   - `retrievability` (R_i): current Retrievability, expected in [0, 1]
 *     (ts-fsrs's own get_retrievability output range -- see
 *     lib/learning-engine/fsrs/adapter.ts's deriveRetrievability).
 *   - `desiredRetention` (r_d): expected in (0, 1) -- always true for
 *     both v1 values (0.90/0.92, lib/learning-engine/fsrs/retention.ts).
 *
 * Lower R produces a higher weight (more urgent); the cap means an
 * extremely low R never dominates selection unboundedly. "Do not
 * separately multiply by days overdue in v1" (section 17) -- this
 * function takes no such parameter; days-overdue is logged elsewhere for
 * analytics only (a later phase's telemetry concern, not this one's).
 */
export function computeDueWeight(retrievability: number, desiredRetention: number): number {
  const raw = Math.sqrt((1 - retrievability) / (1 - desiredRetention));
  return Math.min(DUE_WEIGHT_CAP, raw);
}

/**
 * Section 18: for `0.75 <= p < 1.0`, `x = (p - 0.75) / 0.25`,
 * `w_near = 1 + 0.5 * x` -- approximately 1.00 at 75% progress rising
 * linearly to ~1.50 as progress approaches 100%.
 *
 * Requires `intervalProgress` already classified NEAR_DUE by
 * lib/learning-engine/fsrs/due-classification.ts's classifyDueSource
 * (i.e. in `[NEAR_DUE_START_PROGRESS, NEAR_DUE_END_PROGRESS)`) -- throws
 * otherwise rather than silently extrapolating the formula outside the
 * range the spec defines it for (a STRONG_OUTSIDE or FSRS_DUE card has no
 * Near-Due weight at all; asking for one is a caller error, not a value
 * to guess at). "R must still be logged but is not multiplied into
 * Near-Due priority in v1" (section 18) -- this function takes no
 * retrievability parameter for that reason.
 */
export function computeNearDueWeight(intervalProgress: number): number {
  if (intervalProgress < NEAR_DUE_START_PROGRESS || intervalProgress >= NEAR_DUE_END_PROGRESS) {
    throw new Error(
      `computeNearDueWeight: intervalProgress ${intervalProgress} is outside the Near-Due range ` +
        `[${NEAR_DUE_START_PROGRESS}, ${NEAR_DUE_END_PROGRESS})`,
    );
  }

  const x = (intervalProgress - NEAR_DUE_START_PROGRESS) / (NEAR_DUE_END_PROGRESS - NEAR_DUE_START_PROGRESS);
  return 1 + 0.5 * x;
}
