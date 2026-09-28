import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, type ProvisionedTester } from "./fixtures/provision";
import { NEXT_CARD_TESTER } from "./fixtures/identities";
import { setRlsClient, clearRlsClient } from "./rls-client-context";
import { getSessionByIdAdmin } from "./db-assertions";

const { getNextSessionCard } = await import("@/lib/sessions/dal");
const { runSubmitAnswer, defaultSubmitAnswerDeps } = await import("@/lib/learning/submit-answer");

/**
 * Phase F0 scenario 16: get_next_session_card() against a real local
 * database, through the same trusted DAL (lib/sessions/dal.ts) the future
 * Session UI will call -- never simulated/hand-rolled queue logic. Proves
 * the two properties DATABASE_SCHEMA.md 4.4/4.6/4.7/9.1/10.3/11 require
 * for the F1 vertical slice to be safe to build on:
 *
 *   1. start_or_resume_session() -> getNextSessionCard() ->
 *      runSubmitAnswer() (using exactly the card getNextSessionCard()
 *      returned) -> getNextSessionCard() again returns a DIFFERENT
 *      eligible card, reflecting the real DB-persisted cooldown state --
 *      not a client-side guess.
 *   2. Exit/pause equivalent: merely reading the next card (no answer
 *      submitted) never mutates the active session -- it stays 'active'
 *      with unchanged battle state, exactly like leaving the Session
 *      screen and returning later must not finish/mutate anything.
 */
describe("get_next_session_card (real database)", () => {
  let tester: ProvisionedTester;
  let sessionId: string;

  beforeAll(async () => {
    await resetTesterLearnerData(NEXT_CARD_TESTER);
    tester = await provisionTesterWithDeck(NEXT_CARD_TESTER);
    // A freshly duplicated deck has no LEARNED/due cards yet, so the
    // session starts directly in learning mode (mirrors
    // 05-queue-transition.test.ts's own documented behavior).
    const session = await startOrResumeSessionFor(tester);
    sessionId = session.id;
    setRlsClient(tester.client);
  });

  afterAll(() => {
    clearRlsClient();
  });

  it("returns the same eligible card on a repeated read, without mutating the active session", async () => {
    const sessionBefore = await getSessionByIdAdmin(sessionId);
    expect(sessionBefore.status).toBe("active");

    const first = await getNextSessionCard(sessionId);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;

    const second = await getNextSessionCard(sessionId);
    expect(second.status).toBe("ok");
    if (second.status !== "ok") return;

    // Same card, same battle snapshot -- reading twice with no answer in
    // between must be side-effect-free.
    expect(second.cardId).toBe(first.cardId);
    expect(second.combo).toBe(first.combo);
    expect(second.enemyHp).toBe(first.enemyHp);

    const sessionAfter = await getSessionByIdAdmin(sessionId);
    expect(sessionAfter.status).toBe("active"); // exit/pause equivalent: never finished
    expect(sessionAfter.learning_draw_index).toBe(sessionBefore.learning_draw_index);
    expect(sessionAfter.current_enemy_hp).toBe(sessionBefore.current_enemy_hp);
    expect(sessionAfter.current_combo).toBe(sessionBefore.current_combo);
  });

  it("start_or_resume_session -> getNextSessionCard -> runSubmitAnswer -> getNextSessionCard returns a different eligible card", async () => {
    const first = await getNextSessionCard(sessionId);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;

    const clientEventId = crypto.randomUUID();
    const answerResult = await runSubmitAnswer(
      { clientEventId, sessionId, cardId: first.cardId, correct: true, responseTimeMs: 1500 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );
    expect(answerResult.ok).toBe(true);

    const second = await getNextSessionCard(sessionId);
    expect(second.status).toBe("ok");
    if (second.status !== "ok") return;

    // first.cardId just went on an 11-draw Learning cooldown (real
    // commit_answer_transaction()-persisted state, not re-derived here) --
    // the very next read must reflect that and offer a different card.
    expect(second.cardId).not.toBe(first.cardId);
    expect(second.sessionMode).toBe("learning");
  });
});
