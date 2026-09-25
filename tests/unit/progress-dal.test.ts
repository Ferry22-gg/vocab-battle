import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryChainMock } from "./helpers";

/**
 * These tests exercise lib/learning/progress-dal.ts's *call contract*
 * (which table/columns/filters/ordering it uses, and how it shapes the
 * result) against a mocked query builder -- not real RLS/database
 * behavior, which requires a running local Supabase stack (unavailable in
 * this environment: `pnpm exec supabase status` reports no Docker/Podman).
 * See the Phase D2 report for what the later submitAnswer() integration
 * phase should additionally cover against a real database (RLS scoping,
 * cross-user isolation, etc.).
 */
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { getCardProgress, getRecentAnswerHistory } = await import("@/lib/learning/progress-dal");
const { RATING_CONFIG } = await import("@/lib/learning/config");

afterEach(() => {
  vi.clearAllMocks();
});

describe("getCardProgress", () => {
  it("selects the expected columns and filters by card_id only (no client-supplied user id)", async () => {
    const { chain, calls } = createQueryChainMock({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await getCardProgress("card-1");

    const fromCall = calls.find((c) => c.method === "select");
    expect(fromCall?.args[0]).toContain("card_status");
    expect(fromCall?.args[0]).toContain("fsrs_due_at");
    expect(fromCall?.args[0]).toContain("fsrs_last_review_at");

    const eqCalls = calls.filter((c) => c.method === "eq");
    expect(eqCalls).toEqual([{ method: "eq", args: ["card_id", "card-1"] }]);

    expect(calls.some((c) => c.method === "maybeSingle")).toBe(true);
  });

  it("returns null when no progress row is found (or not RLS-visible)", async () => {
    const { chain } = createQueryChainMock({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getCardProgress("card-1")).resolves.toBeNull();
  });

  it("returns the row shaped as CardProgressRow when found", async () => {
    const row = {
      card_status: "LEARNING",
      seen_count: 3,
      correct_streak: 2,
      wrong_streak: 0,
      fsrs_due_at: null,
      fsrs_stability: null,
      fsrs_difficulty: null,
      fsrs_elapsed_days: 0,
      fsrs_scheduled_days: 0,
      fsrs_reps: 0,
      fsrs_lapses: 0,
      fsrs_learning_steps: 0,
      fsrs_state: null,
      fsrs_last_review_at: null,
    };
    const { chain } = createQueryChainMock({ data: row, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getCardProgress("card-1")).resolves.toEqual(row);
  });

  it("throws a server-safe error (raw error only in cause) on a genuine DB failure", async () => {
    const dbError = { message: "connection reset", code: "08006" };
    const { chain } = createQueryChainMock({ data: null, error: dbError });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getCardProgress("card-1")).rejects.toMatchObject({
      message: expect.not.stringContaining("connection reset"),
      cause: dbError,
    });
  });
});

describe("getRecentAnswerHistory", () => {
  it("orders newest-first by answered_at (with id as a deterministic tiebreaker) and limits to EASY_STABLE_HISTORY_LENGTH", async () => {
    const { chain, calls } = createQueryChainMock({ data: [], error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await getRecentAnswerHistory("card-1");

    const orderCalls = calls.filter((c) => c.method === "order");
    expect(orderCalls[0]?.args).toEqual(["answered_at", { ascending: false }]);
    expect(orderCalls[1]?.args).toEqual(["id", { ascending: false }]);

    const limitCall = calls.find((c) => c.method === "limit");
    expect(limitCall?.args[0]).toBe(RATING_CONFIG.EASY_STABLE_HISTORY_LENGTH);

    const eqCalls = calls.filter((c) => c.method === "eq");
    expect(eqCalls).toEqual([{ method: "eq", args: ["card_id", "card-1"] }]);
  });

  it("maps rows to a most-recent-first boolean array", async () => {
    const { chain } = createQueryChainMock({
      data: [{ correct: true }, { correct: false }, { correct: true }],
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getRecentAnswerHistory("card-1")).resolves.toEqual([true, false, true]);
  });

  it("returns an empty array for a card with no answer history", async () => {
    const { chain } = createQueryChainMock({ data: [], error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getRecentAnswerHistory("card-1")).resolves.toEqual([]);
  });

  it("returns an empty array when data is null (defensive, matches Supabase's possible shape)", async () => {
    const { chain } = createQueryChainMock({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getRecentAnswerHistory("card-1")).resolves.toEqual([]);
  });

  it("throws a server-safe error on a genuine DB failure", async () => {
    const dbError = { message: "connection reset", code: "08006" };
    const { chain } = createQueryChainMock({ data: null, error: dbError });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getRecentAnswerHistory("card-1")).rejects.toMatchObject({
      message: expect.not.stringContaining("connection reset"),
      cause: dbError,
    });
  });
});
