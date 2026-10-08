/**
 * Top Summary card (Alpha Stats redesign, section 1): Level, XP-to-next-level
 * progress bar, Current Streak. Deliberately reuses the same
 * `computeLevelProgress`/`xpProgressPercent` math and
 * `profiles.level`/`total_xp`/`current_streak` source Home's HomeHeader
 * already renders (app/home/home-header.tsx) -- this card never re-derives
 * level/XP itself, only lays the same numbers out larger, as this screen's
 * lead card. Today's Study Time lives in the dedicated Today card instead
 * (app/stats/today-card.tsx), not here.
 */
export function ProgressSummaryCard({
  level,
  currentLevelXp,
  xpForNextLevel,
  xpPercent,
  streak,
}: {
  readonly level: number;
  readonly currentLevelXp: number;
  readonly xpForNextLevel: number;
  readonly xpPercent: number;
  readonly streak: number;
}) {
  return (
    <section className="rounded-3xl border border-white/15 bg-emerald-950/60 px-4 py-4 shadow-lg backdrop-blur-sm">
      <div className="flex items-center gap-3.5">
        <div
          className="flex shrink-0 flex-col items-center rounded-xl bg-gradient-to-b from-amber-400 to-amber-600 px-3.5 py-2 leading-none text-white shadow ring-1 ring-amber-200/60"
          aria-label={`Level ${level}`}
        >
          <span className="text-[10px] font-semibold uppercase tracking-wide">Lv.</span>
          <span className="text-2xl font-extrabold">{level}</span>
        </div>

        <div className="min-w-0 flex-1">
          <span className="whitespace-nowrap text-sm font-semibold text-emerald-50">
            {currentLevelXp} / {xpForNextLevel} XP
          </span>
          <div
            role="progressbar"
            aria-label="Progress to next level"
            aria-valuemin={0}
            aria-valuemax={xpForNextLevel}
            aria-valuenow={currentLevelXp}
            className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-emerald-900/70"
          >
            <div className="h-full rounded-full bg-orange-400" style={{ width: `${xpPercent}%` }} />
          </div>
        </div>
      </div>

      <div className="mt-3.5 flex items-center gap-1.5 border-t border-white/10 pt-3 text-sm font-bold text-orange-300">
        <span aria-hidden="true">🔥</span>
        <span aria-label={`${streak} day streak`}>{streak} day streak</span>
      </div>
    </section>
  );
}
