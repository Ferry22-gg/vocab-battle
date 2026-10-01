import { describe, expect, it } from "vitest";

import { renormalizeSourceWeights } from "@/lib/learning-engine/scheduler/renormalize";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 21
 * (Phase 6B: empty-source removal and renormalization).
 */

describe("renormalizeSourceWeights (section 21)", () => {
  it("section 21's own worked example: ACTIVE 0.90/NEAR 0.10 with NEAR empty renormalizes to ACTIVE 1.00", () => {
    const result = renormalizeSourceWeights(
      { active: 0.9, due: 0.0, near: 0.1 },
      { active: true, due: true, near: false },
    );
    expect(result).toEqual({ active: 1, due: 0, near: 0 });
  });

  it("all sources available: weights pass through unchanged (already normalized)", () => {
    const weights = { active: 0.7, due: 0.25, near: 0.05 };
    const result = renormalizeSourceWeights(weights, { active: true, due: true, near: true });
    expect(result.active).toBeCloseTo(0.7);
    expect(result.due).toBeCloseTo(0.25);
    expect(result.near).toBeCloseTo(0.05);
  });

  it("a zero-weight-but-available source stays zero after renormalization (Due 0 tier: due weight is already 0)", () => {
    const result = renormalizeSourceWeights(
      { active: 0.9, due: 0.0, near: 0.1 },
      { active: true, due: true, near: true },
    );
    expect(result.due).toBe(0);
  });

  it("two sources empty: the remaining source gets the full weight", () => {
    const result = renormalizeSourceWeights(
      { active: 0.5, due: 0.48, near: 0.02 },
      { active: false, due: true, near: false },
    );
    expect(result).toEqual({ active: 0, due: 1, near: 0 });
  });

  it("never attempts to draw from an empty source: an unavailable source's weight is always exactly 0 in the output, regardless of its nominal input weight", () => {
    const result = renormalizeSourceWeights(
      { active: 0.5, due: 0.48, near: 0.02 },
      { active: true, due: false, near: true },
    );
    expect(result.due).toBe(0);
  });

  it("all sources unavailable: returns all-zero weights rather than throwing or dividing by zero", () => {
    const result = renormalizeSourceWeights(
      { active: 0.7, due: 0.25, near: 0.05 },
      { active: false, due: false, near: false },
    );
    expect(result).toEqual({ active: 0, due: 0, near: 0 });
  });

  it("the normalized weights always sum to 1 when at least one source is available", () => {
    const cases: Array<[{ active: boolean; due: boolean; near: boolean }]> = [
      [{ active: true, due: true, near: true }],
      [{ active: true, due: false, near: true }],
      [{ active: false, due: true, near: false }],
      [{ active: true, due: false, near: false }],
    ];
    for (const [availability] of cases) {
      const result = renormalizeSourceWeights({ active: 0.5, due: 0.48, near: 0.02 }, availability);
      expect(result.active + result.due + result.near).toBeCloseTo(1, 10);
    }
  });

  it("is deterministic/pure", () => {
    const weights = { active: 0.7, due: 0.25, near: 0.05 };
    const availability = { active: true, due: false, near: true };
    expect(renormalizeSourceWeights(weights, availability)).toEqual(renormalizeSourceWeights(weights, availability));
  });
});
