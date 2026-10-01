/**
 * Learning Engine v1 -- Dynamic Source Weight policy (Phase 6B of the
 * implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 20
 * ("Dynamic Source Weight v1").
 *
 * Pure lookup: `due_count` and Daily Goal completion select one of six
 * regimes (three due-count tiers x pre/post Daily Goal); the regime's
 * weights are the spec's own literal values (lib/learning-engine/
 * config.ts's PRE_GOAL_SOURCE_WEIGHTS/POST_GOAL_SOURCE_WEIGHTS), never
 * derived or interpolated.
 *
 * Does NOT remove empty sources or renormalize -- that is
 * lib/learning-engine/scheduler/renormalize.ts's separate job (section
 * 21 is explicitly its own step in the pipeline, after mode/weight
 * selection). Does NOT choose a source -- that's
 * lib/learning-engine/scheduler/weighted-random.ts, fed by this module's
 * (possibly renormalized) output.
 */

import {
  DUE_TIER_REVIEW_PRESSURE_THRESHOLD,
  POST_GOAL_SOURCE_WEIGHTS,
  PRE_GOAL_SOURCE_WEIGHTS,
} from "@/lib/learning-engine/config";

export type DueTier = "ACTIVE_FOCUS" | "BALANCED" | "REVIEW_PRESSURE";

export type SchedulerMode =
  | "pre_goal_active_focus"
  | "pre_goal_balanced"
  | "pre_goal_review_pressure"
  | "post_goal_active_focus"
  | "post_goal_balanced"
  | "post_goal_review_pressure";

export interface SourceWeights {
  readonly active: number;
  readonly due: number;
  readonly near: number;
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`source-policy: ${message}`);
  }
}

const SCHEDULER_MODE_BY_TIER: Record<"PRE_GOAL" | "POST_GOAL", Record<DueTier, SchedulerMode>> = {
  PRE_GOAL: {
    ACTIVE_FOCUS: "pre_goal_active_focus",
    BALANCED: "pre_goal_balanced",
    REVIEW_PRESSURE: "pre_goal_review_pressure",
  },
  POST_GOAL: {
    ACTIVE_FOCUS: "post_goal_active_focus",
    BALANCED: "post_goal_balanced",
    REVIEW_PRESSURE: "post_goal_review_pressure",
  },
};

/**
 * Section 20.1: due_count === 0 -> Active Focus; 1-9 -> Balanced; 10+ ->
 * Review Pressure (the spec's own "Equivalent with target 20" literal
 * ranges, used directly rather than the ratio form `due_count/20` they
 * are derived from -- functionally identical for the fixed target of 20,
 * and avoids floating-point boundary questions the ratio form would
 * otherwise raise for no benefit).
 */
export function classifyDueTier(dueCount: number): DueTier {
  invariant(dueCount >= 0, `dueCount must be >= 0, got ${dueCount}`);
  if (dueCount === 0) {
    return "ACTIVE_FOCUS";
  }
  if (dueCount < DUE_TIER_REVIEW_PRESSURE_THRESHOLD) {
    return "BALANCED";
  }
  return "REVIEW_PRESSURE";
}

export interface SourcePolicyResult {
  readonly mode: SchedulerMode;
  readonly weights: SourceWeights;
}

/**
 * Section 20.1-20.2: the full pre/post-goal x due-tier lookup. `dueCount`
 * must be recomputed by the caller from a freshly-read snapshot
 * immediately before calling this (section 20: "Re-evaluate before every
 * ordinary card selection") -- this function has no memory of a previous
 * call and performs no caching itself, so per-draw re-evaluation is
 * simply "call this again with the current due_count", not a separate
 * invalidation mechanism to build.
 */
export function computeSourceWeights(dueCount: number, dailyGoalCompleted: boolean): SourcePolicyResult {
  const tier = classifyDueTier(dueCount);
  const goalPhase = dailyGoalCompleted ? "POST_GOAL" : "PRE_GOAL";
  const table = dailyGoalCompleted ? POST_GOAL_SOURCE_WEIGHTS : PRE_GOAL_SOURCE_WEIGHTS;

  return {
    mode: SCHEDULER_MODE_BY_TIER[goalPhase][tier],
    weights: table[tier],
  };
}
