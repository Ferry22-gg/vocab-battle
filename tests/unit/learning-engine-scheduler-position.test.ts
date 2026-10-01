import { describe, expect, it } from "vitest";

import { advanceSchedulerPosition, hasCriticalDueAppearedRecently } from "@/lib/learning-engine/scheduler/position";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 22.2
 * (Phase 6A: scheduler position primitives).
 */

describe("advanceSchedulerPosition (decision 1: one step per committed answer)", () => {
  it("advances by exactly 1", () => {
    expect(advanceSchedulerPosition(0)).toBe(1);
    expect(advanceSchedulerPosition(41)).toBe(42);
  });

  it("is pure (no mutation, repeatable)", () => {
    const position = 100;
    expect(advanceSchedulerPosition(position)).toBe(advanceSchedulerPosition(position));
    expect(position).toBe(100);
  });
});

describe("hasCriticalDueAppearedRecently (section 22.2) -- takes the PERSISTED scheduler_position directly, not a pre-incremented 'next position'", () => {
  it("never has appeared when no Critical Due has ever been forced for this deck (null)", () => {
    expect(hasCriticalDueAppearedRecently(1000, null)).toBe(false);
  });

  it("regression (review): persisted scheduler_position = P+4 still blocks; P+5 is already eligible for the NEXT question to force again", () => {
    const P = 10;
    // current scheduler_position = P+4 -> last Critical at P is still
    // within the last 5 completed questions (P, P+1..P+4) -> do not
    // force yet.
    expect(hasCriticalDueAppearedRecently(P + 4, P)).toBe(true);
    // current scheduler_position = P+5 -> the 5 most recently completed
    // questions are P+1..P+5, which no longer include P -> the NEXT
    // question (P+6) must be eligible for the Critical Due interrupt.
    expect(hasCriticalDueAppearedRecently(P + 5, P)).toBe(false);
  });

  it("boundary: persisted positions P through P+4 (inclusive) block; P+5 onward is eligible", () => {
    const P = 10;
    expect(hasCriticalDueAppearedRecently(P, P)).toBe(true); // the position Critical Due was itself forced at
    expect(hasCriticalDueAppearedRecently(P + 1, P)).toBe(true);
    expect(hasCriticalDueAppearedRecently(P + 2, P)).toBe(true);
    expect(hasCriticalDueAppearedRecently(P + 3, P)).toBe(true);
    expect(hasCriticalDueAppearedRecently(P + 4, P)).toBe(true);
    expect(hasCriticalDueAppearedRecently(P + 5, P)).toBe(false);
    expect(hasCriticalDueAppearedRecently(P + 6, P)).toBe(false);
  });

  it("stays eligible (false) arbitrarily far past the window, not just at the boundary", () => {
    expect(hasCriticalDueAppearedRecently(10_000, 10)).toBe(false);
  });

  it("is deterministic/pure", () => {
    expect(hasCriticalDueAppearedRecently(16, 10)).toBe(hasCriticalDueAppearedRecently(16, 10));
  });
});
