import { describe, expect, it } from "vitest";

import {
  buildWeeklyActivity,
  computeAccuracyPercent,
  computeBestCombo,
  computeEstimatedStudyTimeMs,
  computeLearningProgress,
  computeMostAnswersInADay,
  computeMostXpInADay,
  computeStudyDays,
  computeTodayEstimatedStudyTimeMs,
  computeTodayUniqueWordsStudied,
  computeTodayWordsLearned,
  currentTokyoWeekDates,
  formatEstimatedStudyTime,
  STUDY_TIME_PER_ANSWER_CAP_MS,
  type AnswerHistoryRow,
} from "@/lib/stats/aggregate";

/**
 * Stats Alpha polish A1: "This Week" means the current Asia/Tokyo
 * Monday->Sunday calendar week, never a rolling last-7-days window.
 * 2026-09-28 is a known Monday (also used by buildWeeklyActivity's own
 * tests below) -- its week runs 2026-09-28 (Mon) through 2026-10-04
 * (Sun), which also happens to cross a month boundary.
 */
describe("currentTokyoWeekDates", () => {
  const MON_SUN = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];

  it("Monday boundary: today = Monday itself returns that week, Monday first", () => {
    expect(currentTokyoWeekDates("2026-09-28")).toEqual(MON_SUN);
  });

  it("Sunday boundary: today = Sunday returns the SAME week (Monday still first, Sunday last)", () => {
    expect(currentTokyoWeekDates("2026-10-04")).toEqual(MON_SUN);
  });

  it("a mid-week day returns the same Monday-first week as its own Monday/Sunday", () => {
    expect(currentTokyoWeekDates("2026-09-30")).toEqual(MON_SUN); // Wednesday
  });

  it("cross-month week: the week itself spans September into October, always Monday first", () => {
    const week = currentTokyoWeekDates("2026-09-30");
    expect(week[0]).toBe("2026-09-28");
    expect(week[6]).toBe("2026-10-04");
    expect(week).toContain("2026-10-01"); // the month boundary falls mid-week
  });

  it("cross-year week: a Thursday January 1st still resolves to the Monday in the PREVIOUS year", () => {
    expect(currentTokyoWeekDates("2026-01-01")).toEqual([
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ]);
  });

  it("always returns exactly 7 dates, Monday first, Sunday last, regardless of which day of the week todayIso is", () => {
    for (const today of MON_SUN) {
      const week = currentTokyoWeekDates(today);
      expect(week).toHaveLength(7);
      expect(week).toEqual(MON_SUN);
    }
  });
});

