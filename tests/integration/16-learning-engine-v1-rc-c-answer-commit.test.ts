import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData, deleteTesterAccount } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, type ProvisionedTester } from "./fixtures/provision";
import { RC_C_ANSWER_TESTER_A, RC_C_ANSWER_TESTER_B, RC_C_ANSWER_TESTER_C, RC_C_ANSWER_TESTER_D } from "./fixtures/identities";
import { createAdminClient } from "./admin-client";

const { claimNextLearningEngineCard } = await import("@/lib/learning-engine/runtime/claim-next-card");
const { commitLearningEngineAnswer } = await import("@/lib/learning-engine/runtime/commit-answer");

/**
 * Integration tests for Learning Engine v1 Runtime Cutover RC-C (the
 * Answer Commit Transaction) against the REAL local Supabase stack.
 *
 * Cross-entity validation, idempotency, and the atomic mutation contract
 * at the SQL layer are already exhaustively covered by supabase/tests/
 * 020_learning_engine_v1_runtime_cutover_rc_c_test.sql's 42 pgTAP
 * assertions, and prepareLearningEngineAnswer's own transition-matrix
 * correctness by tests/unit/learning-engine-runtime-prepare-answer.test.ts.
 * This file's job is narrower: prove the TypeScript orchestrator
 * (commitLearningEngineAnswer -- read -> prepareLearningEngineAnswer ->
 * telemetry -> commit) composes correctly end-to-end against a real
 * database and a real starter deck, including the one race RC-C's
 * pre-check A exists specifically to tolerate.
 *
 * No live session ever gets engine_version = 'v1' through any real
 * product code path yet -- this suite sets it directly via the admin
 * client, mirroring supabase/tests/
 * 019_learning_engine_v1_runtime_cutover_rc_b_test.sql's own documented
 * precedent.
 */
