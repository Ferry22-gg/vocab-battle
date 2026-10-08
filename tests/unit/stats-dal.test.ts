import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Exercises lib/stats/dal.ts's *call contract* against a mocked Supabase
 * client -- not real RLS/database behavior, which requires a running local
 * Supabase stack (covered separately by tests/integration/13-stats.test.ts).
 * Mirrors tests/unit/decks-dal.test.ts's conventions.
 */
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/profile/dal", () => ({ getProfileStats: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { getProfileStats } = await import("@/lib/profile/dal");
const {
  getDailyStatsHistory,
  getMasteredCardCount,
  getAcquiredCardCount,
  getLearningProgressForDeck,
  getAnswerHistory,
  getStatsSummary,
} = await import("@/lib/stats/dal");

afterEach(() => {
  vi.clearAllMocks();
});

/** A minimal fake query builder good for exactly one `.from()` call's chain. */
function makeChain(result: { data: unknown; error: unknown; count?: number }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  const methods = ["select", "eq", "order"];
  for (const method of methods) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    };
  }
  (chain as unknown as { then: PromiseLike<unknown>["then"] }).then = (...args) =>
    Promise.resolve(result).then(...args);
  return { chain, calls };
}

/**
 * `user_card_progress` is queried three different ways by three different
 * functions (getMasteredCardCount, getAcquiredCardCount,
 * getLearningProgressForDeck), each a SEPARATE `.from("user_card_progress")`
 * call -- this builds a fresh chain per call that returns different fixture
 * data depending on whether/how `.eq("card_status", ...)` was called,
 * mirroring the real distinguishing behavior precisely.
 */
function makeUserCardProgressFrom(fixtures: { masteredData: unknown; acquiredData: unknown; learningProgressData: unknown }) {
  return vi.fn().mockImplementation(() => {
    let status: unknown = null;
    const calls: { method: string; args: unknown[] }[] = [];
    const chain: Record<string, (...args: unknown[]) => unknown> = {
      select: (...args: unknown[]) => {
        calls.push({ method: "select", args });
        return chain;
      },
      eq: (...args: unknown[]) => {
        calls.push({ method: "eq", args });
        if (args[0] === "card_status") status = args[1];
        return chain;
      },
    };
    (chain as unknown as { then: PromiseLike<unknown>["then"] }).then = (...thenArgs) => {
      const data = status === "LEARNED" ? fixtures.masteredData : status === "ACQUIRED" ? fixtures.acquiredData : fixtures.learningProgressData;
      return Promise.resolve({ data, error: null }).then(...thenArgs);
    };
    return chain;
  });
}

