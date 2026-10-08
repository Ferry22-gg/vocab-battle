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
      expect(stats.wordsMasteredLifetime).toBe(0);
      expect(stats.wordsLearnedLifetime).toBe(0);
      expect(stats.accuracyPercent).toBeNull();
      expect(stats.bestCombo).toBeNull();
      expect(stats.longestStreak).toBe(0);
      expect(stats.mostAnswersInADay).toBe(0);
      expect(stats.mostXpInADay).toBe(0);
      expect(stats.studyDays).toBe(0);
      expect(stats.todayAnswers).toBe(0);
      expect(stats.todayWordsStudied).toBe(0);
      expect(stats.todayWordsLearned).toBe(0);
      expect(stats.todayXp).toBe(0);
      expect(stats.todayStudyTimeMs).toBe(0);
      expect(stats.weeklyActivity).toHaveLength(7);
      expect(stats.weeklyActivity.every((day) => day.answers === 0)).toBe(true);
      // Stats Alpha polish A1: the week is the current Monday->Sunday
      // calendar week, so today's own slot is wherever today falls in
      // that week -- not necessarily the last entry (a future day in the
      // same week, rendered as a zero bar, can come after it).
      expect(stats.weeklyActivity.some((day) => day.date === todayInTokyo())).toBe(true);
      expect(stats.weeklyActivity[0]!.date <= todayInTokyo()).toBe(true); // Monday (first entry) is never after today

      // A freshly onboarded tester has a full deck of NEW cards and no
      // activity yet -- Learning Progress must still render a real,
      // non-null snapshot (never missing/blank for a brand-new tester).
      expect(stats.learningProgress).not.toBeNull();
      expect(stats.learningProgress?.headlineLearnedCount).toBe(0);
      expect(stats.learningProgress?.masteredCount).toBe(0);
      expect(stats.learningProgress?.totalCards).toBeGreaterThan(0);
      expect(stats.learningProgress?.newCount).toBe(stats.learningProgress?.totalCards);
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
      // total_answers (not enemies_defeated) is the Alpha Stats redesign's
      // "This Week" metric.
      await upsertDailyUserStatsAdmin(testerA.userId, yesterdayInTokyo(), { total_answers: 3 });
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

    it("Words Mastered (lifetime) counts the real LEARNED transition", async () => {
      const stats = await getStatsSummary();
      expect(stats.wordsMasteredLifetime).toBe(1);
    });

    it("Learning Progress reflects the real current card_status for this deck (1 Mastered, 1 Learning, rest New)", async () => {
      const stats = await getStatsSummary();
      expect(stats.learningProgress).not.toBeNull();
      expect(stats.learningProgress?.masteredCount).toBe(1);
      expect(stats.learningProgress?.learningCount).toBe(1);
      expect(stats.learningProgress?.headlineLearnedCount).toBe(1); // ACQUIRED(0) + LEARNED(1) -- the legacy engine masters LEARNING -> LEARNED directly, with no ACQUIRED intermediate stage
      const progress = stats.learningProgress!;
      expect(progress.newCount + progress.learningCount + progress.learnedCount + progress.masteredCount).toBe(progress.totalCards);
    });

    it("Today's Answers/Words Studied reflect the two real committed answers", async () => {
      const stats = await getStatsSummary();
      expect(stats.todayAnswers).toBe(2);
      expect(stats.todayWordsStudied).toBe(2); // two distinct cards (cardId, secondCardId)
      // The legacy mastery transition (LEARNING -> LEARNED) is not an
      // ACQUIRED transition, so it correctly does not count as "Words
      // Learned" under this feature's strict definition (see
      // lib/stats/aggregate.ts's computeTodayWordsLearned doc comment).
      expect(stats.todayWordsLearned).toBe(0);
    });

    it("Accuracy (internal/telemetry only, never rendered) reflects real committed answers lifetime-wide", async () => {
      const stats = await getStatsSummary();
      const todayStats = await getDailyUserStatsAdmin(testerA.userId, todayInTokyo());

      expect(todayStats.total_answers).toBe(2);
      expect(todayStats.correct_answers).toBe(1);
      // accuracyPercent is lifetime-scoped (every daily_user_stats row,
      // not just today) -- 1 correct out of (2 today + 3 seeded
      // yesterday) = 20%. Still computed for internal/telemetry
      // continuity; no component in app/stats/ renders it.
      expect(stats.accuracyPercent).toBe(20);
    });

    it("Best Combo reflects the real per-day longest_combo (one correct answer = combo 1)", async () => {
      const stats = await getStatsSummary();
      expect(stats.bestCombo).toBe(1);
    });

    it("Weekly activity groups today's real answers into today's own slot (wherever today falls in the Monday->Sunday week), and yesterday's seeded activity into yesterday's slot IF yesterday is in the same calendar week", async () => {
      const stats = await getStatsSummary();

      const todayEntry = stats.weeklyActivity.find((day) => day.date === todayInTokyo());
      expect(todayEntry).toBeDefined();
      expect(todayEntry!.answers).toBe(2); // the two real committed answers today

      // Stats Alpha polish A1: "This Week" is the current Monday->Sunday
      // calendar week, not a rolling last-7-days window -- yesterday is
      // only part of the SAME week unless today is itself a Monday (in
      // which case yesterday, Sunday, correctly belongs to last week and
      // must be absent here; that absence is itself the correct,
      // intended behavior, not a gap).
      const yesterdayEntry = stats.weeklyActivity.find((day) => day.date === yesterdayInTokyo());
      if (yesterdayEntry) {
        expect(yesterdayEntry.answers).toBe(3); // seeded directly above
      } else {
        expect(stats.weeklyActivity[0]?.date).toBe(todayInTokyo()); // today IS Monday -- the week's own first entry
      }
    });

    it("Study Days counts today and yesterday (2 distinct active days)", async () => {
      const stats = await getStatsSummary();
      expect(stats.studyDays).toBe(2);
    });

    it("Most Answers in a Day / Most XP in a Day reflect the real per-day maxima", async () => {
      const stats = await getStatsSummary();
      const today = await getDailyUserStatsAdmin(testerA.userId, todayInTokyo());
      expect(stats.mostAnswersInADay).toBeGreaterThanOrEqual(3); // max(today=2, yesterday=3)
      expect(stats.mostXpInADay).toBeGreaterThanOrEqual(today!.xp_gained as number);
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
      expect(statsB.wordsMasteredLifetime).toBe(0);
      expect(statsB.accuracyPercent).toBeNull();
      expect(statsB.bestCombo).toBeNull();
      expect(statsB.weeklyActivity.every((day) => day.answers === 0)).toBe(true);
      expect(statsB.learningProgress?.masteredCount).toBe(0);
      expect(statsB.learningProgress?.learningCount).toBe(0);
    });

    it("tester A's Stats are unaffected by tester B's (empty) read", async () => {
      setRlsClient(testerA.client);
      const statsA = await getStatsSummary();

      expect(statsA.totalEnemiesDefeated).toBeGreaterThan(0);
      expect(statsA.wordsMasteredLifetime).toBe(1);
    });
  });
});
