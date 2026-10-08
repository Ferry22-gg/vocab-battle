import { StatTile } from "./stat-tile";

/**
 * Lifetime Stats card (Alpha Stats redesign, section 6): account-wide
 * accomplishment totals that never reset, across every deck the tester
 * has ever owned (deck-agnostic -- Learning Progress, by contrast, is
 * scoped to the tester's currently SELECTED deck only; see
 * lib/stats/dal.ts's own header for why each metric picked its scope).
 *
 * Study Time is an Alpha-safe ESTIMATE (lib/stats/aggregate.ts's capped
 * `response_time_ms` sum, card-front-shown -> Reveal-tapped only -- never
 * the full reveal->grade cycle), flagged via StatTile's `hint` rather
 * than extra visible text.
 */
export function LifetimeStatsCard({
  totalAnswers,
  wordsLearned,
  wordsMastered,
  studyDays,
  totalEnemiesDefeated,
  totalXp,
  studyTimeLabel,
}: {
  readonly totalAnswers: number;
  readonly wordsLearned: number;
  readonly wordsMastered: number;
  readonly studyDays: number;
  readonly totalEnemiesDefeated: number;
  readonly totalXp: number;
  readonly studyTimeLabel: string;
}) {
  return (
    <section className="rounded-3xl border border-white/10 bg-emerald-950/70 px-4 py-4 shadow-md backdrop-blur-sm">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-emerald-100/60">Lifetime</h2>
      <div className="grid grid-cols-2 gap-2.5">
        <StatTile icon="✅" label="Total Answers" value={totalAnswers} />
        <StatTile icon="🌱" label="Words Learned" value={wordsLearned} />
        <StatTile icon="🏆" label="Words Mastered" value={wordsMastered} />
        <StatTile icon="📅" label="Study Days" value={studyDays} />
        <StatTile icon="⚔️" label="Enemies Defeated" value={totalEnemiesDefeated} />
        <StatTile icon="✨" label="Total XP" value={totalXp} />
        <div className="col-span-2">
          <StatTile icon="⏱️" label="Study Time" value={studyTimeLabel} hint="Estimated from recall time; may undercount" />
        </div>
      </div>
    </section>
  );
}
