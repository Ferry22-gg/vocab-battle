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
const {
  startOrResumeSession,
  finishSession,
  getActiveSessionById,
  getActiveSessionForCurrentUser,
  getNextSessionCard,
} = await import("@/lib/sessions/dal");

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
      current_enemy_max_hp: 110,
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

describe("getActiveSessionForCurrentUser", () => {
  it("filters by status=active only, with no id filter, scoped otherwise by RLS", async () => {
    const { chain, calls } = createQueryChainMock({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await getActiveSessionForCurrentUser();

    const eqCalls = calls.filter((c) => c.method === "eq");
    expect(eqCalls).toEqual([{ method: "eq", args: ["status", "active"] }]);
    expect(calls.some((c) => c.method === "maybeSingle")).toBe(true);
  });

  it("returns null when the caller has no active session", async () => {
    const { chain } = createQueryChainMock({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getActiveSessionForCurrentUser()).resolves.toBeNull();
  });

  it("returns the row when the caller has an active session", async () => {
    const { chain } = createQueryChainMock({ data: { id: "session-1" }, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getActiveSessionForCurrentUser()).resolves.toEqual({ id: "session-1" });
  });

  it("throws a server-safe error on a genuine DB failure", async () => {
    const dbError = { message: "connection reset", code: "08006" };
    const { chain } = createQueryChainMock({ data: null, error: dbError });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getActiveSessionForCurrentUser()).rejects.toMatchObject({
      message: expect.not.stringContaining("connection reset"),
      cause: dbError,
    });
  });
});

describe("getNextSessionCard", () => {
  it("calls get_next_session_card with p_session_id and no other parameter", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "not_found" }, error: null });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await getNextSessionCard("session-1");

    expect(rpc).toHaveBeenCalledWith("get_next_session_card", { p_session_id: "session-1" });
  });

  it("throws a server-safe error (raw error only in cause) on RPC failure", async () => {
    const dbError = { message: "permission denied for function get_next_session_card", code: "42501" };
    const rpc = vi.fn().mockResolvedValue({ data: null, error: dbError });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await expect(getNextSessionCard("session-1")).rejects.toMatchObject({
      message: expect.not.stringContaining("permission denied"),
      cause: dbError,
    });
  });

  it("returns status: not_found as-is", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "not_found" }, error: null });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await expect(getNextSessionCard("session-1")).resolves.toEqual({ status: "not_found" });
  });

  it("returns a recognized no_card reason as-is", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: { status: "no_card", reason: "LEARNING_ALL_ON_COOLDOWN" }, error: null });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await expect(getNextSessionCard("session-1")).resolves.toEqual({
      status: "no_card",
      reason: "LEARNING_ALL_ON_COOLDOWN",
    });
  });

  it("returns a recognized error reason as-is", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: { status: "error", reason: "SESSION_MISSING_BATTLE_STATE" }, error: null });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await expect(getNextSessionCard("session-1")).resolves.toEqual({
      status: "error",
      reason: "SESSION_MISSING_BATTLE_STATE",
    });
  });

  it("normalizes a well-formed ok result into camelCase fields", async () => {
    const okRow = {
      status: "ok",
      session_id: "session-1",
      session_mode: "learning",
      card_id: "card-1",
      front: "ubiquitous",
      back: "遍在する",
      enemy_type: "enemy_b",
      enemy_hp: 50,
      enemy_max_hp: 110,
      combo: 3,
    };
    const rpc = vi.fn().mockResolvedValue({ data: okRow, error: null });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await expect(getNextSessionCard("session-1")).resolves.toEqual({
      status: "ok",
      sessionId: "session-1",
      sessionMode: "learning",
      cardId: "card-1",
      front: "ubiquitous",
      back: "遍在する",
      enemyType: "enemy_b",
      enemyHp: 50,
      enemyMaxHp: 110,
      combo: 3,
    });
  });

  it("throws on a malformed ok result (missing required field) rather than reaching the UI", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        status: "ok",
        session_id: "session-1",
        session_mode: "learning",
        card_id: "card-1",
        front: "ubiquitous",
        // back is missing
        enemy_type: "enemy_b",
        enemy_hp: 50,
        enemy_max_hp: 110,
        combo: 3,
      },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await expect(getNextSessionCard("session-1")).rejects.toThrow(/malformed "ok" result/);
  });

  it("throws on an unrecognized status rather than reaching the UI", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "something_new" }, error: null });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await expect(getNextSessionCard("session-1")).rejects.toThrow(/unrecognized status/);
  });

  it("throws on an unrecognized no_card reason rather than reaching the UI", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "no_card", reason: "SOMETHING_NEW" }, error: null });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await expect(getNextSessionCard("session-1")).rejects.toThrow(/unrecognized no_card reason/);
  });

  it("throws when the RPC result is not a JSON object at all", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "not an object", error: null });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await expect(getNextSessionCard("session-1")).rejects.toThrow(/not a JSON object/);
  });
});
