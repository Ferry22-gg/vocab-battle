/**
 * Read/validation helpers for the two official starter-deck templates used
 * by tester onboarding (app/onboarding/deck). Mirrors the exact predicate
 * duplicate_starter_deck() uses to validate its `p_source_deck_id` argument
 * (supabase/migrations/20260923190000_duplicate_and_session_functions.sql)
 * so the deck ids this module treats as valid are always a subset of what
 * that trusted function would also accept -- this module narrows what the
 * onboarding UI offers and gives a clean error before the RPC call, it does
 * not loosen or replace the RPC's own re-validation.
 *
 * Uses the caller's RLS-scoped client (never service_role): decks with
 * is_official = true are readable by any authenticated user under
 * decks_select_own_or_official_or_admin (grants_and_rls.sql).
 */

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { CardStatus, LearningStage } from "@/lib/learning-engine/state";
import {
  computeDeckProgress,
  type DeckProgressCardInput,
  type DeckProgressResult,
} from "@/lib/learning-engine/progress/deck-progress";

const STARTER_DECK_COLUMNS = "id, name, description";

export type StarterDeck = {
  id: string;
  name: string;
  description: string | null;
};

export const getStarterDecks = cache(async (): Promise<StarterDeck[]> => {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("decks")
    .select(STARTER_DECK_COLUMNS)
    .eq("is_template", true)
    .eq("is_official", true)
    .is("deleted_at", null)
    .order("name", { ascending: true });

  if (error) {
    throw new Error("Failed to load starter decks", { cause: error });
  }

  return data ?? [];
});

/**
 * Fetches a single deck by id for display purposes only (e.g. Home showing
 * the tester's selected deck). Relies entirely on RLS
 * (decks_select_own_or_official_or_admin) to scope this to decks the
 * caller may actually see -- a deck the caller doesn't own and that isn't
 * official/they aren't admin for simply comes back as `null`, the same as
 * a nonexistent id. Not a validity/ownership check for any write path;
 * callers needing that must not rely on this function.
 */
export async function getDeckById(deckId: string): Promise<StarterDeck | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("decks")
    .select(STARTER_DECK_COLUMNS)
    .eq("id", deckId)
    .maybeSingle<StarterDeck>();

  if (error) {
    throw new Error("Failed to load deck", { cause: error });
  }

  return data;
}

/**
 * Server-side membership check for a client-submitted deck id. A deck id
 * "existing" in the table is not sufficient -- it must be one of the
 * official starter templates actually offered, not e.g. another user's
 * public deck or an already-duplicated copy that happens to share an id
 * format. Checked against the same source list rendered to the user,
 * fetched fresh in this request rather than trusting anything the client
 * sent about which decks are valid.
 */
export async function isValidStarterDeckId(deckId: string): Promise<boolean> {
  const decks = await getStarterDecks();
  return decks.some((deck) => deck.id === deckId);
}

// =============================================================================
// P3 Decks screen (docs/DATABASE_SCHEMA.md 4.2/4.3/10.8) -- read APIs for
// the tester's own deck library plus the select_deck() mutation wrapper.
// Every read below is scoped entirely by the caller's RLS-scoped client
// (decks_select_own_or_official_or_admin / cards_select_own_or_official_or_admin,
// grants_and_rls.sql), never service-role, matching every other function in
// this file.
// =============================================================================

/**
 * Counts a deck's non-deleted cards via a `head: true` exact count -- no
 * row data is fetched, only the count. Scoped by RLS
 * (cards_select_own_or_official_or_admin): a deckId the caller cannot see
 * simply counts as 0, the same as an empty deck, since there is no
 * separate "forbidden" signal from a head-count query.
 */
async function getCardCountForDeck(deckId: string): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("cards")
    .select("id", { count: "exact", head: true })
    .eq("deck_id", deckId)
    .is("deleted_at", null);

  if (error) {
    throw new Error("Failed to count deck cards", { cause: error });
  }

  return count ?? 0;
}

export type DeckSummary = {
  id: string;
  name: string;
  description: string | null;
  cardCount: number;
  masteredCount: number;
};

const OWNED_DECK_COLUMNS = "id, name, description";

/**
 * Current (not historical) Mastered count per deck -- `card_status =
 * 'LEARNED'`, excluding soft-deleted cards -- the same authoritative
 * aggregation lib/stats/dal.ts's getMasteredCardCount() already uses
 * globally (spec section 28.1/34.1), bucketed by `deck_id` in one query
 * rather than one query per deck.
 *
 * Deliberately does NOT read `user_deck_learning_state.mastered_count`:
 * that column is only ever set once, by
 * supabase/migrations/20261001000000_learning_engine_v1_additive_schema.sql's
 * backfill `INSERT ... ON CONFLICT DO NOTHING` -- no trigger or trusted
 * function updates it on any live answer today, so it goes stale the
 * moment a tester answers another card. See
 * docs/LEARNING_ENGINE_V1_RUNTIME_CUTOVER_TODO.md.
 *
 * Fetches/filters in TypeScript rather than a nested-relationship
 * PostgREST filter, matching lib/stats/dal.ts's getMasteredCardCount()
 * convention exactly (see that function's own doc comment for why).
 */
