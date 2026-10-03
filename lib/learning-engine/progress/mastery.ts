/**
 * Pure Mastered-count helpers (spec sections 15.2/28.1/34.1). Mirrors
 * exactly the live aggregation lib/stats/dal.ts's getMasteredCardCount()
 * already performs in SQL -- this pure version exists so the same "only
 * LEARNED counts" rule is independently unit-testable, and so any DAL that
 * already has an array of per-card statuses in hand (e.g.
 * lib/decks/dal.ts's listCardsForDeck) can derive a deck-scoped Mastered
 * count from it without a second query.
 *
 * ACQUIRED and FORGOTTEN deliberately do NOT count (spec section 28.1 /
 * 34.1: "ACQUIRED is not equivalent to LEARNED"; FORGOTTEN is a reversible
 * relearning state, not mastery). The historical `has_ever_been_mastered`/
 * `has_achieved_full_mastery` flags never factor in here -- this is always
 * the CURRENT count, which a lapse may reduce (spec section 28.1).
 */

import type { CardStatus } from "@/lib/learning-engine/state";

export function isMasteredCardStatus(cardStatus: CardStatus): boolean {
  return cardStatus === "LEARNED";
}

export function countMasteredCards(cardStatuses: readonly CardStatus[]): number {
  return cardStatuses.filter(isMasteredCardStatus).length;
}
