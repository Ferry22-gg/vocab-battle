/**
 * Learning Engine v1 -- Post-Mastery Dynamic Source Weight policy (Phase 7
 * of the implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 25.3
 * ("Post-Mastery source set").
 *
 * Deliberately a SEPARATE module from lib/learning-engine/scheduler/
 * source-policy.ts (Phase 7 brief section 18: "keep it auditable and
 * separate... do not break ACTIVE/DUE/NEAR ordinary policy") -- the only
 * thing reused from ordinary policy is the due-tier boundary classifier
 * (classifyDueTier/DueTier), since due_count === 0 / 1-9 / 10+ is the
 * identical concept in both regimes (section 25.3 itself keys its rows off
 * the same tiers, never redefining them).
 */

import {
  POST_MASTERY_POST_GOAL_SOURCE_WEIGHTS,
  POST_MASTERY_PRE_GOAL_SOURCE_WEIGHTS,
} from "@/lib/learning-engine/config";
import { classifyDueTier, type DueTier } from "@/lib/learning-engine/scheduler/source-policy";

export interface PostMasterySourceWeights {
  readonly randomMastered: number;
  readonly due: number;
  readonly near: number;
}

/**
 * Section 25.3's six regimes, now all explicitly defined (reviewed
 * correction): post-goal zero-Due was initially treated as an unresolved
 * specification gap; it is confirmed IDENTICAL to the pre-goal zero-Due
 * row ("intentionally unchanged... already sufficiently free-play
 * oriented"), not a fourth tier or a thrown error.
 */
export type PostMasterySchedulerMode =
  | "post_mastery_pre_goal_active_focus"
  | "post_mastery_pre_goal_balanced"
  | "post_mastery_pre_goal_review_pressure"
  | "post_mastery_post_goal_active_focus"
  | "post_mastery_post_goal_balanced"
  | "post_mastery_post_goal_review_pressure";

const PRE_GOAL_MODE_BY_TIER: Record<DueTier, PostMasterySchedulerMode> = {
  ACTIVE_FOCUS: "post_mastery_pre_goal_active_focus",
  BALANCED: "post_mastery_pre_goal_balanced",
  REVIEW_PRESSURE: "post_mastery_pre_goal_review_pressure",
};

const POST_GOAL_MODE_BY_TIER: Record<DueTier, PostMasterySchedulerMode> = {
  ACTIVE_FOCUS: "post_mastery_post_goal_active_focus",
  BALANCED: "post_mastery_post_goal_balanced",
  REVIEW_PRESSURE: "post_mastery_post_goal_review_pressure",
};

export interface PostMasterySourcePolicyResult {
  readonly mode: PostMasterySchedulerMode;
  readonly weights: PostMasterySourceWeights;
}

/**
 * Section 25.3: the full pre/post-goal x due-tier lookup for Post-Mastery
 * mode -- all SIX regimes, including post-goal zero-Due (reviewed
 * correction: confirmed identical to the pre-goal zero-Due row, not a
 * specification gap -- see PostMasterySchedulerMode's doc comment).
 * `dueCount` must come from the same freshly-read snapshot the caller used
 * for everything else this draw (no caching), exactly like ordinary mode's
 * computeSourceWeights.
 */
export function computePostMasterySourceWeights(dueCount: number, dailyGoalCompleted: boolean): PostMasterySourcePolicyResult {
  const tier = classifyDueTier(dueCount);
  const table = dailyGoalCompleted ? POST_MASTERY_POST_GOAL_SOURCE_WEIGHTS : POST_MASTERY_PRE_GOAL_SOURCE_WEIGHTS;
  const modeByTier = dailyGoalCompleted ? POST_GOAL_MODE_BY_TIER : PRE_GOAL_MODE_BY_TIER;

  return { mode: modeByTier[tier], weights: table[tier] };
}

// =============================================================================
// Section 11 of the Phase 7 brief / section 21 of spec: empty-source
// renormalization, mirroring lib/learning-engine/scheduler/renormalize.ts
// exactly but over Post-Mastery's own {randomMastered, due, near} shape.
// =============================================================================

export interface PostMasterySourceAvailability {
  readonly randomMastered: boolean;
  readonly due: boolean;
  readonly near: boolean;
}

const EMPTY_POST_MASTERY_WEIGHTS: PostMasterySourceWeights = { randomMastered: 0, due: 0, near: 0 };

/**
 * Identical algorithm to lib/learning-engine/scheduler/renormalize.ts's
 * renormalizeSourceWeights (zero out unavailable sources, then divide by
 * the remaining total) -- kept as a small, separate copy rather than a
 * generic shared implementation because the two source shapes
 * (`{active,due,near}` vs. `{randomMastered,due,near}`) are structurally
 * different types with different semantic meaning per field, and Phase 7
 * brief section 18 explicitly asks to keep Post-Mastery policy "auditable
 * and separate" rather than sharing a type across the two unrelated
 * concepts "ACTIVE" and "RANDOM_MASTERED".
 */
export function renormalizePostMasterySourceWeights(
  weights: PostMasterySourceWeights,
  availability: PostMasterySourceAvailability,
): PostMasterySourceWeights {
  const masked: PostMasterySourceWeights = {
    randomMastered: availability.randomMastered ? weights.randomMastered : 0,
    due: availability.due ? weights.due : 0,
    near: availability.near ? weights.near : 0,
  };

  const total = masked.randomMastered + masked.due + masked.near;
  if (total <= 0) {
    return EMPTY_POST_MASTERY_WEIGHTS;
  }

  return {
    randomMastered: masked.randomMastered / total,
    due: masked.due / total,
    near: masked.near / total,
  };
}
