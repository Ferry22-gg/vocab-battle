import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, pickCards, type ProvisionedTester } from "./fixtures/provision";
import { RLS_TESTER_A, RLS_TESTER_B } from "./fixtures/identities";
import { setRlsClient, clearRlsClient } from "./rls-client-context";
import { countAnswerEventsByClientEventId } from "./db-assertions";

const { runSubmitAnswer, defaultSubmitAnswerDeps } = await import("@/lib/learning/submit-answer");
const { getActiveSessionById } = await import("@/lib/sessions/dal");
const { getCardProgress, getRecentAnswerHistory } = await import("@/lib/learning/progress-dal");

/**
 * Phase E scenario 14: RLS cross-user isolation, exercised through the
 * real production DAL/orchestration against real RLS policies -- never
 * via a service-role read standing in for the ordinary read path (the
 * admin client here is used only to submit tester B's own legitimate
 * answer through B's own real client, which is not a service-role read at
 * all).
 */
describe("RLS cross-user isolation (real Postgres RLS)", () => {
  let testerA: ProvisionedTester;
  let testerB: ProvisionedTester;
  let sessionAId: string;
  let sessionBId: string;

  beforeAll(async () => {
    await resetTesterLearnerData(RLS_TESTER_A);
    await resetTesterLearnerData(RLS_TESTER_B);
    testerA = await provisionTesterWithDeck(RLS_TESTER_A);
    testerB = await provisionTesterWithDeck(RLS_TESTER_B);
    sessionAId = (await startOrResumeSessionFor(testerA)).id;
    sessionBId = (await startOrResumeSessionFor(testerB)).id;

    // B legitimately answers one of their own cards, through B's own real
    // client -- gives A something real (but not theirs) to fail to see.
    setRlsClient(testerB.client);
    const [cardB] = await pickCards(testerB, 1);
    const result = await runSubmitAnswer(
      { clientEventId: crypto.randomUUID(), sessionId: sessionBId, cardId: cardB, correct: true, responseTimeMs: 1500 },
      testerB.userId,
      defaultSubmitAnswerDeps,
    );
    expect(result.ok).toBe(true);
  });

  afterAll(() => {
    clearRlsClient();
  });

  it("tester A cannot read tester B's session through the real RLS-scoped DAL", async () => {
    setRlsClient(testerA.client);
    await expect(getActiveSessionById(sessionBId)).resolves.toBeNull();
  });

  it("isolation is symmetric: tester B cannot read tester A's session either", async () => {
    setRlsClient(testerB.client);
    await expect(getActiveSessionById(sessionAId)).resolves.toBeNull();
  });

  it("tester A cannot read tester B's card progress through the real RLS-scoped DAL", async () => {
    setRlsClient(testerA.client);
    const [cardB] = await pickCards(testerB, 1);
    await expect(getCardProgress(cardB)).resolves.toBeNull();
  });

  it("tester A cannot read tester B's answer history through the real RLS-scoped DAL", async () => {
    setRlsClient(testerA.client);
    const [cardB] = await pickCards(testerB, 1);
    await expect(getRecentAnswerHistory(cardB)).resolves.toEqual([]);
  });

  it("submitting B's sessionId/cardId as A resolves safely as NOT_FOUND_OR_INACCESSIBLE, without touching B's data", async () => {
    setRlsClient(testerA.client);
    const [cardB] = await pickCards(testerB, 1);
    const clientEventId = crypto.randomUUID();

    const result = await runSubmitAnswer(
      { clientEventId, sessionId: sessionBId, cardId: cardB, correct: true, responseTimeMs: 1500 },
      testerA.userId,
      defaultSubmitAnswerDeps,
    );

    expect(result).toEqual({
      ok: false,
      code: "NOT_FOUND_OR_INACCESSIBLE",
      message: expect.any(String),
    });
    if (!result.ok) {
      // The failure message never names B, their session, or their card.
      expect(result.message).not.toContain(testerB.userId);
      expect(result.message).not.toContain(sessionBId);
      expect(result.message).not.toContain(cardB);
    }

    // No commit occurred at all -- A's attempt never reached the RPC.
    expect(await countAnswerEventsByClientEventId(clientEventId)).toBe(0);
  });
});
