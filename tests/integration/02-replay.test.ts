import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, pickCards, type ProvisionedTester } from "./fixtures/provision";
import { REPLAY_TESTER } from "./fixtures/identities";
import { setRlsClient, clearRlsClient } from "./rls-client-context";
import {
  countAnswerEventsByClientEventId,
  getAnswerEventByClientEventIdAdmin,
  getUserCardProgressAdmin,
  getXpEventsForAnswerEventAdmin,
} from "./db-assertions";

const { runSubmitAnswer, defaultSubmitAnswerDeps } = await import("@/lib/learning/submit-answer");

/**
 * Phase E scenarios 7-8: genuine idempotent replay (including the
 * D3b-hardened finished-session case) and clientEventId misuse rejection,
 * all against the real commit_answer_transaction() RPC.
 */
describe("replay and idempotency (real commit_answer_transaction)", () => {
  let tester: ProvisionedTester;
  let sessionId: string;
  let cardA: string;
  let cardB: string;
  let cardC: string;
  let cardD: string;

  beforeAll(async () => {
    await resetTesterLearnerData(REPLAY_TESTER);
    tester = await provisionTesterWithDeck(REPLAY_TESTER);
    [cardA, cardB, cardC, cardD] = await pickCards(tester, 4);
    const session = await startOrResumeSessionFor(tester);
    sessionId = session.id;
  });

  afterAll(() => {
    clearRlsClient();
  });

  it("scenario 7: a genuine retry with the same clientEventId replays without a duplicate commit", async () => {
    setRlsClient(tester.client);
    const clientEventId = crypto.randomUUID();
    const input = { clientEventId, sessionId, cardId: cardA, correct: true, responseTimeMs: 1200 };

    const first = await runSubmitAnswer(input, tester.userId, defaultSubmitAnswerDeps);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.isReplay).toBe(false);

    const progressAfterFirst = await getUserCardProgressAdmin(tester.userId, cardA);
    const answerEventAfterFirst = await getAnswerEventByClientEventIdAdmin(clientEventId);
    const xpEventsAfterFirst = await getXpEventsForAnswerEventAdmin(answerEventAfterFirst.id);

    // Retry: SAME logical answer, SAME clientEventId, even though real
    // session/progress state has since advanced (this is exactly what a
    // transport-retry after a lost response looks like).
    const retry = await runSubmitAnswer(input, tester.userId, defaultSubmitAnswerDeps);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.data.isReplay).toBe(true);
    // Shared fields must match the original commit's persisted values, not a recomputation.
    expect(retry.data.damage).toBe(first.data.damage);
    expect(retry.data.comboAfter).toBe(first.data.comboAfter);
    expect(retry.data.rating).toBe(first.data.rating);

    expect(await countAnswerEventsByClientEventId(clientEventId)).toBe(1);
    const progressAfterRetry = await getUserCardProgressAdmin(tester.userId, cardA);
    expect(progressAfterRetry).toEqual(progressAfterFirst); // unchanged by the retry
    const xpEventsAfterRetry = await getXpEventsForAnswerEventAdmin(answerEventAfterFirst.id);
    expect(xpEventsAfterRetry).toHaveLength(xpEventsAfterFirst.length); // no duplicate XP
  });

  it("scenario 8: reusing a committed clientEventId for a different card is rejected, not replayed", async () => {
    setRlsClient(tester.client);
    const clientEventId = crypto.randomUUID();

    const first = await runSubmitAnswer(
      { clientEventId, sessionId, cardId: cardB, correct: true, responseTimeMs: 1200 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );
    expect(first.ok).toBe(true);

    // Same clientEventId, different cardId -- a client bug, must not be
    // silently accepted as a valid replay of a different logical answer.
    const misuse = await runSubmitAnswer(
      { clientEventId, sessionId, cardId: cardC, correct: true, responseTimeMs: 1200 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );

    expect(misuse.ok).toBe(false);
    if (misuse.ok) return;
    expect(misuse.code).toBe("COMMIT_FAILED");
    expect(misuse.message).not.toMatch(/client_event_id|sql|postgres/i);

    // No second commit was created, and the second card's progress is untouched.
    expect(await countAnswerEventsByClientEventId(clientEventId)).toBe(1);
    const cardCProgress = await getUserCardProgressAdmin(tester.userId, cardC);
    expect(cardCProgress).toMatchObject({ card_status: "NEW", seen_count: 0 });
  });

  it("scenario 7 (hardened): a retry still replays successfully after the session has been explicitly finished", async () => {
    setRlsClient(tester.client);

    // Uses a fresh card (cardD): cardA/cardB were already answered
    // correctly earlier in this file, and a correct Learning-mode answer
    // puts the card in a real 10-draw cooldown (MVP_SPEC_FOR_CLAUDE.md
    // 13/DATABASE_SCHEMA.md 11.3) -- reusing them here would hit that
    // real cooldown rejection instead of exercising what this test is
    // actually about.
    const originalClientEventId = crypto.randomUUID();
    const original = await runSubmitAnswer(
      { clientEventId: originalClientEventId, sessionId, cardId: cardD, correct: true, responseTimeMs: 1200 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );
    expect(original.ok).toBe(true);

    // Explicitly finish the session through the real finish_session() RPC.
    const { error: finishError } = await tester.client.rpc("finish_session", { p_session_id: sessionId });
    expect(finishError).toBeNull();

    // Retry the ORIGINAL (now-historical) answer with its original
    // clientEventId. getActiveSessionById() would return null for this
    // session now (status='completed') -- proving the D3b early-replay
    // lookup, not a fresh session read, is what resolves this.
    const retry = await runSubmitAnswer(
      { clientEventId: originalClientEventId, sessionId, cardId: cardD, correct: true, responseTimeMs: 1200 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );

    expect(retry.ok).toBe(true);
    if (!retry.ok || !original.ok) return;
    expect(retry.data.isReplay).toBe(true);
    expect(retry.data.damage).toBe(original.data.damage);
    expect(retry.data.rating).toBe(original.data.rating);
    expect(await countAnswerEventsByClientEventId(originalClientEventId)).toBe(1);
  });
});
