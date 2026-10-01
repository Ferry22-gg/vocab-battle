import { StatTile } from "./stat-tile";

/**
 * Performance card (P3 Stats spec section 3/8/12): Accuracy, plus Best
 * Combo since it is already safely supported by `daily_user_stats.longest_combo`
 * (lib/stats/aggregate.ts's computeBestCombo). `null` renders as "--", never
 * a misleading `0%`/`x0` -- the empty state for a tester who has no
 * recorded answers/activity yet.
 */
export function PerformanceCard({
  accuracyPercent,
  bestCombo,
}: {
  readonly accuracyPercent: number | null;
  readonly bestCombo: number | null;
}) {
  return (
    <section className="rounded-3xl border border-white/10 bg-emerald-950/70 px-4 py-4 shadow-md backdrop-blur-sm">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-emerald-100/60">Performance</h2>
      <div className="grid grid-cols-2 gap-2.5">
        <StatTile icon="🎯" label="Accuracy" value={accuracyPercent === null ? "—" : `${accuracyPercent}%`} />
        <StatTile icon="🔥" label="Best Combo" value={bestCombo === null ? "—" : `x${bestCombo}`} />
      </div>
      {accuracyPercent === null && <p className="mt-2.5 text-xs text-emerald-100/50">No answers yet</p>}
    </section>
  );
}
