import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryChainMock } from "./helpers";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { getProfileStats } = await import("@/lib/profile/dal");

afterEach(() => {
  vi.clearAllMocks();
});

describe("getProfileStats", () => {
  it("reads total_xp/level/current_streak/longest_streak/total_enemies_defeated/selected_deck_id and maps them", async () => {
    const { chain } = createQueryChainMock({
      data: {
        total_xp: 450,
        level: 3,
        current_streak: 5,
        longest_streak: 9,
        total_enemies_defeated: 12,
        selected_deck_id: "deck-1",
      },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getProfileStats()).resolves.toEqual({
      totalXp: 450,
      level: 3,
      currentStreak: 5,
      longestStreak: 9,
      totalEnemiesDefeated: 12,
      selectedDeckId: "deck-1",
    });
  });

  it("throws (invariant violation) rather than silently zeroing stats when no profile row exists", async () => {
    const { chain } = createQueryChainMock({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getProfileStats()).rejects.toThrow(/no profile row/);
  });

  it("throws a server-safe error (raw error only in cause) on query failure", async () => {
    const dbError = { message: "connection reset", code: "08006" };
    const { chain } = createQueryChainMock({ data: null, error: dbError });
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never);

    await expect(getProfileStats()).rejects.toMatchObject({
      message: expect.not.stringContaining("connection reset"),
      cause: dbError,
    });
  });
});
