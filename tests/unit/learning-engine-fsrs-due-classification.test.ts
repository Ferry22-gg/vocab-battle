import { describe, expect, it } from "vitest";

import { classifyDueSource, computeIntervalProgress } from "@/lib/learning-engine/fsrs/due-classification";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 16.1
 * (Phase 5: Due/Near-Due classification).
 */

describe("classifyDueSource boundaries (section 16.1)", () => {
  it("7a. 0.7499 -> STRONG_OUTSIDE (not Near-Due)", () => {
    expect(classifyDueSource(0.7499)).toBe("STRONG_OUTSIDE");
  });

  it("7b. 0.75 -> NEAR_DUE", () => {
    expect(classifyDueSource(0.75)).toBe("NEAR_DUE");
  });

  it("7c. 0.9999 -> NEAR_DUE", () => {
    expect(classifyDueSource(0.9999)).toBe("NEAR_DUE");
  });

  it("7d. 1.0 -> FSRS_DUE", () => {
    expect(classifyDueSource(1.0)).toBe("FSRS_DUE");
  });

  it("well past due stays FSRS_DUE (no upper bound)", () => {
    expect(classifyDueSource(5.0)).toBe("FSRS_DUE");
  });

  it("0 progress (just reviewed) is STRONG_OUTSIDE", () => {
    expect(classifyDueSource(0)).toBe("STRONG_OUTSIDE");
  });
});

describe("computeIntervalProgress (section 16.1)", () => {
  it("computes a plain ratio in the caller's chosen consistent unit", () => {
    expect(computeIntervalProgress(7.5, 10)).toBe(0.75);
    expect(computeIntervalProgress(15, 10)).toBe(1.5);
  });

  it("invalid/zero interval is handled explicitly: returns null, never NaN/Infinity", () => {
    expect(computeIntervalProgress(5, 0)).toBeNull();
    expect(computeIntervalProgress(5, -1)).toBeNull();
    expect(computeIntervalProgress(5, Number.NaN)).toBeNull();
    expect(computeIntervalProgress(5, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("invalid elapsed is handled explicitly", () => {
    expect(computeIntervalProgress(-1, 10)).toBeNull();
    expect(computeIntervalProgress(Number.NaN, 10)).toBeNull();
  });

  it("a null (invalid-interval) progress classifies conservatively as STRONG_OUTSIDE, not silently as due", () => {
    const progress = computeIntervalProgress(5, 0);
    expect(progress).toBeNull();
    expect(classifyDueSource(progress)).toBe("STRONG_OUTSIDE");
  });

  it("is deterministic/pure: identical inputs always produce identical output", () => {
    expect(computeIntervalProgress(7.5, 10)).toBe(computeIntervalProgress(7.5, 10));
  });
});
