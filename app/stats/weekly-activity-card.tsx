import type { WeeklyActivityDay } from "@/lib/stats/aggregate";

/**
 * "This Week" activity strip (P3 Stats spec section 5): enemies defeated
 * per Asia/Tokyo calendar day, the last WEEKLY_ACTIVITY_WINDOW_DAYS days
 * (lib/stats/dal.ts). Plain div-based bars -- no chart library, per spec
 * ("do not add a chart dependency for a 7-day Alpha visualization"). Never
 * shows FSRS due/review/new counts, only the enemies-defeated activity
 * measure.
 */
export function WeeklyActivityCard({ days }: { readonly days: readonly WeeklyActivityDay[] }) {
  const maxDefeated = Math.max(1, ...days.map((day) => day.enemiesDefeated));

  return (
    <section className="rounded-3xl border border-white/10 bg-emerald-950/70 px-4 py-4 shadow-md backdrop-blur-sm">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-emerald-100/60">This Week</h2>

      <div className="flex items-end justify-between gap-1.5">
        {days.map((day) => {
          const barPercent = Math.max(Math.round((day.enemiesDefeated / maxDefeated) * 100), day.enemiesDefeated > 0 ? 14 : 6);
          return (
            <div key={day.date} className="flex flex-1 flex-col items-center gap-1.5">
              <div className="flex h-16 w-full items-end justify-center" aria-hidden="true">
                <div
                  className={`w-3.5 rounded-full ${day.enemiesDefeated > 0 ? "bg-orange-400" : "bg-emerald-900/70"}`}
                  style={{ height: `${barPercent}%` }}
                />
              </div>
              <span className="text-[10px] font-semibold text-emerald-100/60">{day.label}</span>
            </div>
          );
        })}
      </div>

      <p className="sr-only">
        Enemies defeated per day, last {days.length} days:{" "}
        {days.map((day) => `${day.label} ${day.enemiesDefeated}`).join(", ")}
      </p>
    </section>
  );
}
