import { DAILY_GOAL_TARGET } from "@/lib/learning/daily-goal-dal";

/**
 * Compact Daily Goal card (P3 spec section 7). Shows only "defeat N
 * enemies today" progress -- never FSRS Review/New/Due counts
 * (MVP_UI_SPEC.md 2.2, P3 spec section 3). `enemiesDefeated` arrives
 * already capped at DAILY_GOAL_TARGET by getTodayDailyGoalProgress().
 */
export function DailyGoalCard({
  enemiesDefeated,
  completed,
}: {
  readonly enemiesDefeated: number;
  readonly completed: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-2xl border border-white/10 bg-emerald-950/70 px-3.5 py-3.5 shadow-md backdrop-blur-sm">
      <span aria-hidden="true" className="shrink-0 text-2xl">
        🎯
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-base font-semibold text-white">Daily Goal</p>
        <p className="truncate text-xs text-emerald-100/75">Defeat {DAILY_GOAL_TARGET} enemies today</p>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-l border-white/10 pl-2.5">
        <div className="flex gap-0.5" aria-hidden="true">
          {Array.from({ length: DAILY_GOAL_TARGET }, (_, i) => (
            <span key={i} className={`text-sm ${i < enemiesDefeated ? "opacity-100" : "opacity-25"}`}>
              ⚔️
            </span>
          ))}
        </div>
        <span className="whitespace-nowrap text-sm font-bold text-white">
          {enemiesDefeated} / {DAILY_GOAL_TARGET}
        </span>
      </div>

      <span className="sr-only">
        {completed ? "Daily goal complete: " : "Daily goal progress: "}
        {enemiesDefeated} of {DAILY_GOAL_TARGET} enemies defeated today
      </span>
    </div>
  );
}
