import Link from "next/link";
import { SelectDeckButton } from "./select-deck-button";

/**
 * One Deck card (P3 Decks section 4/5): name + real card count + a clear
 * selected/select affordance, never FSRS internals. The name/count area is
 * a `<Link>` to Deck detail (tap → detail is the preferred interaction);
 * the Select action is a sibling, not nested inside the `<Link>` --
 * interactive content (a `<form>`/`<button>`) cannot validly nest inside
 * an `<a>`.
 */
export function DeckRow({
  deckId,
  name,
  cardCount,
  masteredCount,
  selected,
}: {
  readonly deckId: string;
  readonly name: string;
  readonly cardCount: number;
  readonly masteredCount: number;
  readonly selected: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-2xl border px-4 py-3.5 shadow-md backdrop-blur-sm ${
        selected ? "border-amber-300/50 bg-amber-400/15 ring-1 ring-amber-300/40" : "border-white/10 bg-emerald-950/70"
      }`}
    >
      <Link href={`/decks/${deckId}`} className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold text-white">{name}</p>
        <p className="text-xs text-emerald-100/70">
          {cardCount} {cardCount === 1 ? "card" : "cards"} · {masteredCount} Mastered
        </p>
      </Link>

      {selected ? (
        <span className="shrink-0 whitespace-nowrap text-xs font-bold text-amber-300">✓ Selected</span>
      ) : (
        <SelectDeckButton deckId={deckId} deckName={name} />
      )}
    </div>
  );
}
