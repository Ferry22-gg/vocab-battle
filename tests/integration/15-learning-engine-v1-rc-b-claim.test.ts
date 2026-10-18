import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, type ProvisionedTester } from "./fixtures/provision";
import { RC_B_CLAIM_TESTER_A, RC_B_CLAIM_TESTER_B } from "./fixtures/identities";
import { createAdminClient } from "./admin-client";

const { claimNextLearningEngineCard } = await import("@/lib/learning-engine/runtime/claim-next-card");

/**
 * Integration tests for Learning Engine v1 Runtime Cutover RC-B (the
 * Selection Claim Transaction) against the REAL local Supabase stack.
 *
 * Cross-entity validation, idempotency, and concurrency-serialization at
 * the SQL layer are already exhaustively covered by supabase/tests/
 * 019_learning_engine_v1_runtime_cutover_rc_b_test.sql's 53 pgTAP
 * assertions. This file's job is narrower: prove the TypeScript
 * orchestrator (claimNextLearningEngineCard -- read -> chooseNextCard() ->
 * claim) composes correctly end-to-end against a real database and a
 * real starter deck, including genuine concurrent requests converging on
 * one claim.
 *
 * No live session ever gets engine_version = 'v1' through any real
 * product code path yet (no rollout write path exists) -- this suite sets
 * it directly via the admin client, mirroring supabase/tests/
 * 018_learning_engine_v1_runtime_cutover_rc_a_test.sql's own documented
 * precedent ("schema permits it; no live code sets it yet").
 */
