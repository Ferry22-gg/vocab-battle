import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, pickCards, type ProvisionedTester } from "./fixtures/provision";
import { DAILY_GOAL_TESTER } from "./fixtures/identities";
import { setRlsClient, clearRlsClient } from "./rls-client-context";
import {
  updateSessionAdmin,
  upsertDailyUserStatsAdmin,
  getDailyUserStatsAdmin,
  getProfileAdmin,
  getXpEventsForAnswerEventAdmin,
  getAnswerEventByClientEventIdAdmin,
  todayInTokyo,
  countAnswerEventsByClientEventId,
} from "./db-assertions";
import { createAdminClient } from "./admin-client";

const { runSubmitAnswer, defaultSubmitAnswerDeps } = await import("@/lib/learning/submit-answer");

function yesterdayInTokyo(): string {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return yesterday.toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

/**
 * Phase E scenario 13: a real Daily Goal completion (triggering exactly
 * at the 5th enemy defeat) and streak increment, plus proof that a replay
 * of the goal-completing answer does not duplicate either reward. Uses a
 * fixture prepared near the threshold (4 already defeated today) rather
 * than playing through 4 real enemy defeats first, per the task's
 * explicit allowance -- the completion transition itself is entirely the
 * real RPC's doing.
 */
describe("Daily Goal and streak (real commit_answer_transaction)", () => {
  let tester: ProvisionedTester;
  let sessionId: string;
  let cardId: string;
  let secondCardId: string;

  beforeAll(async () => {
    await resetTesterLearnerData(DAILY_GOAL_TESTER);
    tester = await provisionTesterWithDeck(DAILY_GOAL_TESTER);
    // Two distinct cards: the goal-completing answer in test 1 puts cardId
    // into a real 10-draw Learning cooldown (DATABASE_SCHEMA.md 11.3), so
    // test 2's replay check needs its own fresh card, not a second real
    // submission to the same one.
    [cardId, secondCardId] = await pickCards(tester, 2);
    const session = await startOrResumeSessionFor(tester);
    sessionId = session.id;

    // Legitimate fixture-setup use of admin access: enemy HP low enough
    // for a guaranteed-lethal correct answer, and today's daily_user_stats
    // already at 4/5 enemies with the goal not yet completed, and
    // yesterday as the profile's last completion date so today's
    // completion is expected to increment the streak by exactly 1
    // (DATABASE_SCHEMA.md 10.5). The completion/XP/streak transition
    // itself is entirely the real RPC's doing.
    await updateSessionAdmin(sessionId, { current_enemy_hp: 1 });
    await upsertDailyUserStatsAdmin(tester.userId, todayInTokyo(), {
      enemies_defeated: 4,
      daily_goal_completed: false,
      total_answers: 4,
      correct_answers: 4,
    });
    const admin = createAdminClient();
    const { error } = await admin
      .from("profiles")
      .update({ current_streak: 3, longest_streak: 3, last_daily_goal_completed_on: yesterdayInTokyo() })
      .eq("id", tester.userId);
    if (error) throw error;

    setRlsClient(tester.client);
  });

  afterAll(() => {
    clearRlsClient();
  });

  it("the 5th enemy defeat of the day completes the Daily Goal exactly once and increments the streak", async () => {
    const clientEventId = crypto.randomUUID();
    const result = await runSubmitAnswer(
      { clientEventId, sessionId, cardId, correct: true, responseTimeMs: 1500 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.dailyGoalJustCompleted).toBe(true);

    const answerEvent = await getAnswerEventByClientEventIdAdmin(clientEventId);
    const xpEvents = await getXpEventsForAnswerEventAdmin(answerEvent.id);
    const goalXp = xpEvents.filter((e: { reason: string }) => e.reason === "daily_goal_completed");
    expect(goalXp).toHaveLength(1);
    expect(goalXp[0].amount).toBe(30);

    const dailyStats = await getDailyUserStatsAdmin(tester.userId, todayInTokyo());
    expect(dailyStats.enemies_defeated).toBe(5);
    expect(dailyStats.daily_goal_completed).toBe(true);
    expect(dailyStats.daily_goal_completed_at).not.toBeNull();

    const profile = await getProfileAdmin(tester.userId);
    expect(profile.current_streak).toBe(4); // 3 -> 4, exactly once
    expect(profile.longest_streak).toBe(4);
    expect(profile.last_daily_goal_completed_on).toBe(todayInTokyo());
  });

  it("replaying the goal-completing answer does not duplicate the XP or streak reward", async () => {
    const clientEventId = crypto.randomUUID();
    const first = await runSubmitAnswer(
      { clientEventId, sessionId, cardId: secondCardId, correct: false, responseTimeMs: 1500 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );
    expect(first.ok).toBe(true);

    const profileAfterFirst = await getProfileAdmin(tester.userId);
    const dailyStatsAfterFirst = await getDailyUserStatsAdmin(tester.userId, todayInTokyo());

    const retry = await runSubmitAnswer(
      { clientEventId, sessionId, cardId: secondCardId, correct: false, responseTimeMs: 1500 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.data.isReplay).toBe(true);

    expect(await countAnswerEventsByClientEventId(clientEventId)).toBe(1);
    const profileAfterRetry = await getProfileAdmin(tester.userId);
    const dailyStatsAfterRetry = await getDailyUserStatsAdmin(tester.userId, todayInTokyo());
    expect(profileAfterRetry).toEqual(profileAfterFirst);
    expect(dailyStatsAfterRetry).toEqual(dailyStatsAfterFirst);
  });
});
