import { computeLevelProgress, xpProgressPercent } from "@/lib/home/level-progress";

/**
 * Compact translucent status header (P3 Home). The Level badge sits in a
 * `grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]` layout, not
 * `justify-between`: both side columns are forced to equal width via
 * `minmax(0, 1fr)` regardless of how wide the nickname or XP text is (a
 * bare `1fr` can still grow past its share to fit unshrinkable content),
 * so the center column -- and the Level badge inside it -- is guaranteed
 * to sit at true horizontal center rather than drifting toward whichever
 * side has less content. Side content uses `min-w-0` + `truncate` so a
 * long nickname clips instead of ever pushing that column wider.
 *
 * The side items deliberately do NOT use `justify-self-start`/`-end`:
 * that shrink-wraps a grid item to its content's intrinsic width, which
 * defeats `truncate` entirely (there is no longer a track-width box to
 * clip against, so long content just overflows across the center column
 * instead of ellipsizing). Left at the grid default (`justify-self:
 * stretch`), each side item fills its full `minmax(0,1fr)` track, and
 * internal flex alignment (`justify-end` on the right block; the left
 * block's row order already reads left-to-right) positions its content
 * within that track -- restoring truncate's actual clipping box.
 */
export function HomeHeader({
  nickname,
  streak,
  level,
  totalXp,
}: {
  readonly nickname: string;
  readonly streak: number;
  readonly level: number;
  readonly totalXp: number;
}) {
  const { currentLevelXp, xpForNextLevel } = computeLevelProgress(totalXp, level);
  const percent = xpProgressPercent(currentLevelXp, xpForNextLevel);
  const initial = nickname.trim().charAt(0).toUpperCase() || "?";

  return (
    <header className="mx-3 mt-[calc(env(safe-area-inset-top,0px)+12px)] rounded-3xl border border-white/15 bg-emerald-950/60 px-4 py-3.5 shadow-lg backdrop-blur-sm">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div
            aria-hidden="true"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-xs font-bold text-white ring-1 ring-white/30"
          >
            {initial}
          </div>
          <span className="min-w-0 truncate text-sm font-semibold text-white">{nickname}</span>
          <span className="flex shrink-0 items-center gap-0.5 text-sm font-bold text-orange-300">
            <span aria-hidden="true">🔥</span>
            <span aria-label={`${streak} day streak`}>{streak}</span>
          </span>
        </div>

        <div className="justify-self-center">
          <div
            className="flex flex-col items-center rounded-xl bg-gradient-to-b from-amber-400 to-amber-600 px-3 py-1.5 leading-none text-white shadow ring-1 ring-amber-200/60"
            aria-label={`Level ${level}`}
          >
            <span className="text-[10px] font-semibold uppercase tracking-wide">Lv.</span>
            <span className="text-lg font-extrabold">{level}</span>
          </div>
        </div>

        <div className="flex min-w-0 flex-col items-end gap-1.5">
          <span className="whitespace-nowrap text-sm font-semibold text-emerald-50">
            {currentLevelXp} / {xpForNextLevel} XP
          </span>
          <div
            role="progressbar"
            aria-label="Progress to next level"
            aria-valuemin={0}
            aria-valuemax={xpForNextLevel}
            aria-valuenow={currentLevelXp}
            className="h-2 w-24 overflow-hidden rounded-full bg-emerald-900/70"
          >
            <div className="h-full rounded-full bg-orange-400" style={{ width: `${percent}%` }} />
          </div>
        </div>
      </div>
    </header>
  );
}
