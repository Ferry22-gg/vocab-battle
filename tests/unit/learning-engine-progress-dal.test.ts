import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Exercises lib/learning-engine/progress/dal.ts's *call contract* against a
 * mocked Supabase client -- not real RLS/database behavior (that needs a
 * running local Supabase stack). Mirrors tests/unit/decks-dal.test.ts's
 * conventions.
 */
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { createClient } = await import("@/lib/supabase/server");
const { isCurrentUserEnrolledInLearningEngineV1 } = await import("@/lib/learning-engine/progress/dal");

afterEach(() => {
  vi.clearAllMocks();
});

function makeChain(result: { data: unknown; error: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  chain.select = (...args: unknown[]) => {
    calls.push({ method: "select", args });
    return chain;
  };
  chain.maybeSingle = (...args: unknown[]) => {
    calls.push({ method: "maybeSingle", args });
    return Promise.resolve(result);
  };
  return { chain, calls };
}

describe("isCurrentUserEnrolledInLearningEngineV1", () => {
  it("reads learning_engine_v1_rollout via the RLS-scoped client, relying on the select_own_or_admin policy -- no explicit userId filter", async () => {
    const chain = makeChain({ data: null, error: null });
    const from = vi.fn().mockReturnValue(chain.chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await isCurrentUserEnrolledInLearningEngineV1();

    expect(from).toHaveBeenCalledWith("learning_engine_v1_rollout");
    expect(chain.calls.some((c) => c.method === "eq")).toBe(false);
  });

  it("returns true when a rollout row exists", async () => {
    const chain = makeChain({ data: { user_id: "user-1" }, error: null });
    const from = vi.fn().mockReturnValue(chain.chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await expect(isCurrentUserEnrolledInLearningEngineV1()).resolves.toBe(true);
  });

  it("returns false when no rollout row exists", async () => {
    const chain = makeChain({ data: null, error: null });
    const from = vi.fn().mockReturnValue(chain.chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await expect(isCurrentUserEnrolledInLearningEngineV1()).resolves.toBe(false);
  });

  it("throws on a query error rather than silently treating it as not-enrolled", async () => {
    const chain = makeChain({ data: null, error: { message: "boom" } });
    const from = vi.fn().mockReturnValue(chain.chain);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    await expect(isCurrentUserEnrolledInLearningEngineV1()).rejects.toThrow();
  });
});
