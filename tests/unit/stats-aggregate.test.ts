import { describe, expect, it } from "vitest";

import {
  lastNTokyoDates,
  buildWeeklyActivity,
  computeAccuracyPercent,
  computeBestCombo,
} from "@/lib/stats/aggregate";

describe("lastNTokyoDates", () => {
  it("returns n dates ending at todayIso, oldest first", () => {
    expect(lastNTokyoDates(7, "2026-09-30")).toEqual([
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
    ]);
  });

  it("crosses a month boundary correctly", () => {
    expect(lastNTokyoDates(3, "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
  });

  it("crosses a year boundary correctly", () => {
    expect(lastNTokyoDates(3, "2026-01-01")).toEqual(["2025-12-30", "2025-12-31", "2026-01-01"]);
  });

  it("a window of 1 returns exactly today", () => {
    expect(lastNTokyoDates(1, "2026-09-30")).toEqual(["2026-09-30"]);
  });
});

describe("buildWeeklyActivity", () => {
  const dates = ["2026-09-28", "2026-09-29", "2026-09-30"];

  it("maps each date to its enemies_defeated count", () => {
    const rows = [
      { stat_date: "2026-09-29", enemies_defeated: 3, total_answers: 0, correct_answers: 0, longest_combo: 0 },
      { stat_date: "2026-09-30", enemies_defeated: 5, total_answers: 0, correct_answers: 0, longest_combo: 0 },
    ];
    const result = buildWeeklyActivity(dates, rows);
    expect(result.map((d) => d.enemiesDefeated)).toEqual([0, 3, 5]);
    expect(result.map((d) => d.date)).toEqual(dates);
  });

  it("defaults to 0 for a date with no daily_user_stats row (zero-activity week)", () => {
    const result = buildWeeklyActivity(dates, []);
    expect(result.every((d) => d.enemiesDefeated === 0)).toBe(true);
  });

  it("derives the weekday label from each date rather than a fixed header", () => {
    // 2026-09-28 is a Monday, 2026-09-29 Tuesday, 2026-09-30 Wednesday (UTC calendar date).
    const result = buildWeeklyActivity(dates, []);
    expect(result.map((d) => d.label)).toEqual(["M", "T", "W"]);
  });
});

describe("computeAccuracyPercent", () => {
  it("returns null when the tester has never submitted a graded answer", () => {
    expect(computeAccuracyPercent(0, 0)).toBeNull();
  });

  it("computes a rounded whole-number percent", () => {
    expect(computeAccuracyPercent(3, 1)).toBe(33);
    expect(computeAccuracyPercent(4, 3)).toBe(75);
  });

  it("handles perfect accuracy", () => {
    expect(computeAccuracyPercent(10, 10)).toBe(100);
  });
});

describe("computeBestCombo", () => {
  it("returns null when there is no daily_user_stats history at all", () => {
    expect(computeBestCombo([])).toBeNull();
  });

  it("returns the max longest_combo across all days", () => {
    expect(computeBestCombo([{ longest_combo: 2 }, { longest_combo: 7 }, { longest_combo: 4 }])).toBe(7);
  });

  it("returns a genuine 0 (not null) when the tester has history but never combo'd", () => {
    expect(computeBestCombo([{ longest_combo: 0 }])).toBe(0);
  });
});
