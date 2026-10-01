import { describe, expect, it } from "vitest";

import { computeDueWeight, computeNearDueWeight } from "@/lib/learning-engine/fsrs/priority";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 17
 * (Due card priority), 18 (Near-Due card priority) (Phase 5).
 */

describe("computeNearDueWeight (section 18)", () => {
  it("8. matches the spec's approximate per-decile values", () => {
    expect(computeNearDueWeight(0.75)).toBeCloseTo(1.0);
    expect(computeNearDueWeight(0.8)).toBeCloseTo(1.1);
    expect(computeNearDueWeight(0.85)).toBeCloseTo(1.2);
    expect(computeNearDueWeight(0.9)).toBeCloseTo(1.3);
    expect(computeNearDueWeight(0.95)).toBeCloseTo(1.4);
    expect(computeNearDueWeight(0.9999)).toBeCloseTo(1.5, 2);
  });

  it("is monotonically increasing across the Near-Due range", () => {
    const progresses = [0.75, 0.8, 0.85, 0.9, 0.95, 0.99];
    const weights = progresses.map(computeNearDueWeight);
    for (let i = 1; i < weights.length; i += 1) {
      expect(weights[i]).toBeGreaterThan(weights[i - 1]);
    }
  });

  it("throws for a progress outside [0.75, 1.0) rather than silently extrapolating", () => {
    expect(() => computeNearDueWeight(0.7499)).toThrow();
    expect(() => computeNearDueWeight(1.0)).toThrow();
    expect(() => computeNearDueWeight(1.5)).toThrow();
  });
});

describe("computeDueWeight (section 17)", () => {
  it("9. lower R gives a higher weight (monotonically decreasing in R)", () => {
    const desiredRetention = 0.9;
    const rValues = [0.95, 0.8, 0.6, 0.4, 0.1];
    const weights = rValues.map((r) => computeDueWeight(r, desiredRetention));
    for (let i = 1; i < weights.length; i += 1) {
      expect(weights[i]).toBeGreaterThan(weights[i - 1]);
    }
  });

  it("10. never exceeds 3.0, even for the worst-case R", () => {
    expect(computeDueWeight(0, 0.9)).toBe(3.0);
    // sqrt((1-0)/(1-0.5)) = sqrt(2) ≈ 1.41 -- well under the cap, confirming
    // the cap only bites for a genuinely extreme ratio, not every R=0 case.
    expect(computeDueWeight(0, 0.5)).toBeCloseTo(Math.sqrt(2), 4);
  });

  it("matches the exact formula for an uncapped case", () => {
    // R=0.8, r_d=0.9: sqrt((1-0.8)/(1-0.9)) = sqrt(2) ≈ 1.4142
    expect(computeDueWeight(0.8, 0.9)).toBeCloseTo(Math.sqrt(2), 4);
  });

  it("R=1 (perfect retrievability) gives weight 0 (no urgency)", () => {
    expect(computeDueWeight(1.0, 0.9)).toBe(0);
  });

  it("R exactly at desired retention gives weight 1 (not 0 -- (1-R)/(1-r_d) = 1 when R = r_d)", () => {
    expect(computeDueWeight(0.9, 0.9)).toBe(1);
  });

  it("is deterministic/pure: identical inputs always produce identical output", () => {
    expect(computeDueWeight(0.5, 0.9)).toBe(computeDueWeight(0.5, 0.9));
  });
});
