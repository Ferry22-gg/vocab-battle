import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, type ProvisionedTester } from "./fixtures/provision";
import { WRONG_FLOOR_TESTER } from "./fixtures/identities";
import { setRlsClient, clearRlsClient } from "./rls-client-context";
import { getSessionByIdAdmin, getSessionLearningQueueRowAdmin } from "./db-assertions";

const { getNextSessionCard } = await import("@/lib/sessions/dal");
const { runSubmitAnswer, defaultSubmitAnswerDeps } = await import("@/lib/learning/submit-answer");

/**
 * F1 follow-up scenario 17: the Learning-mode Wrong reappearance FLOOR
 * (20260927000000_learning_wrong_reappearance_floor.sql) against a real
 * local database, through the real random collision-shift gap -- not a
 * manually-forced draw index like the pgTAP suite's deterministic
 * coverage (supabase/tests/014_learning_wrong_reappearance_floor_test.sql).
 * Proves the real end-to-end sequence:
 *
 *   Wrong card -> several other cards -> Wronged card absent before its
 *   reserved draw -> Wronged card reappears exactly at the reserved draw.
 */
describe("Learning Wrong reappearance floor (real database, real random gap)", () => {
  let tester: ProvisionedTester;
  let sessionId: string;

  beforeAll(async () => {
    await resetTesterLearnerData(WRONG_FLOOR_TESTER);
    tester = await provisionTesterWithDeck(WRONG_FLOOR_TESTER);
    const session = await startOrResumeSessionFor(tester);
    sessionId = session.id;
    setRlsClient(tester.client);
  });

  afterAll(() => {
    clearRlsClient();
  });

  it("the Wronged card is absent from every intervening draw and reappears exactly at its reserved draw", async () => {
    const first = await getNextSessionCard(sessionId);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    const wrongedCardId = first.cardId;

    const wrongResult = await runSubmitAnswer(
      { clientEventId: crypto.randomUUID(), sessionId, cardId: wrongedCardId, correct: false, responseTimeMs: 1200 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );
    expect(wrongResult.ok).toBe(true);

    const queueRow = await getSessionLearningQueueRowAdmin(sessionId, wrongedCardId);
    expect(queueRow).not.toBeNull();
    const reservedDraw = queueRow!.forced_reappear_draw_index as number;
    expect(queueRow!.next_eligible_draw_index).toBe(reservedDraw);

    // Walk the intervening draws (bounded: the gap is 6..9, plus any
    // collision-shift, so this is always small -- 20 is a generous safety
    // cap against an infinite loop if the invariant were ever violated).
    let iterations = 0;
    for (;;) {
      const session = await getSessionByIdAdmin(sessionId);
      const nextDraw = session.learning_draw_index + 1;
      if (nextDraw >= reservedDraw) break;

      iterations += 1;
      expect(iterations).toBeLessThan(20);

      const next = await getNextSessionCard(sessionId);
      expect(next.status).toBe("ok");
      if (next.status !== "ok") return;

      // The core invariant: never offered before its reserved draw.
      expect(next.cardId).not.toBe(wrongedCardId);

      const answer = await runSubmitAnswer(
        { clientEventId: crypto.randomUUID(), sessionId, cardId: next.cardId, correct: true, responseTimeMs: 1200 },
        tester.userId,
        defaultSubmitAnswerDeps,
      );
      expect(answer.ok).toBe(true);
    }

    // Exactly at the reserved draw: get_next_session_card() forces the
    // Wronged card, and submitting it succeeds.
    const atReserved = await getNextSessionCard(sessionId);
    expect(atReserved.status).toBe("ok");
    if (atReserved.status !== "ok") return;
    expect(atReserved.cardId).toBe(wrongedCardId);

    const finalAnswer = await runSubmitAnswer(
      { clientEventId: crypto.randomUUID(), sessionId, cardId: wrongedCardId, correct: true, responseTimeMs: 1200 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );
    expect(finalAnswer.ok).toBe(true);
  });
});
