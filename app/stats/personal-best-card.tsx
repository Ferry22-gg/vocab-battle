import { StatTile } from "./stat-tile";

/**
 * Personal Best card (Alpha Stats redesign, section 5) -- replaces the
 * retired Performance card. Accuracy is deliberately NOT shown here or
 * anywhere on this screen (telemetry continues internally via
 * lib/stats/dal.ts's `accuracyPercent`, just never rendered). Best Combo
 * is carried over from the retired card; Longest Streak/Most Answers in a
 * Day/Most XP in a Day are new.
 *
 * All four render a genuine `0` for a brand-new tester with no history,
 * never a dash/empty-state placeholder -- "Personal Best" should look
 * intentional from the very first session, not like missing data
 * (section 4 of the task brief). `bestCombo` is the one value whose own
 * pure aggregate (computeBestCombo) can return `null` for "no
 * daily_user_stats history at all" -- coalesced to 0 here, at the
 * UI/display layer only, not by changing that function's own contract
 * (other callers may still care about the real/empty distinction).
 */
export function PersonalBestCard({
  bestCombo,
  longestStreak,
  mostAnswersInADay,
  mostXpInADay,
}: {
  readonly bestCombo: number | null;
  readonly longestStreak: number;
  readonly mostAnswersInADay: number;
  readonly mostXpInADay: number;
}) {
  return (
    <section className="rounded-3xl border border-white/10 bg-emerald-950/70 px-4 py-4 shadow-md backdrop-blur-sm">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-emerald-100/60">Personal Best</h2>
      <div className="grid grid-cols-2 gap-2.5">
        <StatTile icon="🔥" label="Best Combo" value={bestCombo ?? 0} />
        <StatTile icon="📅" label="Longest Streak" value={longestStreak} />
        <StatTile icon="⚡" label="Most Answers/Day" value={mostAnswersInADay} />
        <StatTile icon="💎" label="Most XP/Day" value={mostXpInADay} />
      </div>
    </section>
  );
}
