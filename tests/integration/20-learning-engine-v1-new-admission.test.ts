import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { NEW_ADMISSION_TESTER_A, NEW_ADMISSION_TESTER_B, NEW_ADMISSION_TESTER_C, type TesterIdentity } from "./fixtures/identities";
import { createAdminClient } from "./admin-client";
import { createTesterClient } from "./tester-client";

const { claimNextLearningEngineCard } = await import("@/lib/learning-engine/runtime/claim-next-card");

/**
 * Integration tests for the Alpha pre-launch correction to Learning
 * Engine v1 NEW-card admission: uniform-random-without-replacement over
 * the WHOLE reservoir, replacing the old sort_order-first prefix
 * (lib/learning-engine/active-pool.ts's selectNewAdmissionCandidates).
 *
 * Exercises the REAL local claim pipeline end-to-end (claimNextLearningEngineCard
 * -> chooseNextCard -> the trusted claim RPC), same pattern as
 * 15-learning-engine-v1-rc-b-claim.test.ts, against the real official
 * Swahili Basics starter deck. Uses disposable 9xx testers only
 * (NEW_ADMISSION_TESTER_A/B/C, public_user_id 928-930) -- never tester
 * 951, which this task is explicitly forbidden from touching.
 *
 * A scripted (LCG) RandomSource is injected for every claim here, never
 * the production Math.random default -- per this task's own instruction
 * not to make this test probabilistically flaky. The "divergence from
 * canonical sort_order" and "admits outside the first six positions"
 * assertions below are therefore deterministic facts about these specific
 * scripted seeds, not statistical luck.
 */
const SWAHILI_BASICS_DECK_ID = "baff1099-c438-5501-887b-6edf33882794";

function makeLcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

interface ProvisionedOnSwahili {
  readonly identity: TesterIdentity;
  readonly userId: string;
  readonly client: Awaited<ReturnType<typeof createTesterClient>>;
  readonly deckId: string;
}

async function provisionOnSwahili(identity: TesterIdentity): Promise<ProvisionedOnSwahili> {
  const client = await createTesterClient(identity.email, identity.password);
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) {
    throw new Error(`provisionOnSwahili: failed to resolve authenticated user for ${identity.email}`, { cause: userError });
  }

  const { data: duplicatedDeck, error: duplicateError } = await client.rpc("duplicate_starter_deck", {
    p_source_deck_id: SWAHILI_BASICS_DECK_ID,
  });
  if (duplicateError) {
    throw new Error(`provisionOnSwahili: duplicate_starter_deck failed for ${identity.email}`, { cause: duplicateError });
  }

  return { identity, userId: userData.user.id, client, deckId: (duplicatedDeck as { id: string }).id };
}

async function startV1Session(tester: ProvisionedOnSwahili): Promise<string> {
  const { data, error } = await tester.client.rpc("start_or_resume_session", { p_deck_id: tester.deckId });
  if (error) throw error;
  const sessionId = (data as { id: string }).id;

  const admin = createAdminClient();
  const { error: updateError } = await admin.from("sessions").update({ engine_version: "v1" }).eq("id", sessionId);
  if (updateError) throw updateError;

  return sessionId;
}

async function admittedFreshSortOrders(admin: ReturnType<typeof createAdminClient>, tester: ProvisionedOnSwahili): Promise<number[]> {
  const { data, error } = await admin
    .from("user_card_progress")
    .select("pool_status, cards!inner(sort_order, deck_id)")
    .eq("user_id", tester.userId)
    .eq("pool_status", "ACTIVE");
  if (error) throw error;

  const rows = (data ?? []) as unknown as readonly { cards: { sort_order: number; deck_id: string } }[];
  return rows
    .filter((row) => row.cards.deck_id === tester.deckId)
    .map((row) => row.cards.sort_order)
    .sort((a, b) => a - b);
}

