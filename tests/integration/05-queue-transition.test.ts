import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, pickCards, type ProvisionedTester } from "./fixtures/provision";
import { QUEUE_TESTER } from "./fixtures/identities";
import { setRlsClient, clearRlsClient } from "./rls-client-context";
import { updateUserCardProgressAdmin, getSessionByIdAdmin, getAnswerEventByClientEventIdAdmin, countAnswerEventsByClientEventId } from "./db-assertions";

const { runSubmitAnswer, defaultSubmitAnswerDeps } = await import("@/lib/learning/submit-answer");

/**
 * Phase E scenario 11: the real Review -> Learning session-mode
 * transition (commit_answer_transaction()'s own logic, never
 * reimplemented in TypeScript), proof that a later submission reads the
 * NEW current_mode from a fresh DB read rather than any cached value, and
 * one real Learning-cooldown rejection.
 */
describe("review/learning queue transition (real commit_answer_transaction)", () => {
  let tester: ProvisionedTester;
  let cardReview: string;
  let cardLearning: string;
  let sessionId: string;

  beforeAll(async () => {
    await resetTesterLearnerData(QUEUE_TESTER);
    tester = await provisionTesterWithDeck(QUEUE_TESTER);
    [cardReview, cardLearning] = await pickCards(tester, 2);

    // Legitimate fixture-setup use of admin access: hand-craft one
    // already-LEARNED, already-due card so start_or_resume_session()'s
    // real due-review query (DATABASE_SCHEMA.md 10.2) picks it up when the
    // session is created below -- the review-queue seeding itself is the
    // real RPC's own doing, not simulated here.
    const pastDue = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const pastReview = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await updateUserCardProgressAdmin(tester.userId, cardReview, {
      card_status: "LEARNED",
      seen_count: 5,
      correct_streak: 4,
      fsrs_state: 2, // State.Review
      fsrs_due_at: pastDue,
      fsrs_stability: 10,
      fsrs_difficulty: 5,
      fsrs_elapsed_days: 20,
      fsrs_scheduled_days: 20,
      fsrs_reps: 3,
      fsrs_lapses: 0,
      fsrs_learning_steps: 0,
      fsrs_last_review_at: pastReview,
    });

    const session = await startOrResumeSessionFor(tester);
    sessionId = session.id;
    setRlsClient(tester.client);
  });

  afterAll(() => {
    clearRlsClient();
  });

  it("starts in review mode with the due card seeded into the queue", async () => {
    const sessionRow = await getSessionByIdAdmin(sessionId);
    expect(sessionRow.current_mode).toBe("review");
    expect(sessionRow.started_with_reviews).toBe(true);
  });

  it("clearing the only due review transitions the session to learning (RPC-owned, not TS-derived)", async () => {
    const clientEventId = crypto.randomUUID();
    const result = await runSubmitAnswer(
      { clientEventId, sessionId, cardId: cardReview, correct: true, responseTimeMs: 1500 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const answerEvent = await getAnswerEventByClientEventIdAdmin(clientEventId);
    expect(answerEvent.session_mode).toBe("review");
    expect(answerEvent.card_status_after).toBe("LEARNED"); // first Correct in review -> stays LEARNED

    const sessionAfter = await getSessionByIdAdmin(sessionId);
    expect(sessionAfter.current_mode).toBe("learning");
    expect(sessionAfter.reviews_completed_at).not.toBeNull();
  });

  it("a subsequent submission reads the NEW current_mode from a fresh DB read, not a cached value", async () => {
    const clientEventId = crypto.randomUUID();
    const result = await runSubmitAnswer(
      { clientEventId, sessionId, cardId: cardLearning, correct: true, responseTimeMs: 1500 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );

    expect(result.ok).toBe(true);
    const answerEvent = await getAnswerEventByClientEventIdAdmin(clientEventId);
    // This orchestration call never received "learning" as an input --
    // getActiveSessionById() read it fresh from the row the previous test
    // just mutated via the real RPC.
    expect(answerEvent.session_mode).toBe("learning");
  });

  it("a real Learning-cooldown rejection: redrawing the same just-answered card immediately is refused", async () => {
    const clientEventId = crypto.randomUUID();
    const result = await runSubmitAnswer(
      { clientEventId, sessionId, cardId: cardLearning, correct: true, responseTimeMs: 1500 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("COMMIT_FAILED"); // real 22023 cooldown rejection, not a TS-invented check
    expect(await countAnswerEventsByClientEventId(clientEventId)).toBe(0);
  });
});
