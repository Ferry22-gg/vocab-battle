import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, type ProvisionedTester } from "./fixtures/provision";
import { RC_D_V1_ROUTING_TESTER, RC_D_LEGACY_ROUTING_TESTER } from "./fixtures/identities";
import { setRlsClient, clearRlsClient } from "./rls-client-context";
import { createAdminClient } from "./admin-client";
import { getSessionByIdAdmin, countAnswerEventsByClientEventId } from "./db-assertions";

const { getNextSessionCardForEngine, submitAnswerForEngine } = await import("@/lib/learning/engine-router");
const { finishSession } = await import("@/lib/sessions/dal");
const { enrollUserInLearningEngineV1 } = await import("@/lib/learning-engine/cutover/enroll");

/**
 * Integration tests for Learning Engine v1 Runtime Cutover RC-D (Live
 * Session Routing / Cutover Wiring) against the REAL local Supabase
 * stack.
 *
 * Unlike 15-learning-engine-v1-rc-b-claim.test.ts/
 * 16-learning-engine-v1-rc-c-answer-commit.test.ts (which set
 * engine_version='v1' directly via the admin client, because "no rollout
 * write path exists yet"), this file uses the REAL enrollment path for
 * the first time: enrollUserInLearningEngineV1() -> a brand-new
 * start_or_resume_session() session -> the real
 * getNextSessionCardForEngine()/submitAnswerForEngine() routing seam.
 *
 * Uses dedicated test-owned identities only (RC-D section 29) -- never a
 * real tester.
 */