export async function getMasteredCountsByDeck(): Promise<Map<string, number>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_card_progress")
    .select("cards!inner(deck_id, deleted_at)")
    .eq("card_status", "LEARNED");

  if (error) {
    throw new Error("Failed to count mastered cards by deck", { cause: error });
  }

  const rows = (data ?? []) as unknown as readonly { cards: { deck_id: string; deleted_at: string | null } }[];
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.cards.deleted_at !== null) continue;
    counts.set(row.cards.deck_id, (counts.get(row.cards.deck_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Lists the caller's own (non-template, non-official) decks with real card
 * counts and current Mastered counts, for the Decks screen
 * (`app/decks/page.tsx`). `is_official = false` excludes official starter
 * templates from this list -- combined with RLS (owner_user_id = auth.uid()
 * OR is_official OR admin), the only rows an ordinary tester can see with
 * is_official = false are their own, so no explicit owner_user_id filter is
 * needed (same no-client-supplied-identity convention as the rest of this
 * codebase). Card counts are fetched in parallel, one head-count query per
 * deck -- simple and correct at the Alpha's deck-per-tester scale; revisit
 * if that scale changes. Mastered counts are fetched once for every deck
 * together (getMasteredCountsByDeck()), not per deck.
 */
export const getOwnedDecksWithCardCounts = cache(async (): Promise<DeckSummary[]> => {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("decks")
    .select(OWNED_DECK_COLUMNS)
    .eq("is_official", false)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error("Failed to load decks", { cause: error });
  }

  const decks = data ?? [];

  const [cardCounts, masteredCounts] = await Promise.all([
    Promise.all(decks.map((deck) => getCardCountForDeck(deck.id))),
    getMasteredCountsByDeck(),
  ]);

  return decks.map((deck, i) => ({
    id: deck.id,
    name: deck.name,
    description: deck.description,
    cardCount: cardCounts[i],
    masteredCount: masteredCounts.get(deck.id) ?? 0,
  }));
});

export type DeckDetail = {
  id: string;
  name: string;
  description: string | null;
  isOfficial: boolean;
  ownerUserId: string | null;
  cardCount: number;
};

const DECK_DETAIL_COLUMNS = "id, name, description, is_official, owner_user_id";

/**
 * Reads one deck's detail (name/description/ownership/real card count) for
 * `app/decks/[deckId]/page.tsx`. Like getDeckById above, relies entirely on
 * RLS to scope this to a deck the caller may actually see -- an
 * inaccessible or nonexistent deckId both come back as `null`, which the
 * page turns into a 404 via `notFound()` rather than a distinct "forbidden"
 * response, so this never confirms or denies the existence of a deck the
 * caller cannot see.
 */
export async function getDeckDetail(deckId: string): Promise<DeckDetail | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("decks")
    .select(DECK_DETAIL_COLUMNS)
    .eq("id", deckId)
    .is("deleted_at", null)
    .maybeSingle<{
      id: string;
      name: string;
      description: string | null;
      is_official: boolean;
      owner_user_id: string | null;
    }>();

  if (error) {
    throw new Error("Failed to load deck", { cause: error });
  }

  if (!data) {
    return null;
  }

  const cardCount = await getCardCountForDeck(deckId);

  return {
    id: data.id,
    name: data.name,
    description: data.description,
    isOfficial: data.is_official,
    ownerUserId: data.owner_user_id,
    cardCount,
  };
}

export type DeckCard = {
  id: string;
  front: string;
  back: string;
  /** The caller's own learning-engine status for this card (spec section 3.1), for CardStatusBadge. Defaults to 'NEW' when no `user_card_progress` row exists yet -- e.g. an official template the caller is viewing but has never duplicated/owned (no per-user progress row is ever created for a template's own cards). */
  cardStatus: CardStatus;
  /**
   * Runtime Cutover RC-E: the caller's own `learning_stage`, for
   * computeDeckProgress() (lib/learning-engine/progress/deck-progress.ts)
   * -- fetched alongside cardStatus so Deck Detail's existing single
   * query also supplies Deck Progress with no second round trip. `null`
   * both when no progress row exists (matching cardStatus's own 'NEW'
   * default) and whenever cardStatus isn't 'LEARNING' -- identical to
   * LearningStage's own documented contract (lib/learning-engine/state.ts).
   */
  learningStage: LearningStage;
};

const DECK_CARD_COLUMNS = "id, front, back, user_card_progress(card_status, learning_stage)";

/**
 * Lists a deck's non-deleted cards in display order, with each card's
 * learner-facing status (via CardStatusBadge/toUserFacingCardStatus), for
 * the Deck detail card list. Scoped by RLS the same way as getDeckDetail --
 * a deck the caller cannot see simply returns an empty list. Callers that
 * need to distinguish "deck inaccessible" from "deck accessible but empty"
 * must check getDeckDetail() first, which this module's own page does.
 *
 * Still queries FROM `cards` (not `user_card_progress`) so an official,
 * not-yet-duplicated template deck's cards still list correctly even
 * though the caller has no progress rows for them -- `user_card_progress`
 * is embedded as a to-many relation (PostgREST has no way to know the
 * (user_id, card_id) uniqueness constraint makes it effectively 0-or-1
 * here), RLS-scoped to the caller's own row, so `[0]` is always either
 * absent or the caller's own single row, never another user's.
 */
export async function listCardsForDeck(deckId: string): Promise<DeckCard[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("cards")
    .select(DECK_CARD_COLUMNS)
    .eq("deck_id", deckId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true });

  if (error) {
    throw new Error("Failed to load deck cards", { cause: error });
  }

  const rows = (data ?? []) as unknown as readonly {
    id: string;
    front: string;
    back: string;
    user_card_progress: readonly { card_status: CardStatus; learning_stage: LearningStage }[];
  }[];

  return rows.map((row) => ({
    id: row.id,
    front: row.front,
    back: row.back,
    cardStatus: row.user_card_progress[0]?.card_status ?? "NEW",
    learningStage: row.user_card_progress[0]?.learning_stage ?? null,
  }));
}

