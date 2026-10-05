import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Exercises lib/decks/dal.ts's P3 Decks additions' *call contract* against
 * a mocked Supabase client -- not real RLS/database behavior, which
 * requires a running local Supabase stack (covered separately by
 * tests/integration/12-deck-selection.test.ts). Mirrors
 * tests/unit/sessions-dal.test.ts's conventions.
 */
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { getOwnedDecksWithCardCounts, getDeckDetail, listCardsForDeck, getDeckProgressByDeck, selectDeck } =
  await import("@/lib/decks/dal");

afterEach(() => {
  vi.clearAllMocks();
});

/** A minimal fake query builder good for exactly one `.from()` call's chain. */
function makeChain(result: { data: unknown; error: unknown; count?: number }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  const methods = ["select", "eq", "is", "in", "order", "limit"];
  for (const method of methods) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    };
  }
  chain.maybeSingle = (...args: unknown[]) => {
    calls.push({ method: "maybeSingle", args });
    return Promise.resolve(result);
  };
  // Bare `await` on the chain itself (no terminal method call), used by
  // list-style queries (.order() is the last call before awaiting).
  (chain as unknown as { then: PromiseLike<unknown>["then"] }).then = (...args) =>
    Promise.resolve(result).then(...args);
  return { chain, calls };
}