describe("Learning Engine v1 -- randomized NEW-card admission (Alpha pre-launch correction, real local Supabase)", () => {
  let testerA: ProvisionedOnSwahili;
  let testerB: ProvisionedOnSwahili;
  let testerC: ProvisionedOnSwahili;
  let sessionAId: string;
  let sessionBId: string;
  let sessionCId: string;

  beforeAll(async () => {
    await resetTesterLearnerData(NEW_ADMISSION_TESTER_A);
    await resetTesterLearnerData(NEW_ADMISSION_TESTER_B);
    await resetTesterLearnerData(NEW_ADMISSION_TESTER_C);

    testerA = await provisionOnSwahili(NEW_ADMISSION_TESTER_A);
    testerB = await provisionOnSwahili(NEW_ADMISSION_TESTER_B);
    testerC = await provisionOnSwahili(NEW_ADMISSION_TESTER_C);

    sessionAId = await startV1Session(testerA);
    sessionBId = await startV1Session(testerB);
    sessionCId = await startV1Session(testerC);
  });

  afterAll(async () => {
    await resetTesterLearnerData(NEW_ADMISSION_TESTER_A);
    await resetTesterLearnerData(NEW_ADMISSION_TESTER_B);
    await resetTesterLearnerData(NEW_ADMISSION_TESTER_C);
  });

  it("official Swahili Basics starter deck retains its canonical sort_order (60 cards, 0-59, content untouched)", async () => {
    const admin = createAdminClient();
    const { data: cards, error } = await admin
      .from("cards")
      .select("front, back, sort_order")
      .eq("deck_id", SWAHILI_BASICS_DECK_ID)
      .is("deleted_at", null)
      .order("sort_order", { ascending: true });
    if (error) throw error;

    expect(cards).toHaveLength(60);
    expect(cards!.map((c) => c.sort_order)).toEqual(Array.from({ length: 60 }, (_, i) => i));
    // Spot-check the exact first-six words this suite's own earlier
    // behavioral audit observed under the OLD deterministic algorithm --
    // still the canonical sort_order content, just no longer admission
    // priority.
    expect(cards!.slice(0, 6).map((c) => c.front)).toEqual(["maji", "chakula", "mkate", "maziwa", "yai", "wali"]);
  });

  it("three disposable testers duplicating the same Swahili deck can receive different Fresh admission sets, including cards outside the first six sort_order positions", async () => {
    const resultA = await claimNextLearningEngineCard(testerA.userId, sessionAId, makeLcg(1));
    const resultB = await claimNextLearningEngineCard(testerB.userId, sessionBId, makeLcg(55_555));
    const resultC = await claimNextLearningEngineCard(testerC.userId, sessionCId, makeLcg(999_999));

    expect(resultA.cardId).not.toBeNull();
    expect(resultB.cardId).not.toBeNull();
    expect(resultC.cardId).not.toBeNull();

    const admin = createAdminClient();
    const ordersA = await admittedFreshSortOrders(admin, testerA);
    const ordersB = await admittedFreshSortOrders(admin, testerB);
    const ordersC = await admittedFreshSortOrders(admin, testerC);

    // Each user has exactly <= 6 Fresh admitted at startup (a fresh
    // 60-card deck admits exactly 6 -- Fresh/Active headroom both allow it).
    for (const orders of [ordersA, ordersB, ordersC]) {
      expect(orders.length).toBeLessThanOrEqual(6);
      expect(orders).toHaveLength(6);
      // No duplicate admission within one user's own Fresh set.
      expect(new Set(orders).size).toBe(6);
    }

    const sortOrderFirstSix = [0, 1, 2, 3, 4, 5];
    const allSets = [ordersA, ordersB, ordersC];

    // Real proof this run did not fall back to deterministic
    // sort_order-first admission: at least one tester's admitted set
    // differs from the canonical first-six, and at least one admitted a
    // card outside the first six sort_order positions entirely.
    expect(allSets.some((orders) => JSON.stringify(orders) !== JSON.stringify(sortOrderFirstSix))).toBe(true);
    expect(allSets.some((orders) => orders.some((pos) => pos >= 6))).toBe(true);
  });

  it("reload/resume preserves the admitted Fresh set -- a second claim call for the same session returns the SAME open claim unchanged", async () => {
    const admin = createAdminClient();
    const beforeOrders = await admittedFreshSortOrders(admin, testerA);
    expect(beforeOrders).toHaveLength(6);

    const first = await claimNextLearningEngineCard(testerA.userId, sessionAId, makeLcg(2));
    // "Reload" = calling claimNextLearningEngineCard again for the SAME
    // session, with a DIFFERENT RandomSource -- proving stability comes
    // from the already-OPEN claim fast path, not from reusing the same
    // random sequence.
    const reloaded = await claimNextLearningEngineCard(testerA.userId, sessionAId, makeLcg(777_777));

    expect(reloaded.reused).toBe(true);
    expect(reloaded.claimId).toBe(first.claimId);
    expect(reloaded.cardId).toBe(first.cardId);

    const afterOrders = await admittedFreshSortOrders(admin, testerA);
    expect(afterOrders).toEqual(beforeOrders);
  });

  it("first-pass presentation still uses the normal shuffled queue, and no duplicate admission occurred", async () => {
    const admin = createAdminClient();

    const { data: claim, error: claimError } = await admin
      .from("selection_claims")
      .select("card_id, selection_trace_id")
      .eq("session_id", sessionBId)
      .eq("status", "OPEN")
      .maybeSingle();
    if (claimError) throw claimError;
    expect(claim).not.toBeNull();

    const { data: trace, error: traceError } = await admin
      .from("learning_engine_selection_traces")
      .select("selection_reason, admitted_card_ids")
      .eq("id", claim!.selection_trace_id)
      .maybeSingle();
    if (traceError) throw traceError;

    // The very first claim on a fresh deck is always served from the
    // first-pass batch -- the claimed card must be one of this decision's
    // own admitted cards (never a card admitted in some other decision).
    expect(trace?.selection_reason).toBe("active_first_pass");
    expect(trace?.admitted_card_ids).toContain(claim!.card_id);

    // No duplicate admission: every admitted card id for testerB is
    // distinct (re-asserts the earlier sort_order-based distinctness
    // check, this time directly against card_id).
    const { data: progress, error: progressError } = await admin
      .from("user_card_progress")
      .select("card_id, cards!inner(deck_id)")
      .eq("user_id", testerB.userId)
      .eq("pool_status", "ACTIVE");
    if (progressError) throw progressError;
    const ownDeckCardIds = (progress as unknown as { card_id: string; cards: { deck_id: string } }[])
      .filter((row) => row.cards.deck_id === testerB.deckId)
      .map((row) => row.card_id);
    expect(new Set(ownDeckCardIds).size).toBe(ownDeckCardIds.length);
  });
});
