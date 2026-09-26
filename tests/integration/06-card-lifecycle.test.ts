import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, pickCards, type ProvisionedTester } from "./fixtures/provision";
import { LIFECYCLE_TESTER } from "./fixtures/identities";
import { setRlsClient, clearRlsClient } from "./rls-client-context";
import {
  updateUserCardProgressAdmin,
  getUserCardProgressAdmin,
  getAnswerEventByClientEventIdAdmin,
  getXpEventsForAnswerEventAdmin,
} from "./db-assertions";

const { runSubmitAnswer, defaultSubmitAnswerDeps } = await import("@/lib/learning/submit-answer");

/**
 * Phase E scenario 12: the real PostgreSQL-owned card lifecycle
 * transitions -- mastery (LEARNING -> LEARNED) and the double-wrong
 * review path (LEARNED -> FORGOTTEN) -- never derived in TypeScript.
 * Mastery uses a narrowly prepared fixture (seen_count=4,
 * correct_streak=3) one answer short of the threshold, per the task's
 * explicit allowance, rather than looping dozens of real answers; the
 * transition itself still goes through the real RPC.
 */
describe("card lifecycle (real commit_answer_transaction)", () => {
  let tester: ProvisionedTester;
  let cardMastery: string;
  let cardForgotten: string;
  let sessionId: string;

  beforeAll(async () => {
    await resetTesterLearnerData(LIFECYCLE_TESTER);
    tester = await provisionTesterWithDeck(LIFECYCLE_TESTER);
    [cardMastery, cardForgotten] = await pickCards(tester, 2);

    const recentPast = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await updateUserCardProgressAdmin(tester.userId, cardMastery, {
      card_status: "LEARNING",
      seen_count: 4,
      correct_streak: 3,
      wrong_streak: 0,
      fsrs_state: 1, // State.Learning
      fsrs_due_at: recentPast,
      fsrs_stability: 1,
      fsrs_difficulty: 5,
      fsrs_elapsed_days: 0,
      fsrs_scheduled_days: 0,
      fsrs_reps: 4,
      fsrs_lapses: 0,
      fsrs_learning_steps: 1,
      fsrs_last_review_at: recentPast,
    });

    const pastDue = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const pastReview = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await updateUserCardProgressAdmin(tester.userId, cardForgotten, {
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

    // Seeds cardForgotten into the review queue (it's due); cardMastery
    // remains Learning-eligible and untouched by review-queue seeding.
    const session = await startOrResumeSessionFor(tester);
    sessionId = session.id;
    setRlsClient(tester.client);
  });

  afterAll(() => {
    clearRlsClient();
  });

  // Runs BEFORE the mastery test, deliberately: the session starts in
  // 'review' mode (cardForgotten is due), and cardMastery isn't a
  // review-queue entry -- the real RPC rejects a Learning-mode card
  // submitted while sessionMode is still 'review' (it isn't a row in
  // session_review_cards). Clearing the only due review here is what
  // flips the session to 'learning' for the mastery test below, exactly
  // the real Review -> Learning transition exercised in scenario 11.
  it("double-wrong in one review portion: LEARNED -> FORGOTTEN via the real RPC, FSRS history preserved (not reset)", async () => {
    const firstWrong = await runSubmitAnswer(
      { clientEventId: crypto.randomUUID(), sessionId, cardId: cardForgotten, correct: false, responseTimeMs: 2000 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );
    expect(firstWrong.ok).toBe(true);

    const afterFirstWrong = await getUserCardProgressAdmin(tester.userId, cardForgotten);
    expect(afterFirstWrong.card_status).toBe("LEARNED"); // first Wrong in review -> stays LEARNED
    expect(afterFirstWrong.fsrs_reps).toBeGreaterThan(0); // FSRS history preserved, not reset to 0

    const secondWrongClientEventId = crypto.randomUUID();
    const secondWrong = await runSubmitAnswer(
      { clientEventId: secondWrongClientEventId, sessionId, cardId: cardForgotten, correct: false, responseTimeMs: 2000 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );
    expect(secondWrong.ok).toBe(true);

    const answerEvent = await getAnswerEventByClientEventIdAdmin(secondWrongClientEventId);
    expect(answerEvent.card_status_before).toBe("LEARNED");
    expect(answerEvent.card_status_after).toBe("FORGOTTEN"); // RPC-derived

    const afterSecondWrong = await getUserCardProgressAdmin(tester.userId, cardForgotten);
    expect(afterSecondWrong.card_status).toBe("FORGOTTEN");
    // Accumulated FSRS history is preserved through the transition, not
    // reset (DATABASE_SCHEMA.md 11.2).
    expect(afterSecondWrong.fsrs_reps).toBeGreaterThan(0);
    expect(afterSecondWrong.fsrs_stability).not.toBeNull();
  });

  it("mastery: one more correct answer at the threshold transitions LEARNING -> LEARNED via the real RPC", async () => {
    const progressBefore = await getUserCardProgressAdmin(tester.userId, cardMastery);
    expect(progressBefore.first_mastered_at).toBeNull();

    const clientEventId = crypto.randomUUID();
    const result = await runSubmitAnswer(
      { clientEventId, sessionId, cardId: cardMastery, correct: true, responseTimeMs: 1500 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const answerEvent = await getAnswerEventByClientEventIdAdmin(clientEventId);
    expect(answerEvent.card_status_before).toBe("LEARNING");
    expect(answerEvent.card_status_after).toBe("LEARNED"); // RPC-derived, never chosen by TypeScript

    const progressAfter = await getUserCardProgressAdmin(tester.userId, cardMastery);
    expect(progressAfter.card_status).toBe("LEARNED");
    expect(progressAfter.seen_count).toBe(5);
    expect(progressAfter.correct_streak).toBe(4);
    expect(progressAfter.first_mastered_at).not.toBeNull();
    expect(progressAfter.last_mastered_at).not.toBeNull();

    const xpEvents = await getXpEventsForAnswerEventAdmin(answerEvent.id);
    const masteryXp = xpEvents.filter((e: { reason: string }) => e.reason === "card_learned");
    expect(masteryXp).toHaveLength(1);
    expect(masteryXp[0].amount).toBe(15);
  });
});
