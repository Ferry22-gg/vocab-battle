import type { WeeklyActivityDay } from "@/lib/stats/aggregate";

/**
 * "This Week" activity strip (Alpha Stats redesign, polish A1): Answers
 * committed per Asia/Tokyo calendar day, for the CURRENT Monday->Sunday
 * calendar week (lib/stats/aggregate.ts's currentTokyoWeekDates) -- never
 * a rolling last-7-days window, which would conflict with the "This Week"
 * heading. A future day within the same week (e.g. viewing on a Tuesday)
 * renders as a zero/empty bar, same as a past day with no activity --
 * `days` always arrives Monday-first, so labels naturally read
 * "M T W T F S S", never a different weekday ordering.
 *
 * Answers is a simple, always-meaningful daily activity measure (chosen
 * over enemies-defeated-per-day, which can legitimately be 0 on a day the
 * tester still studied). Plain div-based bars -- no chart library (none
 * added, matching the explicit "do not add a chart dependency for a
 * 7-day Alpha visualization" instruction). A day with 0 answers still
 * renders a small visible stub bar, not a blank gap, so a brand-new
 * tester's all-zero week still looks intentional.
 */
export function WeeklyActivityCard({ days }: { readonly days: readonly WeeklyActivityDay[] }) {
  const maxAnswers = Math.max(1, ...days.map((day) => day.answers));

  return (
    <section className="rounded-3xl border border-white/10 bg-emerald-950/70 px-4 py-4 shadow-md backdrop-blur-sm">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-emerald-100/60">This Week</h2>

      <div className="flex items-end justify-between gap-1.5">
        {days.map((day) => {
          const barPercent = Math.max(Math.round((day.answers / maxAnswers) * 100), day.answers > 0 ? 14 : 6);
          return (
            <div key={day.date} className="flex flex-1 flex-col items-center gap-1.5">
              <div className="flex h-16 w-full items-end justify-center" aria-hidden="true">
                <div
                  className={`w-3.5 rounded-full ${day.answers > 0 ? "bg-orange-400" : "bg-emerald-900/70"}`}
                  style={{ height: `${barPercent}%` }}
                />
              </div>
              <span className="text-[10px] font-semibold text-emerald-100/60">{day.label}</span>
            </div>
          );
        })}
      </div>

      <p className="sr-only">
        Answers per day, last {days.length} days: {days.map((day) => `${day.label} ${day.answers}`).join(", ")}
      </p>
    </section>
  );
}
