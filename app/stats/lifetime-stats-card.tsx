import { StatTile } from "./stat-tile";

/**
 * Lifetime Stats card (P3 Stats spec section 3): accomplishment totals that
 * never reset. Total Study Time is deliberately absent -- see
 * lib/stats/dal.ts's header comment for why it isn't persisted yet.
 */
export function LifetimeStatsCard({
  totalEnemiesDefeated,
  cardsMastered,
  totalXp,
}: {
  readonly totalEnemiesDefeated: number;
  readonly cardsMastered: number;
  readonly totalXp: number;
}) {
  return (
    <section className="rounded-3xl border border-white/10 bg-emerald-950/70 px-4 py-4 shadow-md backdrop-blur-sm">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-emerald-100/60">Lifetime Stats</h2>
      <div className="grid grid-cols-3 gap-2.5">
        <StatTile icon="⚔️" label="Enemies Defeated" value={totalEnemiesDefeated} />
        <StatTile icon="📖" label="Cards Mastered" value={cardsMastered} />
        <StatTile icon="✨" label="Total XP" value={totalXp} />
      </div>
    </section>
  );
}
