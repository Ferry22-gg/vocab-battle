import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, pickCards, type ProvisionedTester } from "./fixtures/provision";
import { CORE_ANSWER_TESTER } from "./fixtures/identities";
import { setRlsClient, clearRlsClient } from "./rls-client-context";
import {
  getAnswerEventByClientEventIdAdmin,
  getUserCardProgressAdmin,
  getSessionByIdAdmin,
  getXpEventsForAnswerEventAdmin,
  getProfileAdmin,
  getDailyUserStatsAdmin,
  todayInTokyo,
} from "./db-assertions";

const { runSubmitAnswer, defaultSubmitAnswerDeps } = await import("@/lib/learning/submit-answer");
const { BATTLE_CONFIG } = await import("@/lib/learning/config");

/**
 * Phase E scenarios 5-6: a real correct answer and a real wrong answer,
 * each on its own fresh card so mutations never interfere, verified
 * against the actual persisted rows (never re-derived in TypeScript).
 */
describe("core answer scenarios (real commit_answer_transaction)", () => {
  let tester: ProvisionedTester;
  let sessionId: string;
  let correctCardId: string;
  let wrongCardId: string;

  beforeAll(async () => {
    await resetTesterLearnerData(CORE_ANSWER_TESTER);
    tester = await provisionTesterWithDeck(CORE_ANSWER_TESTER);
    const [cardA, cardB] = await pickCards(tester, 2);
    correctCardId = cardA;
    wrongCardId = cardB;
    const session = await startOrResumeSessionFor(tester);
    sessionId = session.id;
  });

  afterAll(() => {
    clearRlsClient();
  });

  it("scenario 5: a correct answer persists exactly the expected state", async () => {
    setRlsClient(tester.client);

    const sessionBefore = await getSessionByIdAdmin(sessionId);
    const progressBefore = await getUserCardProgressAdmin(tester.userId, correctCardId);
    expect(progressBefore).toMatchObject({ card_status: "NEW", seen_count: 0, correct_streak: 0, wrong_streak: 0 });

    const clientEventId = crypto.randomUUID();
    const result = await runSubmitAnswer(
      { clientEventId, sessionId, cardId: correctCardId, correct: true, responseTimeMs: 1500 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // -- answer_events --
    const answerEvent = await getAnswerEventByClientEventIdAdmin(clientEventId);
    expect(answerEvent).toMatchObject({
      client_event_id: clientEventId,
      correct: true,
      session_id: sessionId,
      card_id: correctCardId,
      // seenCount=1 (post-increment) at 1500ms: below EASY_RESPONSE_THRESHOLD_MS
      // but seen_count(1) < EASY_MIN_SEEN_COUNT -- estimator falls through to Good.
      fsrs_rating: "Good",
      base_damage: expect.any(Number),
      damage: expect.any(Number),
      combo: 1,
    });
    expect(answerEvent.base_damage).toBeGreaterThanOrEqual(BATTLE_CONFIG.BASE_DAMAGE_MIN);
    expect(answerEvent.base_damage).toBeLessThanOrEqual(BATTLE_CONFIG.BASE_DAMAGE_MAX);
    expect(answerEvent.enemy_hp_before).toBe(sessionBefore.current_enemy_hp);
    expect(answerEvent.enemy_hp_after).toBe(sessionBefore.current_enemy_hp - answerEvent.damage);
    expect(result.data.damage).toBe(answerEvent.damage);
    expect(result.data.rating).toBe("Good");

    // -- user_card_progress --
    const progressAfter = await getUserCardProgressAdmin(tester.userId, correctCardId);
    expect(progressAfter).toMatchObject({
      card_status: "LEARNING", // NEW -> LEARNING on first exposure, not mastered yet
      seen_count: 1,
      correct_streak: 1,
      wrong_streak: 0,
    });
    // FSRS fields persisted from ts-fsrs output, and due/last_review round-trip
    // as genuine timestamps (D3b fix), not null and not Invalid Date.
    expect(progressAfter.fsrs_state).not.toBeNull();
    expect(progressAfter.fsrs_due_at).not.toBeNull();
    expect(progressAfter.fsrs_last_review_at).not.toBeNull();
    expect(Number.isNaN(new Date(progressAfter.fsrs_due_at).getTime())).toBe(false);
    expect(Number.isNaN(new Date(progressAfter.fsrs_last_review_at).getTime())).toBe(false);
    expect(progressAfter.fsrs_reps).toBe(1);

    // -- sessions --
    const sessionAfter = await getSessionByIdAdmin(sessionId);
    expect(sessionAfter.current_combo).toBe(1);
    expect(sessionAfter.current_enemy_hp).toBe(answerEvent.enemy_hp_after);
    expect(sessionAfter.learning_draw_index).toBe(1);
    expect(sessionAfter.current_mode).toBe("learning");

    // -- xp_events --
    const xpEvents = await getXpEventsForAnswerEventAdmin(answerEvent.id);
    expect(xpEvents).toHaveLength(1);
    expect(xpEvents[0]).toMatchObject({ reason: "correct_answer", amount: 2 });

    // -- profiles / daily_user_stats --
    const profile = await getProfileAdmin(tester.userId);
    expect(profile.total_xp).toBeGreaterThanOrEqual(2);
    const dailyStats = await getDailyUserStatsAdmin(tester.userId, todayInTokyo());
    expect(dailyStats).not.toBeNull();
    expect(dailyStats.correct_answers).toBeGreaterThanOrEqual(1);
    expect(dailyStats.total_answers).toBeGreaterThanOrEqual(1);
  });

  it("scenario 6: a wrong answer resets combo, deals zero damage, and rates Again", async () => {
    setRlsClient(tester.client);

    const sessionBeforeWrong = await getSessionByIdAdmin(sessionId);
    const clientEventId = crypto.randomUUID();

    const result = await runSubmitAnswer(
      { clientEventId, sessionId, cardId: wrongCardId, correct: false, responseTimeMs: 900 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const answerEvent = await getAnswerEventByClientEventIdAdmin(clientEventId);
    expect(answerEvent).toMatchObject({
      correct: false,
      fsrs_rating: "Again",
      base_damage: 0,
      speed_bonus: 0,
      combo: 0,
      damage: 0,
      critical: false,
    });
    expect(answerEvent.enemy_hp_before).toBe(sessionBeforeWrong.current_enemy_hp);
    expect(answerEvent.enemy_hp_after).toBe(sessionBeforeWrong.current_enemy_hp);

    const progressAfter = await getUserCardProgressAdmin(tester.userId, wrongCardId);
    expect(progressAfter).toMatchObject({
      card_status: "LEARNING", // NEW -> LEARNING on first exposure even though it was Wrong
      seen_count: 1,
      correct_streak: 0,
      wrong_streak: 1,
    });
    expect(progressAfter.fsrs_state).not.toBeNull(); // FSRS still advanced, via Again

    const sessionAfter = await getSessionByIdAdmin(sessionId);
    expect(sessionAfter.current_combo).toBe(0); // reset from the previous correct answer's combo=1
    expect(sessionAfter.current_enemy_hp).toBe(sessionBeforeWrong.current_enemy_hp); // unchanged

    // No XP for a Wrong answer.
    const xpEvents = await getXpEventsForAnswerEventAdmin(answerEvent.id);
    expect(xpEvents).toHaveLength(0);

    expect(result.data.rating).toBe("Again");
    expect(result.data.damage).toBe(0);
    expect(result.data.critical).toBe(false);
    expect(result.data.comboAfter).toBe(0);
  });
});
