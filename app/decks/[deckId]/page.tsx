import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOnboardedTester } from "@/lib/auth/dal";
import { getDeckDetail, listCardsForDeck } from "@/lib/decks/dal";
import { countMasteredCards } from "@/lib/learning-engine/progress/mastery";
import { computeDeckProgress } from "@/lib/learning-engine/progress/deck-progress";
import { isCurrentUserEnrolledInLearningEngineV1 } from "@/lib/learning-engine/progress/dal";
import { SelectDeckButton } from "@/app/decks/select-deck-button";
import { CardStatusBadge } from "@/app/decks/card-status-badge";
import { DeckProgressBar } from "@/app/decks/deck-progress-bar";

/**
 * Minimal P3 Deck detail screen (MVP_UI_SPEC.md section 11): a content
 * view, not a scheduler/debug screen -- name, real card count, selection
 * state, and a plain front/back card list. No FSRS stage/due
 * date/queue/internal metadata.
 *
 * getDeckDetail() returns `null` for both a nonexistent deckId and one the
 * caller's RLS-scoped read cannot see (decks_select_own_or_official_or_admin)
 * -- both become a 404 here, never a distinct "forbidden" response, so
 * this page cannot be used to confirm or deny the existence of a deck the
 * caller does not own.
 */
export default async function DeckDetailPage(props: PageProps<"/decks/[deckId]">) {
  const tester = await requireOnboardedTester();
  const { deckId } = await props.params;

  const deck = await getDeckDetail(deckId);
  if (!deck) {
    notFound();
  }

  const [cards, enrolledInV1] = await Promise.all([
    listCardsForDeck(deckId),
    isCurrentUserEnrolledInLearningEngineV1(),
  ]);
  // Derived from the same query above, not a second DAL round trip -- see
  // getMasteredCountsByDeck()'s doc comment (lib/decks/dal.ts) for why
  // `user_deck_learning_state.mastered_count` is never read for this.
  const masteredCount = countMasteredCards(cards.map((card) => card.cardStatus));
  // Runtime Cutover RC-E: live Deck Progress is enrolled-v1-only (spec/TODO
  // "Deck Progress live rendering") -- a legacy user keeps seeing only the
  // authoritative Mastered count above, never an approximated percentage.
  // Reuses the exact same `cards` read above -- no second query.
  const deckProgress = enrolledInV1
    ? computeDeckProgress(cards.map((card) => ({ cardStatus: card.cardStatus, learningStage: card.learningStage })))
    : null;
  const selected = deck.id === tester.selectedDeckId;
  // Only the caller's own decks can ever be selected (select_deck() only
  // succeeds for a deck the caller owns, DATABASE_SCHEMA.md 10.8) -- an
  // official template reachable only by a direct URL (no link in this
  // phase's UI points at one) has no Select affordance here.
  const canSelect = !selected && deck.ownerUserId !== null;

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-emerald-950">
      <div className="relative mx-auto flex w-full max-w-md flex-1 flex-col overflow-y-auto px-4 pt-[calc(env(safe-area-inset-top,0px)+16px)] pb-[calc(env(safe-area-inset-bottom,0px)+32px)]">
        <Link href="/decks" className="mb-4 self-start text-sm font-medium text-emerald-200/80">
          ‹ Decks
        </Link>

        <div className="mb-6 rounded-2xl border border-white/10 bg-emerald-950/70 p-4 shadow-md">
          <h1 className="text-xl font-extrabold text-white">{deck.name}</h1>
          {deck.description && <p className="mt-1 text-sm text-emerald-100/75">{deck.description}</p>}
          <p className="mt-2 text-xs text-emerald-100/60">
            {deck.cardCount} {deck.cardCount === 1 ? "card" : "cards"} · {masteredCount} Mastered
          </p>

          <DeckProgressBar result={deckProgress} />

          <div className="mt-3">
            {selected ? (
              <span className="inline-block rounded-full bg-amber-400/20 px-3 py-1 text-xs font-bold text-amber-300">
                ✓ Selected
              </span>
            ) : (
              canSelect && <SelectDeckButton deckId={deck.id} deckName={deck.name} />
            )}
          </div>
        </div>

        <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-emerald-100/60">Cards</h2>
        {cards.length === 0 ? (
          <p className="text-sm text-emerald-100/60">This deck has no cards yet.</p>
        ) : (
          <div className="flex flex-col gap-2 pb-4">
            {cards.map((card) => (
              <div
                key={card.id}
                className="flex items-start justify-between gap-3 rounded-xl border border-white/10 bg-emerald-950/60 px-3.5 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">{card.front}</p>
                  <p className="mt-0.5 text-sm text-emerald-100/70">{card.back}</p>
                </div>
                <CardStatusBadge cardStatus={card.cardStatus} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