describe("Learning Engine v1 Runtime Cutover RC-C: commitLearningEngineAnswer (real local Supabase)", () => {
  let testerA: ProvisionedTester;
  let testerB: ProvisionedTester;
  let sessionAId: string;
  let sessionBId: string;

  let testerC: ProvisionedTester;
  let sessionCId: string;

  beforeAll(async () => {
    await resetTesterLearnerData(RC_C_ANSWER_TESTER_A);
    await resetTesterLearnerData(RC_C_ANSWER_TESTER_B);
    await resetTesterLearnerData(RC_C_ANSWER_TESTER_C);
    testerA = await provisionTesterWithDeck(RC_C_ANSWER_TESTER_A);
    testerB = await provisionTesterWithDeck(RC_C_ANSWER_TESTER_B);
    testerC = await provisionTesterWithDeck(RC_C_ANSWER_TESTER_C);
    sessionAId = (await startOrResumeSessionFor(testerA)).id;
    sessionBId = (await startOrResumeSessionFor(testerB)).id;
    sessionCId = (await startOrResumeSessionFor(testerC)).id;

    const admin = createAdminClient();
    const { error } = await admin.from("sessions").update({ engine_version: "v1" }).in("id", [sessionAId, sessionBId, sessionCId]);
    if (error) throw error;

    // testerA/testerB are enrolled in the rollout up front -- the RC-C
    // rollout-invariant corrective (20261014000000) requires this for
    // ANY fresh v1 answer to commit at all. testerC is deliberately left
    // UNENROLLED, for the dedicated rejection test below.
    //
    // upsert, not insert: once either tester's row has first_v1_answer_at
    // set from a PRIOR test run, the one-way guard (20261015000000) makes
    // the row permanent -- resetTesterLearnerData never deletes it (see
    // that fixture's own comment) -- so a plain insert would fail on the
    // primary key on every run after the first. ignoreDuplicates leaves
    // an existing (possibly-permanent) row completely untouched.
    const { error: rolloutError } = await admin
      .from("learning_engine_v1_rollout")
      .upsert([{ user_id: testerA.userId }, { user_id: testerB.userId }], { onConflict: "user_id", ignoreDuplicates: true });
    if (rolloutError) throw rolloutError;
  });

  afterAll(async () => {
    await resetTesterLearnerData(RC_C_ANSWER_TESTER_A);
    await resetTesterLearnerData(RC_C_ANSWER_TESTER_B);
    await resetTesterLearnerData(RC_C_ANSWER_TESTER_C);
  });

  it("RC-C rollout-invariant corrective: a v1 Session with no learning_engine_v1_rollout row rejects a fresh answer atomically", async () => {
    const claim = await claimNextLearningEngineCard(testerC.userId, sessionCId);
    expect(claim.cardId).not.toBeNull();

    await expect(
      commitLearningEngineAnswer(testerC.userId, sessionCId, claim.claimId!, {
        clientEventId: crypto.randomUUID(),
        correct: true,
        responseTimeMs: 1000,
        timeToFirstActionMs: null,
      }),
    ).rejects.toThrow();

    const admin = createAdminClient();
    const { data: claimRow } = await admin.from("selection_claims").select("status").eq("id", claim.claimId!).maybeSingle();
    expect(claimRow?.status).toBe("OPEN");

    const { data: deckState } = await admin
      .from("user_deck_learning_state")
      .select("scheduler_position")
      .eq("user_id", testerC.userId)
      .eq("deck_id", testerC.deckId)
      .maybeSingle();
    expect(deckState?.scheduler_position).toBe(0);

    const { count: answerEventCount } = await admin
      .from("answer_events")
      .select("id", { count: "exact", head: true })
      .eq("card_id", claim.cardId!);
    expect(answerEventCount).toBe(0);
  });

  it("claims and commits a Correct answer end-to-end against the real starter deck", async () => {
    const claim = await claimNextLearningEngineCard(testerA.userId, sessionAId);
    expect(claim.cardId).not.toBeNull();

    const result = await commitLearningEngineAnswer(testerA.userId, sessionAId, claim.claimId!, {
      clientEventId: crypto.randomUUID(),
      correct: true,
      responseTimeMs: 1500,
      timeToFirstActionMs: null,
    });

    expect(result.isReplay).toBe(false);
    expect(result.userCardProgress).not.toBeNull();

    const admin = createAdminClient();
    const { data: claimRow } = await admin.from("selection_claims").select("status").eq("id", claim.claimId!).maybeSingle();
    expect(claimRow?.status).toBe("ANSWERED");

    const { data: deckState } = await admin
      .from("user_deck_learning_state")
      .select("scheduler_position")
      .eq("user_id", testerA.userId)
      .eq("deck_id", testerA.deckId)
      .maybeSingle();
    expect(deckState?.scheduler_position).toBe(1);

    const { data: progress } = await admin
      .from("user_card_progress")
      .select("last_presented_scheduler_position")
      .eq("user_id", testerA.userId)
      .eq("card_id", claim.cardId!)
      .maybeSingle();
    expect(progress?.last_presented_scheduler_position).toBe(1);

    const { data: rollout } = await admin
      .from("learning_engine_v1_rollout")
      .select("first_v1_answer_at")
      .eq("user_id", testerA.userId)
      .maybeSingle();
    expect(rollout?.first_v1_answer_at).not.toBeNull();
  });

  it("a replay with the same clientEventId returns the identical historical result without re-mutating state, even after the claim has moved to ANSWERED", async () => {
    const claim = await claimNextLearningEngineCard(testerA.userId, sessionAId);
    const clientEventId = crypto.randomUUID();

    const first = await commitLearningEngineAnswer(testerA.userId, sessionAId, claim.claimId!, {
      clientEventId,
      correct: true,
      responseTimeMs: 1000,
      timeToFirstActionMs: null,
    });
    expect(first.isReplay).toBe(false);

    const admin = createAdminClient();
    const { data: positionAfterFirst } = await admin
      .from("user_deck_learning_state")
      .select("scheduler_position")
      .eq("user_id", testerA.userId)
      .eq("deck_id", testerA.deckId)
      .maybeSingle();

    // The retry passes the SAME claimId, which is now ANSWERED -- the
    // orchestrator's own idempotency pre-check must short-circuit before
    // ever trying to read an answer context for a no-longer-OPEN claim.
    const replay = await commitLearningEngineAnswer(testerA.userId, sessionAId, claim.claimId!, {
      clientEventId,
      correct: true,
      responseTimeMs: 1000,
      timeToFirstActionMs: null,
    });
    expect(replay.isReplay).toBe(true);
    expect(replay.userCardProgress).toBeNull();

    const { data: positionAfterReplay } = await admin
      .from("user_deck_learning_state")
      .select("scheduler_position")
      .eq("user_id", testerA.userId)
      .eq("deck_id", testerA.deckId)
      .maybeSingle();
    expect(positionAfterReplay?.scheduler_position).toBe(positionAfterFirst?.scheduler_position);
  });

  it("a different clientEventId against an already-ANSWERED claim is rejected, never treated as a new answer", async () => {
    const claim = await claimNextLearningEngineCard(testerA.userId, sessionAId);
    await commitLearningEngineAnswer(testerA.userId, sessionAId, claim.claimId!, {
      clientEventId: crypto.randomUUID(),
      correct: true,
      responseTimeMs: 1000,
      timeToFirstActionMs: null,
    });

    await expect(
      commitLearningEngineAnswer(testerA.userId, sessionAId, claim.claimId!, {
        clientEventId: crypto.randomUUID(),
        correct: true,
        responseTimeMs: 1000,
        timeToFirstActionMs: null,
      }),
    ).rejects.toThrow();
  });

  it("scheduler_position advances continuously across multiple claim+commit cycles", async () => {
    const admin = createAdminClient();
    const { data: before } = await admin
      .from("user_deck_learning_state")
      .select("scheduler_position")
      .eq("user_id", testerA.userId)
      .eq("deck_id", testerA.deckId)
      .maybeSingle();
    const startPosition = before!.scheduler_position as number;

    for (let i = 0; i < 3; i += 1) {
      const claim = await claimNextLearningEngineCard(testerA.userId, sessionAId);
      await commitLearningEngineAnswer(testerA.userId, sessionAId, claim.claimId!, {
        clientEventId: crypto.randomUUID(),
        correct: true,
        responseTimeMs: 900,
        timeToFirstActionMs: null,
      });
    }

    const { data: after } = await admin
      .from("user_deck_learning_state")
      .select("scheduler_position")
      .eq("user_id", testerA.userId)
      .eq("deck_id", testerA.deckId)
      .maybeSingle();
    expect(after?.scheduler_position).toBe(startPosition + 3);
  });

  it("a Wrong answer creates a repair obligation and never touches active_draws_since_eligible (claim-time only, RC-B)", async () => {
    const claim = await claimNextLearningEngineCard(testerB.userId, sessionBId);
    expect(claim.cardId).not.toBeNull();

    const admin = createAdminClient();
    const { data: before } = await admin
      .from("user_card_progress")
      .select("active_draws_since_eligible")
      .eq("user_id", testerB.userId)
      .eq("card_id", claim.cardId!)
      .maybeSingle();

    await commitLearningEngineAnswer(testerB.userId, sessionBId, claim.claimId!, {
      clientEventId: crypto.randomUUID(),
      correct: false,
      responseTimeMs: 2000,
      timeToFirstActionMs: 500,
    });

    const { data: after } = await admin
      .from("user_card_progress")
      .select("repair_pending, repair_wrong_position, repair_target_position, repair_hard_cap_position, active_draws_since_eligible")
      .eq("user_id", testerB.userId)
      .eq("card_id", claim.cardId!)
      .maybeSingle();

    expect(after?.repair_pending).toBe(true);
    expect(after?.repair_wrong_position).not.toBeNull();
    expect(after?.repair_target_position).toBeGreaterThan(after!.repair_wrong_position as number);
    expect(after?.repair_hard_cap_position).toBeGreaterThan(after!.repair_wrong_position as number);
    // The answer-commit transaction must never touch this counter --
    // it is exclusively a claim-time concern since the RC-B correction.
    expect(after?.active_draws_since_eligible).toBe(before?.active_draws_since_eligible);
  });

  it("RC-C pre-check A: a card added to the deck while the claim is OPEN does not block the eventual answer", async () => {
    const claim = await claimNextLearningEngineCard(testerB.userId, sessionBId);
    expect(claim.cardId).not.toBeNull();

    // A second tab/request adds a brand-new card to the SAME deck while
    // this claim is still open -- RC-B's own card-set trigger bumps
    // scheduler_revision for this, completely unrelated to the claimed
    // card. The answer must still commit: pre-check A's whole point is
    // that the answer-commit transaction never requires the deck-wide
    // scheduler_revision to still match.
    const { error: addCardError } = await testerB.client.rpc("add_card_to_deck", {
      p_deck_id: testerB.deckId,
      p_front: "rc-c-pre-check-a-front",
      p_back: "rc-c-pre-check-a-back",
    });
    if (addCardError) throw addCardError;

    const result = await commitLearningEngineAnswer(testerB.userId, sessionBId, claim.claimId!, {
      clientEventId: crypto.randomUUID(),
      correct: true,
      responseTimeMs: 1100,
      timeToFirstActionMs: null,
    });

    expect(result.isReplay).toBe(false);
    expect(result.userCardProgress).not.toBeNull();
  });

  it("a cross-user commit attempt against another tester's claim is rejected", async () => {
    const claimA = await claimNextLearningEngineCard(testerA.userId, sessionAId);
    expect(claimA.cardId).not.toBeNull();

    await expect(
      commitLearningEngineAnswer(testerB.userId, sessionAId, claimA.claimId!, {
        clientEventId: crypto.randomUUID(),
        correct: true,
        responseTimeMs: 1000,
        timeToFirstActionMs: null,
      }),
    ).rejects.toThrow();
  });

  it("a full account deletion of a user who has entered the one-way zone succeeds end-to-end, removing the rollout row, profile, and auth identity", async () => {
    await resetTesterLearnerData(RC_C_ANSWER_TESTER_D);
    const testerD = await provisionTesterWithDeck(RC_C_ANSWER_TESTER_D);
    const sessionDId = (await startOrResumeSessionFor(testerD)).id;

    const admin = createAdminClient();
    const { error: engineError } = await admin.from("sessions").update({ engine_version: "v1" }).eq("id", sessionDId);
    if (engineError) throw engineError;
    const { error: rolloutInsertError } = await admin.from("learning_engine_v1_rollout").insert({ user_id: testerD.userId });
    if (rolloutInsertError) throw rolloutInsertError;

    const claim = await claimNextLearningEngineCard(testerD.userId, sessionDId);
    await commitLearningEngineAnswer(testerD.userId, sessionDId, claim.claimId!, {
      clientEventId: crypto.randomUUID(),
      correct: true,
      responseTimeMs: 1000,
      timeToFirstActionMs: null,
    });

    const { data: rolloutAfterAnswer } = await admin
      .from("learning_engine_v1_rollout")
      .select("first_v1_answer_at")
      .eq("user_id", testerD.userId)
      .maybeSingle();
    expect(rolloutAfterAnswer?.first_v1_answer_at).not.toBeNull();

    // A direct delete is still rejected -- testerD is a live user.
    const { error: directDeleteError } = await admin.from("learning_engine_v1_rollout").delete().eq("user_id", testerD.userId);
    expect(directDeleteError).not.toBeNull();
    expect(directDeleteError?.code).toBe("42501");

    // The project's one real full account-deletion sequence (the same
    // helper teardownIntegrationFixtures() already runs for every
    // fixture identity after every integration run) succeeds end-to-end,
    // including the sanctioned rollout-row bypass.
    await deleteTesterAccount(admin, testerD.userId);

    const { count: rolloutCountAfter } = await admin
      .from("learning_engine_v1_rollout")
      .select("user_id", { count: "exact", head: true })
      .eq("user_id", testerD.userId);
    expect(rolloutCountAfter).toBe(0);

    const { count: profileCountAfter } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("id", testerD.userId);
    expect(profileCountAfter).toBe(0);

    const { data: authUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    expect(authUsers.users.some((u) => u.id === testerD.userId)).toBe(false);
  });

  it("the review event persisted by a commit links to the exact SelectionTrace its claim came from", async () => {
    const claim = await claimNextLearningEngineCard(testerA.userId, sessionAId);
    expect(claim.cardId).not.toBeNull();

    await commitLearningEngineAnswer(testerA.userId, sessionAId, claim.claimId!, {
      clientEventId: crypto.randomUUID(),
      correct: true,
      responseTimeMs: 1300,
      timeToFirstActionMs: null,
    });

    const admin = createAdminClient();
    const { data: reviewEvent } = await admin
      .from("answer_events")
      .select("selection_trace_id, session_mode")
      .eq("selection_trace_id", claim.selectionTraceId!)
      .maybeSingle();
    expect(reviewEvent?.session_mode).toBe("v1");
    expect(reviewEvent?.selection_trace_id).toBe(claim.selectionTraceId);
  });
});
