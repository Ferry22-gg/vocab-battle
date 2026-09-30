import { requireOnboardedTester } from "@/lib/auth/dal";
import { getOwnedDecksWithCardCounts } from "@/lib/decks/dal";
import { BottomNav } from "@/app/home/bottom-nav";
import { DeckRow } from "./deck-row";

/**
 * P3 Decks screen (MVP_UI_SPEC.md section 11, docs/MVP_OVERVIEW.md "Decks
 * and knowledge ownership"): a Spotify-like mental model -- one currently
 * selected deck, plus the tester's other owned decks in a library-like
 * list. requireOnboardedTester() is the single gate, same as Home
 * (app/page.tsx) and Session (app/session/page.tsx).
 *
 * No FSRS internals (due/review/new counts, scheduling state) appear here
 * or in Deck detail -- only name, real card count, and selection state
 * (MVP_UI_SPEC.md 2.2).
 */
export default async function DecksPage() {
  const tester = await requireOnboardedTester();
  const decks = await getOwnedDecksWithCardCounts();

  const selectedDeck = decks.find((deck) => deck.id === tester.selectedDeckId) ?? null;
  const otherDecks = decks.filter((deck) => deck.id !== tester.selectedDeckId);

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-emerald-950">
      <div className="relative mx-auto flex w-full max-w-md flex-1 flex-col overflow-y-auto px-4 pt-[calc(env(safe-area-inset-top,0px)+16px)] pb-[calc(env(safe-area-inset-bottom,0px)+114px)]">
        <h1 className="mb-5 text-xl font-extrabold text-white">Decks</h1>

        {selectedDeck && (
          <section className="mb-6">
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-emerald-100/60">Selected Deck</h2>
            <DeckRow deckId={selectedDeck.id} name={selectedDeck.name} cardCount={selectedDeck.cardCount} selected />
          </section>
        )}

        <section>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-emerald-100/60">Your Decks</h2>
          {otherDecks.length === 0 ? (
            <p className="text-sm text-emerald-100/60">No other decks yet.</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {otherDecks.map((deck) => (
                <DeckRow key={deck.id} deckId={deck.id} name={deck.name} cardCount={deck.cardCount} selected={false} />
              ))}
            </div>
          )}
        </section>
      </div>

      <BottomNav active="decks" />
    </div>
  );
}