describe("Learning Engine v1 Runtime Cutover RC-B: claimNextLearningEngineCard (real local Supabase)", () => {
  let testerA: ProvisionedTester;
  let testerB: ProvisionedTester;
  let sessionAId: string;
  let sessionBId: string;
  let firstClaimCardId: string | null = null;

  beforeAll(async () => {
    await resetTesterLearnerData(RC_B_CLAIM_TESTER_A);
    await resetTesterLearnerData(RC_B_CLAIM_TESTER_B);
    testerA = await provisionTesterWithDeck(RC_B_CLAIM_TESTER_A);
    testerB = await provisionTesterWithDeck(RC_B_CLAIM_TESTER_B);
    sessionAId = (await startOrResumeSessionFor(testerA)).id;
    sessionBId = (await startOrResumeSessionFor(testerB)).id;

    const admin = createAdminClient();
    const { error } = await admin
      .from("sessions")
      .update({ engine_version: "v1" })
      .in("id", [sessionAId, sessionBId]);
    if (error) throw error;
  });

  afterAll(async () => {
    await resetTesterLearnerData(RC_B_CLAIM_TESTER_A);
    await resetTesterLearnerData(RC_B_CLAIM_TESTER_B);
  });

  it("a fresh v1 session claims a real card from the newly-normalized starter deck, and the RPC's own front/back match the card row exactly (Alpha perf addition, item A)", async () => {
    const result = await claimNextLearningEngineCard(testerA.userId, sessionAId);

    expect(result.reused).toBe(false);
    expect(result.cardId).not.toBeNull();
    expect(result.claimId).not.toBeNull();
    expect(result.selectionTraceId).not.toBeNull();
    expect(result.schedulerPosition).toBe(0);
    expect(result.schedulerRevision).toBe(1);
    firstClaimCardId = result.cardId;

    const admin = createAdminClient();
    const { data: card } = await admin.from("cards").select("deck_id, front, back").eq("id", result.cardId!).maybeSingle();
    expect(card?.deck_id).toBe(testerA.deckId);
    // The RPC's own returned content must match the authoritative card
    // row byte-for-byte -- no separate getCardFrontBack() SELECT is
    // issued anywhere in this flow anymore.
    expect(result.front).toBe(card?.front);
    expect(result.back).toBe(card?.back);
    expect(result.front).toBeTruthy();
    expect(result.back).toBeTruthy();

    const { data: deckState } = await admin
      .from("user_deck_learning_state")
      .select("scheduler_position, scheduler_revision")
      .eq("user_id", testerA.userId)
      .eq("deck_id", testerA.deckId)
      .maybeSingle();
    expect(deckState?.scheduler_position).toBe(0);
    expect(deckState?.scheduler_revision).toBe(1);
  });

  it("RC-B corrective: the first claim's active-source selection advances active_draws_since_eligible for its other ordinary candidates, exactly once", async () => {
    // A fresh deck's very first claim admits several NEW cards into ACTIVE
    // simultaneously (the Fresh-limit refill, up to 6) and serves one of
    // them via the first-pass batch -- every OTHER admitted sibling is a
    // genuine ordinary Active candidate (never-presented NEW+ACTIVE) that
    // survived this one ACTIVE-source slot without being selected, so it
    // must have aged from 0 to exactly 1. Pre-check B's resolution (claim-
    // time, not answer-time) is exercised here against the real trusted
    // claim RPC, not merely the pure helper in isolation.
    expect(firstClaimCardId).not.toBeNull();

    const admin = createAdminClient();
    const { data: siblings } = await admin
      .from("user_card_progress")
      .select("card_id, active_draws_since_eligible")
      .eq("user_id", testerA.userId)
      .eq("pool_status", "ACTIVE")
      .neq("card_id", firstClaimCardId!);

    expect(siblings?.length ?? 0).toBeGreaterThan(0);
    for (const sibling of siblings ?? []) {
      expect(sibling.active_draws_since_eligible).toBe(1);
    }

    const { data: selected } = await admin
      .from("user_card_progress")
      .select("active_draws_since_eligible")
      .eq("user_id", testerA.userId)
      .eq("card_id", firstClaimCardId!)
      .maybeSingle();
    expect(selected?.active_draws_since_eligible).toBe(0);
  });

  it("a retry for the same session returns the SAME claim AND same card content unchanged (lost-response idempotency, item B/F/8)", async () => {
    const first = await claimNextLearningEngineCard(testerA.userId, sessionAId);
    expect(first.reused).toBe(true); // the prior test already created an OPEN claim

    const admin = createAdminClient();
    const { data: deckStateBefore } = await admin
      .from("user_deck_learning_state")
      .select("scheduler_position, scheduler_revision")
      .eq("user_id", testerA.userId)
      .eq("deck_id", testerA.deckId)
      .maybeSingle();

    const second = await claimNextLearningEngineCard(testerA.userId, sessionAId);
    expect(second.reused).toBe(true);
    expect(second.claimId).toBe(first.claimId);
    expect(second.cardId).toBe(first.cardId);
    expect(second.selectionTraceId).toBe(first.selectionTraceId);
    // Alpha perf addition: the reuse path returns the SAME card content
    // both times, without issuing a second claim, a second scheduler
    // advance, or a separate content SELECT.
    expect(second.front).toBe(first.front);
    expect(second.back).toBe(first.back);
    expect(second.front).toBeTruthy();
    expect(second.back).toBeTruthy();

    const { count } = await admin
      .from("selection_claims")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionAId);
    expect(count).toBe(1);

    const { data: deckStateAfter } = await admin
      .from("user_deck_learning_state")
      .select("scheduler_position, scheduler_revision")
      .eq("user_id", testerA.userId)
      .eq("deck_id", testerA.deckId)
      .maybeSingle();
    expect(deckStateAfter).toEqual(deckStateBefore);
  });

  it("concurrent claim requests for the same fresh session converge on exactly one OPEN claim", async () => {
    const [resultOne, resultTwo] = await Promise.all([
      claimNextLearningEngineCard(testerB.userId, sessionBId),
      claimNextLearningEngineCard(testerB.userId, sessionBId),
    ]);

    expect(resultOne.claimId).not.toBeNull();
    expect(resultOne.claimId).toBe(resultTwo.claimId);
    expect(resultOne.cardId).toBe(resultTwo.cardId);
    // Both concurrent callers must see the identical card content, not
    // just the identical claim/card id.
    expect(resultOne.front).toBe(resultTwo.front);
    expect(resultOne.back).toBe(resultTwo.back);
    expect(resultOne.front).toBeTruthy();
    expect(resultOne.back).toBeTruthy();

    const admin = createAdminClient();
    const { count: claimCount } = await admin
      .from("selection_claims")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionBId);
    expect(claimCount).toBe(1);

    const { count: traceCount } = await admin
      .from("learning_engine_selection_traces")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionBId);
    expect(traceCount).toBe(1);

    const { data: deckState } = await admin
      .from("user_deck_learning_state")
      .select("scheduler_position, scheduler_revision")
      .eq("user_id", testerB.userId)
      .eq("deck_id", testerB.deckId)
      .maybeSingle();
    // Claiming never advances scheduler_position (answer-commit-only);
    // exactly one revision bump from the single genuine claim, not two.
    expect(deckState?.scheduler_position).toBe(0);
    expect(deckState?.scheduler_revision).toBe(1);
  });

  it("cross-user isolation: tester A cannot claim against tester B's session", async () => {
    await expect(claimNextLearningEngineCard(testerA.userId, sessionBId)).rejects.toThrow();
  });

  it("a legacy-engine session is rejected (v1 claim cannot run against a non-v1 Session)", async () => {
    // A brand-new session defaults to engine_version = 'legacy'
    // (sessions.engine_version's own column default) -- this suite never
    // flips THIS tester's fresh session to v1, unlike sessionB above.
    await resetTesterLearnerData(RC_B_CLAIM_TESTER_B);
    const freshTesterB = await provisionTesterWithDeck(RC_B_CLAIM_TESTER_B);
    const freshLegacySessionId = (await startOrResumeSessionFor(freshTesterB)).id;

    await expect(claimNextLearningEngineCard(freshTesterB.userId, freshLegacySessionId)).rejects.toThrow();
  });
});