describe("getDailyStatsHistory", () => {
  it("reads from daily_user_stats ordered by stat_date ascending, unfiltered by date", async () => {
    const { chain, calls } = makeChain({ data: [], error: null });
    const from = vi.fn().mockReturnValue(chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await getDailyStatsHistory();

    expect(from).toHaveBeenCalledWith("daily_user_stats");
    expect(calls).toContainEqual({ method: "order", args: ["stat_date", { ascending: true }] });
    const eqCalls = calls.filter((c) => c.method === "eq");
    expect(eqCalls).toHaveLength(0);
  });

  it("returns [] rather than null when the tester has no history yet", async () => {
    const { chain } = makeChain({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getDailyStatsHistory()).resolves.toEqual([]);
  });

  it("throws a server-safe error (raw error only in cause) on query failure", async () => {
    const dbError = { message: "connection reset", code: "08006" };
    const { chain } = makeChain({ data: null, error: dbError });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getDailyStatsHistory()).rejects.toMatchObject({
      message: expect.not.stringContaining("connection reset"),
      cause: dbError,
    });
  });
});

describe("getMasteredCardCount", () => {
  it("filters to card_status = LEARNED and excludes soft-deleted cards", async () => {
    const { chain, calls } = makeChain({ data: [], error: null });
    const from = vi.fn().mockReturnValue(chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await getMasteredCardCount();

    expect(from).toHaveBeenCalledWith("user_card_progress");
    expect(calls).toContainEqual({ method: "eq", args: ["card_status", "LEARNED"] });
  });

  it("counts only rows whose joined card is not soft-deleted", async () => {
    const { chain } = makeChain({
      data: [{ cards: { deleted_at: null } }, { cards: { deleted_at: "2026-09-01T00:00:00Z" } }, { cards: { deleted_at: null } }],
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getMasteredCardCount()).resolves.toBe(2);
  });

  it("returns 0 for a tester with no mastered cards", async () => {
    const { chain } = makeChain({ data: [], error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getMasteredCardCount()).resolves.toBe(0);
  });

  it("throws a server-safe error (raw error only in cause) on query failure", async () => {
    const dbError = { message: "connection reset", code: "08006" };
    const { chain } = makeChain({ data: null, error: dbError });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getMasteredCardCount()).rejects.toMatchObject({
      message: expect.not.stringContaining("connection reset"),
      cause: dbError,
    });
  });
});

describe("getAcquiredCardCount", () => {
  it("filters to card_status = ACQUIRED and excludes soft-deleted cards", async () => {
    const { chain, calls } = makeChain({ data: [], error: null });
    const from = vi.fn().mockReturnValue(chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await getAcquiredCardCount();

    expect(from).toHaveBeenCalledWith("user_card_progress");
    expect(calls).toContainEqual({ method: "eq", args: ["card_status", "ACQUIRED"] });
  });

  it("counts only rows whose joined card is not soft-deleted", async () => {
    const { chain } = makeChain({
      data: [{ cards: { deleted_at: null } }, { cards: { deleted_at: "2026-09-01T00:00:00Z" } }],
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getAcquiredCardCount()).resolves.toBe(1);
  });
});

describe("getLearningProgressForDeck", () => {
  it("reads card_status for the tester's own cards and filters to the given deck, excluding soft-deleted cards", async () => {
    const data = [
      { card_status: "NEW", cards: { deck_id: "deck-a", deleted_at: null } },
      { card_status: "LEARNING", cards: { deck_id: "deck-a", deleted_at: null } },
      { card_status: "LEARNED", cards: { deck_id: "deck-b", deleted_at: null } }, // a different (e.g. prior) deck -- excluded
      { card_status: "ACQUIRED", cards: { deck_id: "deck-a", deleted_at: "2026-09-01T00:00:00Z" } }, // soft-deleted -- excluded
    ];
    const { chain } = makeChain({ data, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getLearningProgressForDeck("deck-a")).resolves.toEqual(["NEW", "LEARNING"]);
  });

  it("returns [] for a deck with no cards", async () => {
    const { chain } = makeChain({ data: [], error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getLearningProgressForDeck("deck-a")).resolves.toEqual([]);
  });
});

describe("getAnswerHistory", () => {
  it("reads (answered_at, response_time_ms, card_id, card_status_before, card_status_after) from answer_events, RLS-scoped (no explicit user_id filter)", async () => {
    const { chain, calls } = makeChain({ data: [], error: null });
    const from = vi.fn().mockReturnValue(chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await getAnswerHistory();

    expect(from).toHaveBeenCalledWith("answer_events");
    expect(calls).toContainEqual({
      method: "select",
      args: ["answered_at, response_time_ms, card_id, card_status_before, card_status_after"],
    });
    const eqCalls = calls.filter((c) => c.method === "eq");
    expect(eqCalls).toHaveLength(0);
  });

  it("returns [] rather than null when the tester has no answer history yet", async () => {
    const { chain } = makeChain({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getAnswerHistory()).resolves.toEqual([]);
  });

  it("throws a server-safe error (raw error only in cause) on query failure", async () => {
    const dbError = { message: "connection reset", code: "08006" };
    const { chain } = makeChain({ data: null, error: dbError });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getAnswerHistory()).rejects.toMatchObject({
      message: expect.not.stringContaining("connection reset"),
      cause: dbError,
    });
  });
});

describe("getStatsSummary", () => {
  it("composes every section's read model from the underlying reads", async () => {
    vi.mocked(getProfileStats).mockResolvedValue({
      level: 3,
      totalXp: 450,
      currentStreak: 5,
      longestStreak: 9,
      totalEnemiesDefeated: 12,
      selectedDeckId: "deck-a",
    });

    const dailyRows = [
      { stat_date: "2026-09-29", total_answers: 10, correct_answers: 8, longest_combo: 4, xp_gained: 20 },
      { stat_date: "2026-09-30", total_answers: 5, correct_answers: 5, longest_combo: 6, xp_gained: 50 },
    ];
    const answerHistoryRows = [
      { answered_at: new Date().toISOString(), response_time_ms: 1000, card_id: "x", card_status_before: "LEARNING", card_status_after: "ACQUIRED" },
      { answered_at: "2020-01-01T12:00:00.000Z", response_time_ms: 2000, card_id: "y", card_status_before: "NEW", card_status_after: "LEARNING" },
    ];
    const userCardProgressFrom = makeUserCardProgressFrom({
      masteredData: [{ cards: { deleted_at: null } }],
      acquiredData: [{ cards: { deleted_at: null } }, { cards: { deleted_at: null } }],
      learningProgressData: [
        { card_status: "NEW", cards: { deck_id: "deck-a", deleted_at: null } },
        { card_status: "ACQUIRED", cards: { deck_id: "deck-a", deleted_at: null } },
      ],
    });

    const from = vi.fn().mockImplementation((table: string) => {
      if (table === "daily_user_stats") return makeChain({ data: dailyRows, error: null }).chain;
      if (table === "answer_events") return makeChain({ data: answerHistoryRows, error: null }).chain;
      if (table === "user_card_progress") return userCardProgressFrom();
      throw new Error(`unexpected table in test: ${table}`);
    });
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    const summary = await getStatsSummary();

    // Top summary
    expect(summary.level).toBe(3);
    expect(summary.totalXp).toBe(450);
    expect(summary.currentStreak).toBe(5);

    // Today (todayRow matched by stat_date === today, via the real answer with today's timestamp)
    expect(summary.todayWordsStudied).toBe(1); // card "x", answered today
    expect(summary.todayWordsLearned).toBe(1); // card "x" transitioned into ACQUIRED today
    expect(summary.todayStudyTimeMs).toBe(1000); // only today's row

    // Learning Progress (deck-a)
    expect(summary.learningProgress).toEqual({
      totalCards: 2,
      newCount: 1,
      learningCount: 0,
      learnedCount: 1,
      masteredCount: 0,
      headlineLearnedCount: 1,
    });

    // This Week / Personal Best
    expect(summary.weeklyActivity).toHaveLength(7);
    expect(summary.bestCombo).toBe(6);
    expect(summary.longestStreak).toBe(9);
    expect(summary.mostAnswersInADay).toBe(10);
    expect(summary.mostXpInADay).toBe(50);

    // Lifetime
    expect(summary.totalAnswers).toBe(15);
    expect(summary.wordsLearnedLifetime).toBe(2);
    expect(summary.wordsMasteredLifetime).toBe(1);
    expect(summary.studyDays).toBe(2);
    expect(summary.totalEnemiesDefeated).toBe(12);
    expect(summary.lifetimeStudyTimeMs).toBe(3000); // both rows

    // Internal only
    expect(summary.accuracyPercent).toBe(Math.round((13 / 15) * 100));
  });

  it("produces safe empty-state values for a brand-new tester with no history", async () => {
    vi.mocked(getProfileStats).mockResolvedValue({
      level: 1,
      totalXp: 0,
      currentStreak: 0,
      longestStreak: 0,
      totalEnemiesDefeated: 0,
      selectedDeckId: "deck-a",
    });

    const userCardProgressFrom = makeUserCardProgressFrom({
      masteredData: [],
      acquiredData: [],
      learningProgressData: [{ card_status: "NEW", cards: { deck_id: "deck-a", deleted_at: null } }],
    });

    const from = vi.fn().mockImplementation((table: string) => {
      if (table === "daily_user_stats") return makeChain({ data: [], error: null }).chain;
      if (table === "answer_events") return makeChain({ data: [], error: null }).chain;
      if (table === "user_card_progress") return userCardProgressFrom();
      throw new Error(`unexpected table: ${table}`);
    });
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    const summary = await getStatsSummary();

    expect(summary.todayAnswers).toBe(0);
    expect(summary.todayWordsStudied).toBe(0);
    expect(summary.todayWordsLearned).toBe(0);
    expect(summary.todayXp).toBe(0);
    expect(summary.todayStudyTimeMs).toBe(0);
    expect(summary.learningProgress).toEqual({
      totalCards: 1,
      newCount: 1,
      learningCount: 0,
      learnedCount: 0,
      masteredCount: 0,
      headlineLearnedCount: 0,
    });
    expect(summary.wordsLearnedLifetime).toBe(0);
    expect(summary.wordsMasteredLifetime).toBe(0);
    expect(summary.studyDays).toBe(0);
    expect(summary.bestCombo).toBeNull();
    expect(summary.mostAnswersInADay).toBe(0);
    expect(summary.mostXpInADay).toBe(0);
    expect(summary.accuracyPercent).toBeNull();
    expect(summary.weeklyActivity.every((d) => d.answers === 0)).toBe(true);
    expect(summary.lifetimeStudyTimeMs).toBe(0);
  });

  it("learningProgress is null when the tester has no selected deck (defensive edge case)", async () => {
    vi.mocked(getProfileStats).mockResolvedValue({
      level: 1,
      totalXp: 0,
      currentStreak: 0,
      longestStreak: 0,
      totalEnemiesDefeated: 0,
      selectedDeckId: null,
    });

    const userCardProgressFrom = makeUserCardProgressFrom({ masteredData: [], acquiredData: [], learningProgressData: [] });
    const from = vi.fn().mockImplementation((table: string) => {
      if (table === "daily_user_stats") return makeChain({ data: [], error: null }).chain;
      if (table === "answer_events") return makeChain({ data: [], error: null }).chain;
      if (table === "user_card_progress") return userCardProgressFrom();
      throw new Error(`unexpected table: ${table}`);
    });
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    const summary = await getStatsSummary();
    expect(summary.learningProgress).toBeNull();
  });
});
