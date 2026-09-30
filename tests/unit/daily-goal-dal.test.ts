import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryChainMock } from "./helpers";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { getTodayDailyGoalProgress, DAILY_GOAL_TARGET } = await import("@/lib/learning/daily-goal-dal");

afterEach(() => {
  vi.clearAllMocks();
});

describe("getTodayDailyGoalProgress", () => {
  it("returns the zero/false default when no daily_user_stats row exists yet today", async () => {
    const { chain } = createQueryChainMock({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getTodayDailyGoalProgress()).resolves.toEqual({ enemiesDefeated: 0, completed: false });
  });

  it("caps enemiesDefeated at DAILY_GOAL_TARGET even if the row exceeds it", async () => {
    const { chain } = createQueryChainMock({
      data: { enemies_defeated: 9, daily_goal_completed: true },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getTodayDailyGoalProgress()).resolves.toEqual({
      enemiesDefeated: DAILY_GOAL_TARGET,
      completed: true,
    });
  });

  it("passes through an in-progress count unchanged", async () => {
    const { chain } = createQueryChainMock({
      data: { enemies_defeated: 3, daily_goal_completed: false },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getTodayDailyGoalProgress()).resolves.toEqual({ enemiesDefeated: 3, completed: false });
  });

  it("filters by stat_date only, scoped otherwise entirely by RLS", async () => {
    const { chain, calls } = createQueryChainMock({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await getTodayDailyGoalProgress();

    const eqCalls = calls.filter((c) => c.method === "eq");
    expect(eqCalls).toHaveLength(1);
    expect(eqCalls[0].args[0]).toBe("stat_date");
    expect(eqCalls[0].args[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("throws a server-safe error (raw error only in cause) on query failure", async () => {
    const dbError = { message: "connection reset", code: "08006" };
    const { chain } = createQueryChainMock({ data: null, error: dbError });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getTodayDailyGoalProgress()).rejects.toMatchObject({
      message: expect.not.stringContaining("connection reset"),
      cause: dbError,
    });
  });
});
