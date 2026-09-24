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
