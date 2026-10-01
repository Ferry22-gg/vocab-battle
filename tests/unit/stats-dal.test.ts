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
const { getDailyStatsHistory, getMasteredCardCount, getStatsSummary } = await import("@/lib/stats/dal");

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

describe("getStatsSummary", () => {
  it("composes profile stats, daily history, and mastered count into one summary", async () => {
    vi.mocked(getProfileStats).mockResolvedValue({
      level: 3,
      totalXp: 450,
      currentStreak: 5,
      totalEnemiesDefeated: 12,
    });

    const dailyRows = [
      { stat_date: "2026-09-29", enemies_defeated: 2, total_answers: 10, correct_answers: 8, longest_combo: 4 },
      { stat_date: "2026-09-30", enemies_defeated: 1, total_answers: 5, correct_answers: 5, longest_combo: 6 },
    ];
    let call = 0;
    const from = vi.fn().mockImplementation((table: string) => {
      call += 1;
      if (table === "daily_user_stats") {
        return makeChain({ data: dailyRows, error: null }).chain;
      }
      if (table === "user_card_progress") {
        return makeChain({ data: [{ cards: { deleted_at: null } }], error: null }).chain;
      }
      throw new Error(`unexpected table in test: ${table} (call ${call})`);
    });
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    const summary = await getStatsSummary();

    expect(summary.level).toBe(3);
    expect(summary.totalXp).toBe(450);
    expect(summary.currentStreak).toBe(5);
    expect(summary.totalEnemiesDefeated).toBe(12);
    expect(summary.cardsMastered).toBe(1);
    expect(summary.accuracyPercent).toBe(Math.round((13 / 15) * 100));
    expect(summary.bestCombo).toBe(6);
    expect(summary.weeklyActivity).toHaveLength(7);
  });

  it("produces safe empty-state values for a brand-new tester with no history", async () => {
    vi.mocked(getProfileStats).mockResolvedValue({
      level: 1,
      totalXp: 0,
      currentStreak: 0,
      totalEnemiesDefeated: 0,
    });

    const from = vi.fn().mockImplementation((table: string) => {
      if (table === "daily_user_stats") return makeChain({ data: [], error: null }).chain;
      if (table === "user_card_progress") return makeChain({ data: [], error: null }).chain;
      throw new Error(`unexpected table: ${table}`);
    });
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    const summary = await getStatsSummary();

    expect(summary.cardsMastered).toBe(0);
    expect(summary.accuracyPercent).toBeNull();
    expect(summary.bestCombo).toBeNull();
    expect(summary.weeklyActivity.every((d) => d.enemiesDefeated === 0)).toBe(true);
  });
});
