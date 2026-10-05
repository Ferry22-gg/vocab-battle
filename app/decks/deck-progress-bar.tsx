import type { DeckProgressResult } from "@/lib/learning-engine/progress/deck-progress";

/**
 * Runtime Cutover RC-E: renders computeDeckProgress()'s own result
 * verbatim -- `null` (not enrolled in Learning Engine v1, or the deck has
 * no cards) renders nothing, and `incomplete` (spec/TODO "Deck Progress
 * live rendering": a v1-shaped read must never guess a percentage for
 * state it cannot classify) renders a neutral unavailable note instead of
 * a number. Never computes or infers progress itself.
 */
export function DeckProgressBar({ result }: { readonly result: DeckProgressResult | null }) {
  if (result === null || result.kind === "empty") {
    return null;
  }

  if (result.kind === "incomplete") {
    return <p className="mt-1.5 text-xs text-emerald-100/50">Deck Progress unavailable</p>;
  }

  const percent = Math.round(result.progress * 100);

  return (
    <div className="mt-1.5">
      <div
        role="progressbar"
        aria-label="Deck Progress"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
      >
        <div
          className="h-full rounded-full bg-amber-400 transition-[width] duration-500 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-emerald-100/60">{percent}% Deck Progress</p>
    </div>
  );
}
