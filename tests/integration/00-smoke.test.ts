import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, type ProvisionedTester } from "./fixtures/provision";
import { CORE_ANSWER_TESTER } from "./fixtures/identities";
import { setRlsClient, clearRlsClient } from "./rls-client-context";

const { runSubmitAnswer, defaultSubmitAnswerDeps } = await import("@/lib/learning/submit-answer");

describe("smoke: harness wiring against real local Supabase", () => {
  let tester: ProvisionedTester;
  let sessionId: string;

  beforeAll(async () => {
    await resetTesterLearnerData(CORE_ANSWER_TESTER);
    tester = await provisionTesterWithDeck(CORE_ANSWER_TESTER);
    const session = await startOrResumeSessionFor(tester);
    sessionId = session.id;
  });

  afterAll(() => {
    clearRlsClient();
  });

  it("submits one correct answer end-to-end through the real RPC", async () => {
    setRlsClient(tester.client);

    const result = await runSubmitAnswer(
      {
        clientEventId: crypto.randomUUID(),
        sessionId,
        cardId: tester.cardId,
        correct: true,
        responseTimeMs: 1500,
      },
      tester.userId,
      defaultSubmitAnswerDeps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isReplay).toBe(false);
    expect(result.data.correct).toBe(true);
  });
});
