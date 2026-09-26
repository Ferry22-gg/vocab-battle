import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryChainMock } from "./helpers";

/**
 * These tests exercise lib/sessions/dal.ts's *call contract* against a
 * mocked Supabase client -- not real RLS/database behavior, which
 * requires a running local Supabase stack (unavailable in this
 * environment). See the Phase D2 report for what the later submitAnswer()
 * integration phase should additionally cover against a real database.
 */
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { startOrResumeSession, finishSession, getActiveSessionById } = await import(
  "@/lib/sessions/dal"
);

afterEach(() => {
  vi.clearAllMocks();
});

describe("startOrResumeSession", () => {
  it("calls start_or_resume_session with p_deck_id null when no deck is given", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "session-1" }, error: null });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await startOrResumeSession();

    expect(rpc).toHaveBeenCalledWith("start_or_resume_session", { p_deck_id: null });
  });

  it("forwards an explicit deckId as p_deck_id", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "session-1" }, error: null });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await startOrResumeSession("deck-1");

    expect(rpc).toHaveBeenCalledWith("start_or_resume_session", { p_deck_id: "deck-1" });
  });

  it("returns the RPC's data on success", async () => {
    const sessionRow = { id: "session-1", current_mode: "learning" };
    const rpc = vi.fn().mockResolvedValue({ data: sessionRow, error: null });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await expect(startOrResumeSession()).resolves.toEqual(sessionRow);
  });

  it("throws a server-safe error (raw error only in cause) on RPC failure", async () => {
    const dbError = { message: "deck does not belong to caller", code: "42501" };
    const rpc = vi.fn().mockResolvedValue({ data: null, error: dbError });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await expect(startOrResumeSession()).rejects.toMatchObject({
      message: expect.not.stringContaining("deck does not belong"),
      cause: dbError,
    });
  });
});

describe("finishSession", () => {
  it("calls finish_session with p_session_id", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "session-1" }, error: null });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await finishSession("session-1");

    expect(rpc).toHaveBeenCalledWith("finish_session", { p_session_id: "session-1" });
  });

  it("throws a server-safe error on RPC failure", async () => {
    const dbError = { message: "not owned by the caller", code: "42501" };
    const rpc = vi.fn().mockResolvedValue({ data: null, error: dbError });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await expect(finishSession("session-1")).rejects.toMatchObject({
      message: expect.not.stringContaining("not owned by the caller"),
      cause: dbError,
    });
  });
});

describe("getActiveSessionById", () => {
  it("selects the expected columns and filters by id and status=active only", async () => {
    const { chain, calls } = createQueryChainMock({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await getActiveSessionById("session-1");

    const selectCall = calls.find((c) => c.method === "select");
    expect(selectCall?.args[0]).toContain("current_mode");
    expect(selectCall?.args[0]).toContain("current_combo");
    expect(selectCall?.args[0]).toContain("learning_draw_index");

    const eqCalls = calls.filter((c) => c.method === "eq");
    expect(eqCalls).toEqual([
      { method: "eq", args: ["id", "session-1"] },
      { method: "eq", args: ["status", "active"] },
    ]);

    expect(calls.some((c) => c.method === "maybeSingle")).toBe(true);
  });

  it("returns null for a nonexistent/inaccessible/inactive session (all indistinguishable)", async () => {
    const { chain } = createQueryChainMock({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getActiveSessionById("session-1")).resolves.toBeNull();
  });

  it("returns the row shaped as SessionRow when found", async () => {
    const row = {
      id: "session-1",
      deck_id: "deck-1",
      status: "active",
      current_mode: "learning",
      current_combo: 3,
      current_enemy_type: "enemy_b",
      current_enemy_hp: 50,
      current_enemy_max_hp: 105,
      learning_draw_index: 7,
    };
    const { chain } = createQueryChainMock({ data: row, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getActiveSessionById("session-1")).resolves.toEqual(row);
  });

  it("throws a server-safe error on a genuine DB failure", async () => {
    const dbError = { message: "connection reset", code: "08006" };
    const { chain } = createQueryChainMock({ data: null, error: dbError });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getActiveSessionById("session-1")).rejects.toMatchObject({
      message: expect.not.stringContaining("connection reset"),
      cause: dbError,
    });
  });
});
