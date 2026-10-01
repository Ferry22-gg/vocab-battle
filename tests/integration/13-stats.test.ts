import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, pickCards, type ProvisionedTester } from "./fixtures/provision";
import { STATS_TESTER_A, STATS_TESTER_B } from "./fixtures/identities";
import { setRlsClient, clearRlsClient } from "./rls-client-context";
import {
  updateSessionAdmin,
  updateUserCardProgressAdmin,
  upsertDailyUserStatsAdmin,
  getProfileAdmin,
  getDailyUserStatsAdmin,
  todayInTokyo,
} from "./db-assertions";

const { runSubmitAnswer, defaultSubmitAnswerDeps } = await import("@/lib/learning/submit-answer");
const { getStatsSummary } = await import("@/lib/stats/dal");

function yesterdayInTokyo(): string {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return yesterday.toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

/**
 * P3 Stats: verifies lib/stats/dal.ts's getStatsSummary() against real
 * Postgres/RLS -- both a brand-new tester's safe zero/empty state and a
 * tester with real, RPC-driven activity, checked against the exact same
 * ground truth (profiles/daily_user_stats rows) an admin read sees. Also
 * confirms cross-tester isolation, the same real-RLS style as
 * 08-rls-isolation.test.ts.
 */
describe("Stats summary (real commit_answer_transaction + RLS)", () => {
  let testerA: ProvisionedTester;
  let testerB: ProvisionedTester;

  afterAll(() => {
    clearRlsClient();
  });

  describe("a brand-new tester with no activity", () => {
    beforeAll(async () => {
      await resetTesterLearnerData(STATS_TESTER_A);
      testerA = await provisionTesterWithDeck(STATS_TESTER_A);
      setRlsClient(testerA.client);
    });

    it("returns safe zero/null empty-state values, never NaN or a misleading 0%", async () => {
      const stats = await getStatsSummary();

      expect(stats.level).toBe(1);
      expect(stats.totalXp).toBe(0);
      expect(stats.currentStreak).toBe(0);
      expect(stats.totalEnemiesDefeated).toBe(0);
      expect(stats.cardsMastered).toBe(0);
      expect(stats.accuracyPercent).toBeNull();
      expect(stats.bestCombo).toBeNull();
      expect(stats.weeklyActivity).toHaveLength(7);
      expect(stats.weeklyActivity.every((day) => day.enemiesDefeated === 0)).toBe(true);
      expect(stats.weeklyActivity.at(-1)?.date).toBe(todayInTokyo());
    });
  });

  describe("a tester with real activity, driven entirely through the trusted RPC", () => {
    let cardId: string;
    let secondCardId: string;

    beforeAll(async () => {
      await resetTesterLearnerData(STATS_TESTER_A);
      testerA = await provisionTesterWithDeck(STATS_TESTER_A);
      [cardId, secondCardId] = await pickCards(testerA, 2);
      const session = await startOrResumeSessionFor(testerA);

      // Fixture setup only, via admin: enemy HP low enough for a
      // guaranteed-lethal correct answer, and cardId one correct answer
      // away from the real LEARNED mastery threshold (correct_streak >= 4
      // AND seen_count >= 5, DATABASE_SCHEMA.md 4.4). The mastery
      // transition, enemy defeat, XP, and daily_user_stats updates
      // themselves are entirely the real commit_answer_transaction()'s
      // doing.
      await updateSessionAdmin(session.id, { current_enemy_hp: 1 });
      await updateUserCardProgressAdmin(testerA.userId, cardId, {
        card_status: "LEARNING",
        correct_streak: 3,
        wrong_streak: 0,
        seen_count: 4,
      });

      setRlsClient(testerA.client);

      const masteryAnswer = await runSubmitAnswer(
        { clientEventId: crypto.randomUUID(), sessionId: session.id, cardId, correct: true, responseTimeMs: 1500 },
        testerA.userId,
        defaultSubmitAnswerDeps,
      );
      expect(masteryAnswer.ok).toBe(true);

      // A second, wrong answer on a fresh card: gives today a non-perfect
      // accuracy (1 correct / 2 total = 50%) and resets combo back to 0
      // without lowering today's already-recorded longest_combo (1).
      const wrongAnswer = await runSubmitAnswer(
        { clientEventId: crypto.randomUUID(), sessionId: session.id, cardId: secondCardId, correct: false, responseTimeMs: 1500 },
        testerA.userId,
        defaultSubmitAnswerDeps,
      );
      expect(wrongAnswer.ok).toBe(true);

      // Seed yesterday's aggregate directly (no real RPC call ever
      // touches a non-"today" daily_user_stats row) to verify the 7-day
      // window groups a past day's activity into the correct slot.
      await upsertDailyUserStatsAdmin(testerA.userId, yesterdayInTokyo(), { enemies_defeated: 3 });
    });

    it("Level/XP/Streak/lifetime Enemies Defeated match the same profiles row Home reads", async () => {
      const stats = await getStatsSummary();
      const profile = await getProfileAdmin(testerA.userId);

      expect(stats.level).toBe(profile.level);
      expect(stats.totalXp).toBe(profile.total_xp);
      expect(stats.currentStreak).toBe(profile.current_streak);
      expect(stats.totalEnemiesDefeated).toBe(profile.total_enemies_defeated);
      expect(stats.totalEnemiesDefeated).toBeGreaterThan(0); // the lethal-HP answer actually defeated an enemy
    });

    it("Cards Mastered counts the real LEARNED transition", async () => {
      const stats = await getStatsSummary();
      expect(stats.cardsMastered).toBe(1);
    });

    it("Accuracy reflects real committed answers (1 correct / 2 total today = 50%)", async () => {
      const stats = await getStatsSummary();
      const todayStats = await getDailyUserStatsAdmin(testerA.userId, todayInTokyo());

      expect(todayStats.total_answers).toBe(2);
      expect(todayStats.correct_answers).toBe(1);
      expect(stats.accuracyPercent).toBe(50);
    });

    it("Best Combo reflects the real per-day longest_combo (one correct answer = combo 1)", async () => {
      const stats = await getStatsSummary();
      expect(stats.bestCombo).toBe(1);
    });

    it("Weekly activity groups today's and yesterday's enemies_defeated into the correct slots", async () => {
      const stats = await getStatsSummary();
      expect(stats.weeklyActivity.at(-1)?.date).toBe(todayInTokyo());
      expect(stats.weeklyActivity.at(-1)?.enemiesDefeated).toBeGreaterThan(0);
      expect(stats.weeklyActivity.at(-2)?.date).toBe(yesterdayInTokyo());
      expect(stats.weeklyActivity.at(-2)?.enemiesDefeated).toBe(3);
    });
  });

  describe("cross-tester isolation", () => {
    beforeAll(async () => {
      // testerA still carries the real activity seeded in the block above
      // (no reset here) -- testerB is provisioned completely fresh.
      await resetTesterLearnerData(STATS_TESTER_B);
      testerB = await provisionTesterWithDeck(STATS_TESTER_B);
    });

    it("tester B's Stats never reflect tester A's real activity, even read concurrently against the same tables", async () => {
      setRlsClient(testerB.client);
      const statsB = await getStatsSummary();

      expect(statsB.totalEnemiesDefeated).toBe(0);
      expect(statsB.cardsMastered).toBe(0);
      expect(statsB.accuracyPercent).toBeNull();
      expect(statsB.bestCombo).toBeNull();
      expect(statsB.weeklyActivity.every((day) => day.enemiesDefeated === 0)).toBe(true);
    });

    it("tester A's Stats are unaffected by tester B's (empty) read", async () => {
      setRlsClient(testerA.client);
      const statsA = await getStatsSummary();

      expect(statsA.totalEnemiesDefeated).toBeGreaterThan(0);
      expect(statsA.cardsMastered).toBe(1);
    });
  });
});