describe("Learning Engine v1 Runtime Cutover RC-D: live Session routing (real local Supabase)", () => {
  let v1Tester: ProvisionedTester;
  let legacyTester: ProvisionedTester;

  beforeAll(async () => {
    await resetTesterLearnerData(RC_D_V1_ROUTING_TESTER);
    await resetTesterLearnerData(RC_D_LEGACY_ROUTING_TESTER);
    v1Tester = await provisionTesterWithDeck(RC_D_V1_ROUTING_TESTER);
    legacyTester = await provisionTesterWithDeck(RC_D_LEGACY_ROUTING_TESTER);
  });

  afterAll(async () => {
    clearRlsClient();
    await resetTesterLearnerData(RC_D_V1_ROUTING_TESTER);
    await resetTesterLearnerData(RC_D_LEGACY_ROUTING_TESTER);
  });

  it("scenario 1: a non-enrolled tester's full flow stays legacy end-to-end", async () => {
    setRlsClient(legacyTester.client);

    const session = await startOrResumeSessionFor(legacyTester);
    const sessionRow = await getSessionByIdAdmin(session.id);
    expect(sessionRow?.engine_version).toBe("legacy");

    const first = await getNextSessionCardForEngine(legacyTester.userId, session.id);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    expect(first.claimId).toBeNull();

    const clientEventId = crypto.randomUUID();
    const result = await submitAnswerForEngine(
      { clientEventId, sessionId: session.id, cardId: first.cardId, correct: true, responseTimeMs: 1200, claimId: null },
      legacyTester.userId,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isReplay).toBe(false);
    if (!result.data.isReplay) {
      expect(typeof result.data.totalXp).toBe("number");
    }

    // Legacy answer_events rows are never written with session_mode='v1'
    // (insert_learning_engine_review_event hard-codes 'v1' for every row
    // IT writes; commit_answer_transaction() never calls that function).
    const admin = createAdminClient();
    const { data: answerEvent } = await admin.from("answer_events").select("session_mode").eq("client_event_id", clientEventId).maybeSingle();
    expect(answerEvent?.session_mode).not.toBe("v1");

    // A legacy session never creates any selection_claims row at all.
    const { count } = await admin.from("selection_claims").select("id", { count: "exact", head: true }).eq("session_id", session.id);
    expect(count).toBe(0);
  });

  it("scenario 2: enrollUserInLearningEngineV1() admits a fresh (no legacy history) tester", async () => {
    const result = await enrollUserInLearningEngineV1(v1Tester.userId);

    expect(result.rollout.user_id).toBe(v1Tester.userId);
    expect(result.rollout.first_v1_answer_at).toBeNull();
    // A brand-new tester has no pre-existing LEARNING/LEARNED/FORGOTTEN
    // rows to normalize -- duplicate_starter_deck() only ever seeds NEW.
    expect(result.cardsNormalized).toBe(0);
  });

  it("scenario 3: the now-enrolled tester's brand-new session is v1, and next-card routes to RC-B's claim provider", async () => {
    setRlsClient(v1Tester.client);

    const session = await startOrResumeSessionFor(v1Tester);
    const sessionRow = await getSessionByIdAdmin(session.id);
    expect(sessionRow?.engine_version).toBe("v1");

    const first = await getNextSessionCardForEngine(v1Tester.userId, session.id);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    expect(first.claimId).not.toBeNull();
    expect(first.front).toBeTruthy();

    // Reload/resume-equivalent: the same call again returns the IDENTICAL
    // claim/card -- RC-B's idempotent fast path, never a second selection.
    const second = await getNextSessionCardForEngine(v1Tester.userId, session.id);
    expect(second.status).toBe("ok");
    if (second.status !== "ok") return;
    expect(second.claimId).toBe(first.claimId);
    expect(second.cardId).toBe(first.cardId);

    const admin = createAdminClient();
    const { count: openCount } = await admin
      .from("selection_claims")
      .select("id", { count: "exact", head: true })
      .eq("session_id", session.id)
      .eq("status", "OPEN");
    expect(openCount).toBe(1);
  });

  it("scenario 4: Correct answer commits via RC-C, carries real Battle feedback, and advances to a new card", async () => {
    setRlsClient(v1Tester.client);

    const session = await startOrResumeSessionFor(v1Tester);
    const card = await getNextSessionCardForEngine(v1Tester.userId, session.id);
    expect(card.status).toBe("ok");
    if (card.status !== "ok") return;

    const clientEventId = crypto.randomUUID();
    const result = await submitAnswerForEngine(
      { clientEventId, sessionId: session.id, cardId: card.cardId, correct: true, responseTimeMs: 900, claimId: card.claimId },
      v1Tester.userId,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isReplay).toBe(false);
    expect(result.data.correct).toBe(true);
    expect(typeof result.data.damage).toBe("number");
    expect(result.data.damage).toBeGreaterThan(0);
    expect(typeof result.data.enemyHpAfter).toBe("number");

    // The claim is now ANSWERED -- the next getNextSessionCardForEngine()
    // call must select a genuinely different card/claim, never reuse it.
    const next = await getNextSessionCardForEngine(v1Tester.userId, session.id);
    expect(next.status).toBe("ok");
    if (next.status !== "ok") return;
    expect(next.claimId).not.toBe(card.claimId);

    const admin = createAdminClient();
    const { data: claimRow } = await admin.from("selection_claims").select("status").eq("id", card.claimId!).maybeSingle();
    expect(claimRow?.status).toBe("ANSWERED");
  });

  it("scenario 5: a response-loss replay (same clientEventId) returns the EXACT same Battle result as the original -- even after later state has diverged -- without double-processing", async () => {
    setRlsClient(v1Tester.client);

    const session = await startOrResumeSessionFor(v1Tester);
    const admin = createAdminClient();

    // -- The ORIGINAL answer (Correct, so damage/critical/comboAfter are
    // genuinely non-zero/non-default) --
    const card1 = await getNextSessionCardForEngine(v1Tester.userId, session.id);
    expect(card1.status).toBe("ok");
    if (card1.status !== "ok") return;

    const clientEventId = crypto.randomUUID();
    const input = { clientEventId, sessionId: session.id, cardId: card1.cardId, correct: true, responseTimeMs: 900, claimId: card1.claimId };

    const first = await submitAnswerForEngine(input, v1Tester.userId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.isReplay).toBe(false);
    // Sanity: this is a genuinely non-zero/non-default Battle result --
    // otherwise a bug could masquerade as "fidelity" by coincidence.
    expect(first.data.damage).toBeGreaterThan(0);

    const deckRow = (await admin.from("decks").select("id").eq("owner_user_id", v1Tester.userId).limit(1).maybeSingle()).data as { id: string } | null;
    const deckStateAfterFirst = (
      await admin.from("user_deck_learning_state").select("scheduler_position, scheduler_revision").eq("user_id", v1Tester.userId).eq("deck_id", deckRow!.id).maybeSingle()
    ).data as { scheduler_position: number; scheduler_revision: number } | null;

    // -- A SECOND, DIFFERENT answer, so current session/deck state
    // genuinely diverges from what it was right after the original --
    const card2 = await getNextSessionCardForEngine(v1Tester.userId, session.id);
    expect(card2.status).toBe("ok");
    if (card2.status !== "ok") return;
    const second = await submitAnswerForEngine(
      { clientEventId: crypto.randomUUID(), sessionId: session.id, cardId: card2.cardId, correct: true, responseTimeMs: 900, claimId: card2.claimId },
      v1Tester.userId,
    );
    expect(second.ok).toBe(true);

    const deckStateAfterSecond = (
      await admin.from("user_deck_learning_state").select("scheduler_position, scheduler_revision").eq("user_id", v1Tester.userId).eq("deck_id", deckRow!.id).maybeSingle()
    ).data as { scheduler_position: number; scheduler_revision: number } | null;
    expect(deckStateAfterSecond?.scheduler_position).not.toBe(deckStateAfterFirst?.scheduler_position);

    const sessionAfterSecond = (await admin.from("sessions").select("total_answers, current_combo, current_enemy_hp, xp_gained").eq("id", session.id).maybeSingle()).data;

    // -- REPLAY the FIRST (now-historical) answer --
    const replay = await submitAnswerForEngine(input, v1Tester.userId);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;

    expect(replay.data.isReplay).toBe(true);
    expect(replay.data.correct).toBe(true);
    // The EXACT original values -- not the diverged current state, and
    // not a zeroed placeholder.
    expect(replay.data.damage).toBe(first.data.damage);
    expect(replay.data.critical).toBe(first.data.critical);
    expect(replay.data.comboAfter).toBe(first.data.comboAfter);
    expect(replay.data.enemyHpAfter).toBe(first.data.enemyHpAfter);
    expect(replay.data.enemyDefeated).toBe(first.data.enemyDefeated);

    // No double-processing, and no further mutation from the replay.
    expect(await countAnswerEventsByClientEventId(clientEventId)).toBe(1);
    const deckStateAfterReplay = (
      await admin.from("user_deck_learning_state").select("scheduler_position, scheduler_revision").eq("user_id", v1Tester.userId).eq("deck_id", deckRow!.id).maybeSingle()
    ).data;
    expect(deckStateAfterReplay).toEqual(deckStateAfterSecond);
    const sessionAfterReplay = (await admin.from("sessions").select("total_answers, current_combo, current_enemy_hp, xp_gained").eq("id", session.id).maybeSingle()).data;
    expect(sessionAfterReplay).toEqual(sessionAfterSecond);
  });

  it("scenario 6: explicit finish abandons the OPEN claim; a subsequent resume starts a brand-new session, still v1 (one-way)", async () => {
    setRlsClient(v1Tester.client);

    const session = await startOrResumeSessionFor(v1Tester);
    const card = await getNextSessionCardForEngine(v1Tester.userId, session.id);
    expect(card.status).toBe("ok");
    if (card.status !== "ok") return;

    await finishSession(session.id);

    const admin = createAdminClient();
    const { data: claimRow } = await admin.from("selection_claims").select("status").eq("id", card.claimId!).maybeSingle();
    expect(claimRow?.status).toBe("ABANDONED");

    const resumed = await startOrResumeSessionFor(v1Tester);
    expect(resumed.id).not.toBe(session.id);
    const resumedRow = await getSessionByIdAdmin(resumed.id);
    expect(resumedRow?.engine_version).toBe("v1");
  });

  it("scenario 7: legacy queues are never populated for a v1 session", async () => {
    const admin = createAdminClient();
    const { data: sessions } = await admin.from("sessions").select("id").eq("user_id", v1Tester.userId).eq("engine_version", "v1");
    const sessionIds = (sessions ?? []).map((s: { id: string }) => s.id);
    expect(sessionIds.length).toBeGreaterThan(0);

    const { count: reviewCount } = await admin
      .from("session_review_cards")
      .select("session_id", { count: "exact", head: true })
      .in("session_id", sessionIds);
    const { count: learningQueueCount } = await admin
      .from("session_learning_queue")
      .select("session_id", { count: "exact", head: true })
      .in("session_id", sessionIds);
    expect(reviewCount).toBe(0);
    expect(learningQueueCount).toBe(0);
  });
});
