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
 *
 * The end-to-end timestamp-normalization test below imports the real
 * (unmocked) lib/learning/fsrs.ts, which starts with `import "server-only"`
 * -- this mock is the same test-environment-only shim used throughout this
 * project (see tests/unit/service-role.test.ts), required here even though
 * progress-dal.ts itself has no such import.
 */
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const {
  getCardProgress,
  getRecentAnswerHistory,
  getAnswerEventByClientEventId,
  getXpEventsForAnswerEvent,
} = await import("@/lib/learning/progress-dal");
const { RATING_CONFIG } = await import("@/lib/learning/config");
const { progressToFsrsCard } = await import("@/lib/learning/fsrs");

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

  describe("timestamp normalization (D3b)", () => {
    const rawRow = (overrides: Record<string, unknown>) => ({
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
      ...overrides,
    });

    it("parses a valid ISO fsrs_due_at string into a genuine Date", async () => {
      const { chain } = createQueryChainMock({
        data: rawRow({ fsrs_due_at: "2026-02-01T12:00:00.000Z" }),
        error: null,
      });
      vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

      const progress = await getCardProgress("card-1");

      expect(progress?.fsrs_due_at).toBeInstanceOf(Date);
      expect(progress?.fsrs_due_at?.getTime()).toBe(new Date("2026-02-01T12:00:00.000Z").getTime());
    });

    it("parses a valid ISO fsrs_last_review_at string into a genuine Date", async () => {
      const { chain } = createQueryChainMock({
        data: rawRow({ fsrs_last_review_at: "2026-01-15T09:30:00.000Z" }),
        error: null,
      });
      vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

      const progress = await getCardProgress("card-1");

      expect(progress?.fsrs_last_review_at).toBeInstanceOf(Date);
      expect(progress?.fsrs_last_review_at?.getTime()).toBe(
        new Date("2026-01-15T09:30:00.000Z").getTime(),
      );
    });

    it("preserves null for both timestamp fields (not an Invalid Date, not a fabricated value)", async () => {
      const { chain } = createQueryChainMock({
        data: rawRow({ fsrs_due_at: null, fsrs_last_review_at: null }),
        error: null,
      });
      vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

      const progress = await getCardProgress("card-1");

      expect(progress?.fsrs_due_at).toBeNull();
      expect(progress?.fsrs_last_review_at).toBeNull();
    });

    it("throws rather than returning an Invalid Date for a malformed fsrs_due_at", async () => {
      const { chain } = createQueryChainMock({
        data: rawRow({ fsrs_due_at: "not-a-timestamp" }),
        error: null,
      });
      vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

      await expect(getCardProgress("card-1")).rejects.toThrow(/fsrs_due_at/);
    });

    it("throws rather than returning an Invalid Date for a malformed fsrs_last_review_at", async () => {
      const { chain } = createQueryChainMock({
        data: rawRow({ fsrs_last_review_at: "also-not-a-timestamp" }),
        error: null,
      });
      vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

      await expect(getCardProgress("card-1")).rejects.toThrow(/fsrs_last_review_at/);
    });

    it("hands progressToFsrsCard genuine Date values end-to-end through the real DAL contract", async () => {
      const { chain } = createQueryChainMock({
        data: rawRow({
          fsrs_state: 2,
          fsrs_due_at: "2026-02-01T12:00:00.000Z",
          fsrs_stability: 8.2956,
          fsrs_difficulty: 5.1,
          fsrs_last_review_at: "2026-01-15T09:30:00.000Z",
        }),
        error: null,
      });
      vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

      const progress = await getCardProgress("card-1");
      expect(progress).not.toBeNull();

      // The real (unmocked) fsrs.ts adapter requires genuine Date instances
      // for `due`/`last_review` -- this would misbehave silently (or throw
      // inside ts-fsrs's own date arithmetic) if progress-dal.ts still
      // handed it raw PostgREST strings.
      const card = progressToFsrsCard(progress!, new Date("2026-03-01T00:00:00.000Z"));
      expect(card.due).toBeInstanceOf(Date);
      expect(card.last_review).toBeInstanceOf(Date);
      expect(card.due.getTime()).toBe(new Date("2026-02-01T12:00:00.000Z").getTime());
      expect(card.last_review?.getTime()).toBe(new Date("2026-01-15T09:30:00.000Z").getTime());
    });
  });
});

describe("getAnswerEventByClientEventId", () => {
  it("selects all columns and filters by client_event_id only (no explicit user id -- relies on RLS)", async () => {
    const { chain, calls } = createQueryChainMock({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await getAnswerEventByClientEventId("client-event-1");

    const selectCall = calls.find((c) => c.method === "select");
    expect(selectCall?.args[0]).toBe("*");

    const eqCalls = calls.filter((c) => c.method === "eq");
    expect(eqCalls).toEqual([{ method: "eq", args: ["client_event_id", "client-event-1"] }]);

    expect(calls.some((c) => c.method === "maybeSingle")).toBe(true);
  });

  it("returns null when no matching answer event is found (or not RLS-visible)", async () => {
    const { chain } = createQueryChainMock({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getAnswerEventByClientEventId("client-event-1")).resolves.toBeNull();
  });

  it("returns the row when found", async () => {
    const row = { id: "answer-event-1", session_id: "session-1", card_id: "card-1" };
    const { chain } = createQueryChainMock({ data: row, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getAnswerEventByClientEventId("client-event-1")).resolves.toEqual(row);
  });

  it("throws a server-safe error on a genuine DB failure", async () => {
    const dbError = { message: "connection reset", code: "08006" };
    const { chain } = createQueryChainMock({ data: null, error: dbError });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getAnswerEventByClientEventId("client-event-1")).rejects.toMatchObject({
      message: expect.not.stringContaining("connection reset"),
      cause: dbError,
    });
  });
});

describe("getXpEventsForAnswerEvent", () => {
  it("selects all columns and filters by source_answer_event_id only", async () => {
    const { chain, calls } = createQueryChainMock({ data: [], error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await getXpEventsForAnswerEvent("answer-event-1");

    const selectCall = calls.find((c) => c.method === "select");
    expect(selectCall?.args[0]).toBe("*");

    const eqCalls = calls.filter((c) => c.method === "eq");
    expect(eqCalls).toEqual([{ method: "eq", args: ["source_answer_event_id", "answer-event-1"] }]);
  });

  it("returns the matching rows", async () => {
    const rows = [{ reason: "correct_answer", amount: 2 }];
    const { chain } = createQueryChainMock({ data: rows, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getXpEventsForAnswerEvent("answer-event-1")).resolves.toEqual(rows);
  });

  it("returns an empty array when there are no linked xp events", async () => {
    const { chain } = createQueryChainMock({ data: [], error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getXpEventsForAnswerEvent("answer-event-1")).resolves.toEqual([]);
  });

  it("throws a server-safe error on a genuine DB failure", async () => {
    const dbError = { message: "connection reset", code: "08006" };
    const { chain } = createQueryChainMock({ data: null, error: dbError });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getXpEventsForAnswerEvent("answer-event-1")).rejects.toMatchObject({
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
