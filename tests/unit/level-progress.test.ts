import { describe, expect, it } from "vitest";

import { computeLevelProgress, xpProgressPercent } from "@/lib/home/level-progress";

describe("computeLevelProgress", () => {
  it("matches the documented cumulative(L) = 200*(L-1) + 25*(L-1)*(L-2) formula", () => {
    // cumulative(1) = 0, cumulative(2) = 200, cumulative(3) = 450
    expect(computeLevelProgress(0, 1)).toEqual({ currentLevelXp: 0, xpForNextLevel: 200 });
    expect(computeLevelProgress(199, 1)).toEqual({ currentLevelXp: 199, xpForNextLevel: 200 });
    expect(computeLevelProgress(200, 2)).toEqual({ currentLevelXp: 0, xpForNextLevel: 250 });
    expect(computeLevelProgress(420, 2)).toEqual({ currentLevelXp: 220, xpForNextLevel: 250 });
  });

  it("never returns a negative currentLevelXp even if totalXp is below the level floor", () => {
    expect(computeLevelProgress(50, 2).currentLevelXp).toBe(0);
  });
});

describe("xpProgressPercent", () => {
  it("computes the earned/needed ratio as a percent", () => {
    expect(xpProgressPercent(220, 250)).toBeCloseTo(88, 5);
  });

  it("clamps to [0, 100]", () => {
    expect(xpProgressPercent(-10, 250)).toBe(0);
    expect(xpProgressPercent(999, 250)).toBe(100);
  });

  it("returns 0 rather than dividing by zero when xpForNextLevel is 0", () => {
    expect(xpProgressPercent(10, 0)).toBe(0);
  });
});