describe("getOwnedDecksWithCardCounts", () => {
  it("filters to is_official=false, non-deleted decks, ordered by sort_order then created_at", async () => {
    const decksChain = makeChain({ data: [], error: null });
    const from = vi.fn().mockReturnValue(decksChain.chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await getOwnedDecksWithCardCounts();

    expect(from).toHaveBeenCalledWith("decks");
    const eqCalls = decksChain.calls.filter((c) => c.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["is_official", false] });
    const isCalls = decksChain.calls.filter((c) => c.method === "is");
    expect(isCalls).toContainEqual({ method: "is", args: ["deleted_at", null] });
    const orderCalls = decksChain.calls.filter((c) => c.method === "order");
    expect(orderCalls).toEqual([
      { method: "order", args: ["sort_order", { ascending: true }] },
      { method: "order", args: ["created_at", { ascending: true }] },
    ]);
  });

  it("returns an empty list with no per-deck card-count queries when the caller owns no decks (the one Mastered-counts-by-deck query still runs)", async () => {
    const decksChain = makeChain({ data: [], error: null });
    const from = vi.fn().mockReturnValue(decksChain.chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await expect(getOwnedDecksWithCardCounts()).resolves.toEqual([]);
    // 1 for `decks`, 1 for getMasteredCountsByDeck()'s single `user_card_progress` query -- never one per deck.
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("attaches a real card count (head-count query per deck) and a current Mastered count (one query total)", async () => {
    const decksChain = makeChain({
      data: [
        { id: "deck-1", name: "Deck One", description: null },
        { id: "deck-2", name: "Deck Two", description: "desc" },
      ],
      error: null,
    });
    const cardsChain1 = makeChain({ data: null, error: null, count: 3 });
    const cardsChain2 = makeChain({ data: null, error: null, count: 0 });
    const masteredChain = makeChain({
      data: [
        { cards: { deck_id: "deck-1", deleted_at: null } },
        { cards: { deck_id: "deck-1", deleted_at: null } },
      ],
      error: null,
    });

    const from = vi
      .fn()
      .mockReturnValueOnce(decksChain.chain)
      .mockReturnValueOnce(cardsChain1.chain)
      .mockReturnValueOnce(cardsChain2.chain)
      .mockReturnValueOnce(masteredChain.chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await expect(getOwnedDecksWithCardCounts()).resolves.toEqual([
      { id: "deck-1", name: "Deck One", description: null, cardCount: 3, masteredCount: 2 },
      { id: "deck-2", name: "Deck Two", description: "desc", cardCount: 0, masteredCount: 0 },
    ]);

    const cardsCall1SelectArgs = cardsChain1.calls.find((c) => c.method === "select")?.args;
    expect(cardsCall1SelectArgs?.[1]).toEqual({ count: "exact", head: true });
    expect(cardsChain1.calls).toContainEqual({ method: "eq", args: ["deck_id", "deck-1"] });
    expect(cardsChain2.calls).toContainEqual({ method: "eq", args: ["deck_id", "deck-2"] });
    expect(masteredChain.calls).toContainEqual({ method: "eq", args: ["card_status", "LEARNED"] });
  });

  it("throws a server-safe error on a genuine DB failure", async () => {
    const dbError = { message: "connection reset", code: "08006" };
    const decksChain = makeChain({ data: null, error: dbError });
    const from = vi.fn().mockReturnValue(decksChain.chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await expect(getOwnedDecksWithCardCounts()).rejects.toMatchObject({
      message: expect.not.stringContaining("connection reset"),
      cause: dbError,
    });
  });
});

describe("getDeckDetail", () => {
  it("returns null for a nonexistent/inaccessible deck without a distinct error", async () => {
    const deckChain = makeChain({ data: null, error: null });
    const from = vi.fn().mockReturnValue(deckChain.chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await expect(getDeckDetail("deck-1")).resolves.toBeNull();
    // No card-count query is issued for a deck that was never found.
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("returns full deck detail plus a real card count when found", async () => {
    const deckChain = makeChain({
      data: {
        id: "deck-1",
        name: "Deck One",
        description: "desc",
        is_official: false,
        owner_user_id: "user-1",
      },
      error: null,
    });
    const cardsChain = makeChain({ data: null, error: null, count: 42 });
    const from = vi.fn().mockReturnValueOnce(deckChain.chain).mockReturnValueOnce(cardsChain.chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await expect(getDeckDetail("deck-1")).resolves.toEqual({
      id: "deck-1",
      name: "Deck One",
      description: "desc",
      isOfficial: false,
      ownerUserId: "user-1",
      cardCount: 42,
    });
  });

  it("throws a server-safe error on a genuine DB failure", async () => {
    const dbError = { message: "connection reset", code: "08006" };
    const deckChain = makeChain({ data: null, error: dbError });
    const from = vi.fn().mockReturnValue(deckChain.chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await expect(getDeckDetail("deck-1")).rejects.toMatchObject({
      message: expect.not.stringContaining("connection reset"),
      cause: dbError,
    });
  });
});

describe("listCardsForDeck", () => {
  it("filters by deck_id and deleted_at is null, ordered by sort_order", async () => {
    const chain = makeChain({ data: [], error: null });
    const from = vi.fn().mockReturnValue(chain.chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await listCardsForDeck("deck-1");

    expect(from).toHaveBeenCalledWith("cards");
    expect(chain.calls).toContainEqual({ method: "eq", args: ["deck_id", "deck-1"] });
    expect(chain.calls).toContainEqual({ method: "is", args: ["deleted_at", null] });
    expect(chain.calls).toContainEqual({ method: "order", args: ["sort_order", { ascending: true }] });
  });

  it("returns front/back cards with each card's own cardStatus and learningStage (defaulting to NEW/null when no progress row exists)", async () => {
    const rows = [
      {
        id: "card-1",
        front: "abundant",
        back: "豊富な",
        user_card_progress: [{ card_status: "LEARNING", learning_stage: "FRESH" }],
      },
      { id: "card-2", front: "ambiguous", back: "曖昧な", user_card_progress: [] },
    ];
    const chain = makeChain({ data: rows, error: null });
    const from = vi.fn().mockReturnValue(chain.chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await expect(listCardsForDeck("deck-1")).resolves.toEqual([
      { id: "card-1", front: "abundant", back: "豊富な", cardStatus: "LEARNING", learningStage: "FRESH" },
      { id: "card-2", front: "ambiguous", back: "曖昧な", cardStatus: "NEW", learningStage: null },
    ]);
  });

  it("returns an empty list (not an error) for an inaccessible deck", async () => {
    const chain = makeChain({ data: [], error: null });
    const from = vi.fn().mockReturnValue(chain.chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await expect(listCardsForDeck("deck-1")).resolves.toEqual([]);
  });
});

describe("getDeckProgressByDeck", () => {
  it("returns an empty map with no query at all for an empty deckIds list", async () => {
    const from = vi.fn();
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await expect(getDeckProgressByDeck([])).resolves.toEqual(new Map());
    expect(from).not.toHaveBeenCalled();
  });

  it("issues exactly one query for any number of deck ids, grouping each card by its own deck_id", async () => {
    const rows = [
      { deck_id: "deck-1", user_card_progress: [{ card_status: "LEARNED", learning_stage: null }] },
      { deck_id: "deck-1", user_card_progress: [] },
      { deck_id: "deck-2", user_card_progress: [{ card_status: "LEARNING", learning_stage: "FRESH" }] },
    ];
    const chain = makeChain({ data: rows, error: null });
    const from = vi.fn().mockReturnValue(chain.chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    const result = await getDeckProgressByDeck(["deck-1", "deck-2"]);

    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("cards");
    expect(chain.calls).toContainEqual({ method: "in", args: ["deck_id", ["deck-1", "deck-2"]] });
    expect(chain.calls).toContainEqual({ method: "is", args: ["deleted_at", null] });
    // deck-1: LEARNED (1.00) + NEW (0.00) averaged over 2 cards = 0.50.
    expect(result.get("deck-1")).toEqual({ kind: "ok", progress: 0.5 });
    // deck-2: LEARNING+FRESH (0.10) over 1 card.
    expect(result.get("deck-2")).toEqual({ kind: "ok", progress: 0.1 });
  });

  it("returns 'empty' for a requested deck id with no live cards at all", async () => {
    const chain = makeChain({ data: [], error: null });
    const from = vi.fn().mockReturnValue(chain.chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    const result = await getDeckProgressByDeck(["deck-1"]);

    expect(result.get("deck-1")).toEqual({ kind: "empty" });
  });
});

describe("selectDeck", () => {
  it("calls select_deck with p_deck_id", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "deck-1", name: "Deck One" }, error: null });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await selectDeck("deck-1");

    expect(rpc).toHaveBeenCalledWith("select_deck", { p_deck_id: "deck-1" });
  });

  it("returns the RPC's data on success", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "deck-1", name: "Deck One" }, error: null });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await expect(selectDeck("deck-1")).resolves.toEqual({ id: "deck-1", name: "Deck One" });
  });

  it("throws a server-safe error (raw error only in cause) on RPC failure", async () => {
    const dbError = { message: "deck deck-1 does not belong to caller, or is deleted/archived", code: "42501" };
    const rpc = vi.fn().mockResolvedValue({ data: null, error: dbError });
    vi.mocked(createClient).mockResolvedValue({ rpc } as never);

    await expect(selectDeck("deck-1")).rejects.toMatchObject({
      message: expect.not.stringContaining("does not belong to caller"),
      cause: dbError,
    });
  });
});
