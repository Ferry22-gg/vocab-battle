import { requireOnboardedTester } from "@/lib/auth/dal";
import { getStatsSummary } from "@/lib/stats/dal";
import { formatEstimatedStudyTime } from "@/lib/stats/aggregate";
import { computeLevelProgress, xpProgressPercent } from "@/lib/home/level-progress";
import { BottomNav } from "@/app/home/bottom-nav";
import { ProgressSummaryCard } from "./progress-summary-card";
import { TodayCard } from "./today-card";
import { LearningProgressCard } from "./learning-progress-card";
import { WeeklyActivityCard } from "./weekly-activity-card";
import { PersonalBestCard } from "./personal-best-card";
import { LifetimeStatsCard } from "./lifetime-stats-card";

/**
 * P3 Stats screen, Alpha redesign: player-facing progress, not a
 * scheduler/analytics dashboard. requireOnboardedTester() is the single
 * gate, same as Home (app/page.tsx) and Decks (app/decks/page.tsx). No
 * FSRS internals (due/review/new counts, scheduling state) appear here --
 * only accomplishment-oriented numbers already shown or safely derivable
 * from Home's own authoritative sources. Accuracy is deliberately never
 * rendered anywhere on this page (lib/stats/dal.ts still computes it
 * internally, for telemetry continuity only).
 *
 * Six sections, in order: Top Summary, Today, Learning Progress, This
 * Week, Personal Best, Lifetime -- see lib/stats/dal.ts's own header for
 * every metric's authoritative source and scope.
 */
export default async function StatsPage() {
  await requireOnboardedTester();
  const stats = await getStatsSummary();
  const { currentLevelXp, xpForNextLevel } = computeLevelProgress(stats.totalXp, stats.level);
  const xpPercent = xpProgressPercent(currentLevelXp, xpForNextLevel);
  const todayStudyTimeLabel = formatEstimatedStudyTime(stats.todayStudyTimeMs);
  const lifetimeStudyTimeLabel = formatEstimatedStudyTime(stats.lifetimeStudyTimeMs);

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-emerald-950">
      <div className="relative mx-auto flex w-full max-w-md flex-1 flex-col overflow-y-auto px-4 pt-[calc(env(safe-area-inset-top,0px)+16px)] pb-[calc(env(safe-area-inset-bottom,0px)+114px)]">
        <h1 className="mb-5 text-xl font-extrabold text-white">Stats</h1>

        <div className="flex flex-col gap-3">
          <ProgressSummaryCard
            level={stats.level}
            currentLevelXp={currentLevelXp}
            xpForNextLevel={xpForNextLevel}
            xpPercent={xpPercent}
            streak={stats.currentStreak}
          />
          <TodayCard
            answers={stats.todayAnswers}
            wordsStudied={stats.todayWordsStudied}
            wordsLearned={stats.todayWordsLearned}
            xp={stats.todayXp}
            studyTimeLabel={todayStudyTimeLabel}
          />
          <LearningProgressCard progress={stats.learningProgress} />
          <WeeklyActivityCard days={stats.weeklyActivity} />
          <PersonalBestCard
            bestCombo={stats.bestCombo}
            longestStreak={stats.longestStreak}
            mostAnswersInADay={stats.mostAnswersInADay}
            mostXpInADay={stats.mostXpInADay}
          />
          <LifetimeStatsCard
            totalAnswers={stats.totalAnswers}
            wordsLearned={stats.wordsLearnedLifetime}
            wordsMastered={stats.wordsMasteredLifetime}
            studyDays={stats.studyDays}
            totalEnemiesDefeated={stats.totalEnemiesDefeated}
            totalXp={stats.totalXp}
            studyTimeLabel={lifetimeStudyTimeLabel}
          />
        </div>
      </div>

      <BottomNav active="stats" />
    </div>
  );
}
