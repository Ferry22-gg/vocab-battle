import { StatTile } from "./stat-tile";
import type { LearningProgressCounts } from "@/lib/stats/aggregate";

/**
 * Learning Progress card (Alpha Stats redesign, section 3; headline
 * wording updated by polish A3) -- the screen's visually prominent
 * centerpiece: a progress bar for the tester's currently selected deck,
 * plus the four user-facing tiers (lib/stats/aggregate.ts's
 * computeLearningProgress doc comment has the full backend->user-facing
 * mapping, including why a FORGOTTEN card displays under "Learning").
 *
 * Headline wording: "X / total Learned". The numerator is
 * `headlineLearnedCount` (backend ACQUIRED + LEARNED) -- DELIBERATELY
 * NOT the same number as the "Learned" tile just below it
 * (`learnedCount`, backend ACQUIRED only). Mastered is an advanced state
 * beyond Learned, not a separate category, so a Mastered word still
 * counts as "learned" in the headline -- see
 * lib/stats/aggregate.ts's LearningProgressCounts doc comment for the
 * full reasoning and the explicit "do not conflate / do not fix this
 * overlap" note. It is valid and expected for the headline total to
 * equal `learnedCount + masteredCount` exactly.
 */
export function LearningProgressCard({ progress }: { readonly progress: LearningProgressCounts | null }) {
  if (progress === null) {
    return (
      <section className="rounded-3xl border border-white/10 bg-emerald-950/70 px-4 py-4 shadow-md backdrop-blur-sm">
        <h2 className="mb-1 text-xs font-bold uppercase tracking-wide text-emerald-100/60">Learning Progress</h2>
        <p className="text-sm text-emerald-100/60">No deck selected yet.</p>
      </section>
    );
  }

  const { totalCards, newCount, learningCount, learnedCount, masteredCount, headlineLearnedCount } = progress;
  const percent = totalCards > 0 ? Math.round((headlineLearnedCount / totalCards) * 100) : 0;

  return (
    <section className="rounded-3xl border border-white/10 bg-emerald-950/70 px-4 py-4 shadow-md backdrop-blur-sm">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-emerald-100/60">Learning Progress</h2>

      <div className="mb-4">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-base font-extrabold text-white">
            {headlineLearnedCount} / {totalCards}
          </span>
          <span className="text-xs font-semibold text-emerald-100/60">Learned</span>
        </div>
        <div
          role="progressbar"
          aria-label="Learned"
          aria-valuemin={0}
          aria-valuemax={totalCards}
          aria-valuenow={headlineLearnedCount}
          className="h-3 w-full overflow-hidden rounded-full bg-emerald-900/70"
        >
          <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-teal-300" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <StatTile icon="🆕" label="New" value={newCount} />
        <StatTile icon="📖" label="Learning" value={learningCount} />
        <StatTile icon="🌱" label="Learned" value={learnedCount} />
        <StatTile icon="🏆" label="Mastered" value={masteredCount} />
      </div>
    </section>
  );
}