/**
 * Runtime Cutover RC-E: one batched Deck Progress computation per deck id,
 * for the Decks list (`app/decks/page.tsx`) -- mirrors
 * getMasteredCountsByDeck()'s own shape exactly (one query covering every
 * requested deck, never one query per deck) so rendering Deck Progress on
 * every row never becomes an N+1 regression. Like listCardsForDeck, reads
 * FROM `cards` (not `user_card_progress`) so a card with no progress row
 * yet still contributes its correct 'NEW' bucket, and is scoped by the
 * same RLS as every other read in this file.
 */
export async function getDeckProgressByDeck(deckIds: readonly string[]): Promise<Map<string, DeckProgressResult>> {
  if (deckIds.length === 0) {
    return new Map();
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("cards")
    .select("deck_id, user_card_progress(card_status, learning_stage)")
    .in("deck_id", deckIds)
    .is("deleted_at", null);

  if (error) {
    throw new Error("Failed to load deck progress", { cause: error });
  }

  const rows = (data ?? []) as unknown as readonly {
    deck_id: string;
    user_card_progress: readonly { card_status: CardStatus; learning_stage: LearningStage }[];
  }[];

  const cardsByDeck = new Map<string, DeckProgressCardInput[]>();
  for (const row of rows) {
    const cards = cardsByDeck.get(row.deck_id) ?? [];
    cards.push({
      cardStatus: row.user_card_progress[0]?.card_status ?? "NEW",
      learningStage: row.user_card_progress[0]?.learning_stage ?? null,
    });
    cardsByDeck.set(row.deck_id, cards);
  }

  const result = new Map<string, DeckProgressResult>();
  for (const deckId of deckIds) {
    result.set(deckId, computeDeckProgress(cardsByDeck.get(deckId) ?? []));
  }
  return result;
}

/**
 * Switches `profiles.selected_deck_id` to one of the caller's own decks via
 * the trusted `select_deck()` RPC (DATABASE_SCHEMA.md 10.8), which
 * independently re-validates ownership/archived/deleted state and derives
 * the acting user from `auth.uid()` -- this wrapper adds no logic of its
 * own beyond the call and a server-safe error on failure, matching
 * startOrResumeSession()/finishSession() in lib/sessions/dal.ts.
 *
 * Deliberately does not touch `sessions` in any way: an active session's
 * own `deck_id` is fixed at creation and is never rewritten by this or any
 * other function (DATABASE_SCHEMA.md 4.5) -- only a future
 * start_or_resume_session() call that finds no active session will read
 * the newly selected deck.
 */
export async function selectDeck(deckId: string): Promise<{ id: string; name: string }> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("select_deck", { p_deck_id: deckId });

  if (error) {
    throw new Error("Failed to select deck", { cause: error });
  }

  return data as { id: string; name: string };
}
