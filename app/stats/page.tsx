import { requireOnboardedTester } from "@/lib/auth/dal";
import { getStatsSummary } from "@/lib/stats/dal";
import { computeLevelProgress, xpProgressPercent } from "@/lib/home/level-progress";
import { BottomNav } from "@/app/home/bottom-nav";
import { ProgressSummaryCard } from "./progress-summary-card";
import { WeeklyActivityCard } from "./weekly-activity-card";
import { LifetimeStatsCard } from "./lifetime-stats-card";
import { PerformanceCard } from "./performance-card";

/**
 * P3 Stats screen (docs/MVP_SPEC_FOR_CLAUDE.md section 29): player-facing
 * progress, not a scheduler/analytics dashboard. requireOnboardedTester()
 * is the single gate, same as Home (app/page.tsx) and Decks
 * (app/decks/page.tsx). No FSRS internals (due/review/new counts,
 * scheduling state) appear here -- only accomplishment-oriented numbers
 * already shown or safely derivable from Home's own authoritative sources.
 */
export default async function StatsPage() {
  await requireOnboardedTester();
  const stats = await getStatsSummary();
  const { currentLevelXp, xpForNextLevel } = computeLevelProgress(stats.totalXp, stats.level);
  const xpPercent = xpProgressPercent(currentLevelXp, xpForNextLevel);

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
          <WeeklyActivityCard days={stats.weeklyActivity} />
          <LifetimeStatsCard
            totalEnemiesDefeated={stats.totalEnemiesDefeated}
            cardsMastered={stats.cardsMastered}
            totalXp={stats.totalXp}
          />
          <PerformanceCard accuracyPercent={stats.accuracyPercent} bestCombo={stats.bestCombo} />
        </div>
      </div>

      <BottomNav active="stats" />
    </div>
  );
}