describe("buildWeeklyActivity", () => {
  const dates = ["2026-09-28", "2026-09-29", "2026-09-30"];

  it("maps each date to its total_answers count", () => {
    const rows = [
      { stat_date: "2026-09-29", total_answers: 3, correct_answers: 0, longest_combo: 0, xp_gained: 0 },
      { stat_date: "2026-09-30", total_answers: 5, correct_answers: 0, longest_combo: 0, xp_gained: 0 },
    ];
    const result = buildWeeklyActivity(dates, rows);
    expect(result.map((d) => d.answers)).toEqual([0, 3, 5]);
    expect(result.map((d) => d.date)).toEqual(dates);
  });

  it("defaults to 0 for a date with no daily_user_stats row (zero-activity week)", () => {
    const result = buildWeeklyActivity(dates, []);
    expect(result.every((d) => d.answers === 0)).toBe(true);
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

/**
 * Estimated Study Time (Alpha-safe estimate). Timestamps use noon UTC for
 * each calendar date -- Asia/Tokyo is UTC+9, so noon UTC always falls on
 * the SAME calendar date in Tokyo too, keeping the fixtures unambiguous.
 */
describe("Estimated Study Time", () => {
  const TODAY = "2026-09-30";
  const YESTERDAY = "2026-09-29";
  const todayAt = (hourUtc: number): string => `${TODAY}T${String(hourUtc).padStart(2, "0")}:00:00.000Z`;
  const yesterdayAt = (hourUtc: number): string => `${YESTERDAY}T${String(hourUtc).padStart(2, "0")}:00:00.000Z`;

  function row(
    answeredAt: string,
    responseTimeMs: number | null,
    extra: Partial<Pick<AnswerHistoryRow, "card_id" | "card_status_before" | "card_status_after">> = {},
  ): AnswerHistoryRow {
    return {
      answered_at: answeredAt,
      response_time_ms: responseTimeMs,
      card_id: extra.card_id ?? "card-1",
      card_status_before: extra.card_status_before ?? "NEW",
      card_status_after: extra.card_status_after ?? "LEARNING",
    };
  }

  it("A. normal response times sum correctly", () => {
    const rows = [row(todayAt(1), 1000), row(todayAt(2), 2000), row(todayAt(3), 1500)];
    expect(computeEstimatedStudyTimeMs(rows)).toBe(4500);
  });

  it("B. one answer over the 60s cap contributes exactly 60s, never its raw value", () => {
    expect(STUDY_TIME_PER_ANSWER_CAP_MS).toBe(60_000);
    const rows = [row(todayAt(1), 90_000)];
    expect(computeEstimatedStudyTimeMs(rows)).toBe(60_000);
  });

  it("C. multiple capped answers aggregate correctly, alongside normal ones", () => {
    const rows = [row(todayAt(1), 100_000), row(todayAt(2), 100_000), row(todayAt(3), 5_000)];
    // 60_000 + 60_000 + 5_000
    expect(computeEstimatedStudyTimeMs(rows)).toBe(125_000);
  });

  it("D. empty history sums to 0 (and formats as '0 min')", () => {
    expect(computeEstimatedStudyTimeMs([])).toBe(0);
    expect(computeTodayEstimatedStudyTimeMs([], TODAY)).toBe(0);
    expect(formatEstimatedStudyTime(0)).toBe("0 min");
  });

  it("ignores null/invalid/negative response_time_ms values defensively (never throws, never a fabricated positive number)", () => {
    const rows = [
      row(todayAt(1), null),
      row(todayAt(2), -500),
      row(todayAt(3), Number.NaN),
      row(todayAt(4), 2_000),
    ];
    expect(computeEstimatedStudyTimeMs(rows)).toBe(2_000);
  });

  it("E. Today excludes previous Asia/Tokyo calendar dates", () => {
    const rows = [row(todayAt(1), 3_000), row(yesterdayAt(1), 10_000)];
    expect(computeTodayEstimatedStudyTimeMs(rows, TODAY)).toBe(3_000);
  });

  it("an unparseable answered_at is excluded from Today rather than throwing", () => {
    const rows = [row("not-a-real-timestamp", 5_000), row(todayAt(1), 1_000)];
    expect(computeTodayEstimatedStudyTimeMs(rows, TODAY)).toBe(1_000);
  });

  it("F. Lifetime includes all dates, not just today", () => {
    const rows = [row(todayAt(1), 3_000), row(yesterdayAt(1), 10_000)];
    expect(computeEstimatedStudyTimeMs(rows)).toBe(13_000);
  });

  it("G. formats 0, under-an-hour, and over-an-hour durations", () => {
    expect(formatEstimatedStudyTime(0)).toBe("0 min");
    expect(formatEstimatedStudyTime(8 * 60_000)).toBe("8 min"); // 8m
    expect(formatEstimatedStudyTime(84 * 60_000)).toBe("1h 24m"); // 84m
  });

  /** Stats Alpha polish A4: a real nonzero sub-minute duration must read as "<1 min", never the same "0 min" as genuinely zero. */
  describe("formatEstimatedStudyTime: sub-minute durations (polish A4)", () => {
    it("exactly 0ms formats as '0 min'", () => {
      expect(formatEstimatedStudyTime(0)).toBe("0 min");
    });

    it("12 seconds formats as '<1 min', never '0 min'", () => {
      expect(formatEstimatedStudyTime(12_000)).toBe("<1 min");
    });

    it("59 seconds formats as '<1 min'", () => {
      expect(formatEstimatedStudyTime(59_000)).toBe("<1 min");
    });

    it("exactly 60 seconds (60,000ms) formats as '1 min', not '<1 min'", () => {
      expect(formatEstimatedStudyTime(60_000)).toBe("1 min");
    });

    it("a negative duration (defensive -- should not occur in practice) formats as '0 min', never a malformed string", () => {
      expect(formatEstimatedStudyTime(-500)).toBe("0 min");
    });
  });

  describe("computeTodayUniqueWordsStudied", () => {
    it("counts each card once, even when answered multiple times today", () => {
      const rows = [
        row(todayAt(1), 1000, { card_id: "a" }),
        row(todayAt(2), 1000, { card_id: "a" }),
        row(todayAt(3), 1000, { card_id: "b" }),
      ];
      expect(computeTodayUniqueWordsStudied(rows, TODAY)).toBe(2);
    });

    it("excludes previous Tokyo calendar dates", () => {
      const rows = [row(todayAt(1), 1000, { card_id: "a" }), row(yesterdayAt(1), 1000, { card_id: "b" })];
      expect(computeTodayUniqueWordsStudied(rows, TODAY)).toBe(1);
    });

    it("empty history = 0", () => {
      expect(computeTodayUniqueWordsStudied([], TODAY)).toBe(0);
    });
  });

  describe("computeTodayWordsLearned", () => {
    it("counts a card that transitioned into ACQUIRED today", () => {
      const rows = [row(todayAt(1), 1000, { card_id: "a", card_status_before: "LEARNING", card_status_after: "ACQUIRED" })];
      expect(computeTodayWordsLearned(rows, TODAY)).toBe(1);
    });

    it("does not count a transition that merely stays or ends at a non-ACQUIRED status", () => {
      const rows = [
        row(todayAt(1), 1000, { card_id: "a", card_status_before: "NEW", card_status_after: "LEARNING" }),
        row(todayAt(2), 1000, { card_id: "b", card_status_before: "ACQUIRED", card_status_after: "LEARNED" }),
      ];
      expect(computeTodayWordsLearned(rows, TODAY)).toBe(0);
    });

    it("does not count a card that was already ACQUIRED before this answer (no genuine transition)", () => {
      const rows = [row(todayAt(1), 1000, { card_id: "a", card_status_before: "ACQUIRED", card_status_after: "ACQUIRED" })];
      expect(computeTodayWordsLearned(rows, TODAY)).toBe(0);
    });

    it("counts the same card only once even if it reaches ACQUIRED twice today", () => {
      const rows = [
        row(todayAt(1), 1000, { card_id: "a", card_status_before: "LEARNING", card_status_after: "ACQUIRED" }),
        row(todayAt(2), 1000, { card_id: "a", card_status_before: "FORGOTTEN", card_status_after: "ACQUIRED" }),
      ];
      expect(computeTodayWordsLearned(rows, TODAY)).toBe(1);
    });

    it("excludes a transition from a previous Tokyo calendar date", () => {
      const rows = [row(yesterdayAt(1), 1000, { card_id: "a", card_status_before: "LEARNING", card_status_after: "ACQUIRED" })];
      expect(computeTodayWordsLearned(rows, TODAY)).toBe(0);
    });

    it("empty history = 0", () => {
      expect(computeTodayWordsLearned([], TODAY)).toBe(0);
    });
  });
});

describe("computeMostAnswersInADay", () => {
  it("returns the max total_answers across all days", () => {
    expect(
      computeMostAnswersInADay([
        { total_answers: 5 },
        { total_answers: 12 },
        { total_answers: 3 },
      ]),
    ).toBe(12);
  });

  it("returns 0 (not null) for no history -- a sensible empty state for a brand-new tester", () => {
    expect(computeMostAnswersInADay([])).toBe(0);
  });
});

describe("computeMostXpInADay", () => {
  it("returns the max xp_gained across all days", () => {
    expect(computeMostXpInADay([{ xp_gained: 10 }, { xp_gained: 42 }, { xp_gained: 7 }])).toBe(42);
  });

  it("returns 0 (not null) for no history", () => {
    expect(computeMostXpInADay([])).toBe(0);
  });
});

describe("computeStudyDays", () => {
  it("returns the number of daily_user_stats rows (one per distinct active Tokyo day)", () => {
    expect(computeStudyDays([{}, {}, {}])).toBe(3);
  });

  it("returns 0 for no history", () => {
    expect(computeStudyDays([])).toBe(0);
  });
});

describe("computeLearningProgress", () => {
  it("maps backend card_status to the four user-facing tiers", () => {
    const result = computeLearningProgress(["NEW", "NEW", "LEARNING", "ACQUIRED", "LEARNED", "LEARNED"]);
    expect(result).toEqual({
      totalCards: 6,
      newCount: 2,
      learningCount: 1,
      learnedCount: 1,
      masteredCount: 2,
      headlineLearnedCount: 3, // learnedCount + masteredCount
    });
  });

  it("folds FORGOTTEN into the 'Learning' tile, so the four tiles still sum to totalCards exactly", () => {
    const result = computeLearningProgress(["NEW", "LEARNING", "FORGOTTEN", "ACQUIRED"]);
    expect(result.learningCount).toBe(2); // LEARNING + FORGOTTEN
    expect(result.newCount + result.learningCount + result.learnedCount + result.masteredCount).toBe(result.totalCards);
  });

  /**
   * Stats Alpha polish A3, pinned down explicitly so this is never "fixed"
   * incorrectly later: `headlineLearnedCount` (the progress-bar headline
   * numerator) is DELIBERATELY `learnedCount + masteredCount`, not
   * `learnedCount` alone. It is valid and EXPECTED for the headline total
   * to equal the "Learned" tile plus the "Mastered" tile combined --
   * Mastered is an advanced state beyond Learned, so a Mastered card
   * still counts as "having learned the word."
   */
  describe("headlineLearnedCount: intentionally ACQUIRED + LEARNED combined -- do not reduce to ACQUIRED alone", () => {
    it("equals exactly learnedCount + masteredCount when both are nonzero", () => {
      // Example from the task brief: New 42, Learning 11, Learned 5, Mastered 2 -> headline 7/60.
      const statuses = [
        ...Array(42).fill("NEW"),
        ...Array(11).fill("LEARNING"),
        ...Array(5).fill("ACQUIRED"),
        ...Array(2).fill("LEARNED"),
      ] as const;
      const result = computeLearningProgress(statuses);
      expect(result.totalCards).toBe(60);
      expect(result.learnedCount).toBe(5);
      expect(result.masteredCount).toBe(2);
      expect(result.headlineLearnedCount).toBe(7); // 5 + 2, NOT 5 alone
    });

    it("progressing a card from Learned to Mastered does not decrease the headline (no appearance of lost progress)", () => {
      const beforeMastery = computeLearningProgress(["ACQUIRED"]); // Learned tile = 1, headline = 1
      const afterMastery = computeLearningProgress(["LEARNED"]); // Mastered tile = 1, Learned tile = 0, headline still = 1
      expect(beforeMastery.headlineLearnedCount).toBe(1);
      expect(afterMastery.headlineLearnedCount).toBe(1);
      expect(afterMastery.learnedCount).toBe(0); // the "Learned" tile alone DOES drop -- only the headline stays steady
      expect(afterMastery.masteredCount).toBe(1);
    });

    it("can legitimately be smaller after a lapse (LEARNED or ACQUIRED -> FORGOTTEN) -- not a bug", () => {
      // A deck where the only Mastered card has since lapsed back to FORGOTTEN:
      const afterLapse = computeLearningProgress(["NEW", "FORGOTTEN"]);
      expect(afterLapse.headlineLearnedCount).toBe(0);
    });
  });

  it("empty deck (0 cards) yields all-zero counts, never a divide-by-zero", () => {
    expect(computeLearningProgress([])).toEqual({
      totalCards: 0,
      newCount: 0,
      learningCount: 0,
      learnedCount: 0,
      masteredCount: 0,
      headlineLearnedCount: 0,
    });
  });
});
