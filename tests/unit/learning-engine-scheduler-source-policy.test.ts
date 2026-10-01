import { describe, expect, it } from "vitest";

import { classifyDueTier, computeSourceWeights } from "@/lib/learning-engine/scheduler/source-policy";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 20
 * (Phase 6B: Dynamic Source Weight policy).
 */

describe("classifyDueTier (section 20.1)", () => {
  it("0 -> ACTIVE_FOCUS", () => {
    expect(classifyDueTier(0)).toBe("ACTIVE_FOCUS");
  });

  it("1-9 -> BALANCED, exact boundaries", () => {
    expect(classifyDueTier(1)).toBe("BALANCED");
    expect(classifyDueTier(9)).toBe("BALANCED");
  });

  it("10+ -> REVIEW_PRESSURE, exact boundary", () => {
    expect(classifyDueTier(10)).toBe("REVIEW_PRESSURE");
    expect(classifyDueTier(500)).toBe("REVIEW_PRESSURE");
  });

  it("throws on a negative due count rather than silently classifying it", () => {
    expect(() => classifyDueTier(-1)).toThrow(/must be >= 0/);
  });
});

describe("computeSourceWeights (section 20.1 pre-goal)", () => {
  it("Due 0: ACTIVE 0.90 / DUE 0.00 / NEAR 0.10", () => {
    const result = computeSourceWeights(0, false);
    expect(result.weights).toEqual({ active: 0.9, due: 0.0, near: 0.1 });
    expect(result.mode).toBe("pre_goal_active_focus");
  });

  it("Due 1-9: ACTIVE 0.70 / DUE 0.25 / NEAR 0.05", () => {
    const result = computeSourceWeights(5, false);
    expect(result.weights).toEqual({ active: 0.7, due: 0.25, near: 0.05 });
    expect(result.mode).toBe("pre_goal_balanced");
  });

  it("Due 10+: ACTIVE 0.50 / DUE 0.48 / NEAR 0.02", () => {
    const result = computeSourceWeights(10, false);
    expect(result.weights).toEqual({ active: 0.5, due: 0.48, near: 0.02 });
    expect(result.mode).toBe("pre_goal_review_pressure");
  });
});

describe("computeSourceWeights (section 20.2 post-goal)", () => {
  it("Due 0: ACTIVE 0.80 / DUE 0.00 / NEAR 0.20", () => {
    const result = computeSourceWeights(0, true);
    expect(result.weights).toEqual({ active: 0.8, due: 0.0, near: 0.2 });
    expect(result.mode).toBe("post_goal_active_focus");
  });

  it("Due 1-9: ACTIVE 0.75 / DUE 0.15 / NEAR 0.10", () => {
    const result = computeSourceWeights(5, true);
    expect(result.weights).toEqual({ active: 0.75, due: 0.15, near: 0.1 });
    expect(result.mode).toBe("post_goal_balanced");
  });

  it("Due 10+: unchanged from pre-goal -- ACTIVE 0.50 / DUE 0.48 / NEAR 0.02", () => {
    const preGoal = computeSourceWeights(10, false);
    const postGoal = computeSourceWeights(10, true);
    expect(postGoal.weights).toEqual(preGoal.weights);
    expect(postGoal.weights).toEqual({ active: 0.5, due: 0.48, near: 0.02 });
    expect(postGoal.mode).toBe("post_goal_review_pressure"); // mode still distinguishes pre/post even though weights match
  });

  it("the goal overlay never suppresses a genuinely large review backlog (section 20.2)", () => {
    const result = computeSourceWeights(50, true);
    expect(result.weights.due).toBeGreaterThanOrEqual(0.48);
  });
});

describe("every regime's weights sum to 1 (sanity check against the spec's own literal table)", () => {
  it.each([
    [0, false],
    [5, false],
    [10, false],
    [0, true],
    [5, true],
    [10, true],
  ] as const)("dueCount=%i dailyGoalCompleted=%s", (dueCount, dailyGoalCompleted) => {
    const { weights } = computeSourceWeights(dueCount, dailyGoalCompleted);
    expect(weights.active + weights.due + weights.near).toBeCloseTo(1, 10);
  });
});

describe("determinism", () => {
  it("is a pure function: identical inputs produce identical output", () => {
    expect(computeSourceWeights(5, false)).toEqual(computeSourceWeights(5, false));
  });
});
