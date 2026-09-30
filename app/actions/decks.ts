"use server";

/**
 * Public Server Action surface for P3 Decks (app/decks/select-deck-button.tsx).
 * Deliberately thin, matching app/actions/sessions.ts/answers.ts's own
 * pattern: resolve the authenticated identity, then delegate entirely to
 * the trusted DAL (lib/decks/dal.ts's selectDeck(), which itself calls
 * only the authoritative select_deck() RPC -- DATABASE_SCHEMA.md 10.8).
 */

import { revalidatePath } from "next/cache";
import { requireOnboardedTester } from "@/lib/auth/dal";
import { selectDeck } from "@/lib/decks/dal";

export type SelectDeckState = { error: string } | undefined;

const GENERIC_SELECT_DECK_ERROR = "Something went wrong selecting that deck. Please try again.";

/**
 * Switches the caller's selected deck. Bound with a specific `deckId` via
 * `selectDeckAction.bind(null, deckId)` before being passed to
 * `useActionState` (see select-deck-button.tsx) -- identity comes only
 * from the authenticated session, never from `deckId` itself, and
 * select_deck() independently re-validates that the target deck actually
 * belongs to the caller before writing anything.
 *
 * Deliberately does not redirect: revalidatePath("/decks") re-renders the
 * Decks screen in the same response (server-actions.md "a single response
 * carries data and UI"), and revalidatePath("/") queues Home for a fresh
 * read on its next visit. An active session, if any, is left completely
 * untouched -- see the comment on selectDeck() in lib/decks/dal.ts.
 */
export async function selectDeckAction(
  deckId: string,
  _prevState: SelectDeckState,
  _formData: FormData,
): Promise<SelectDeckState> {
  await requireOnboardedTester();

  try {
    await selectDeck(deckId);
  } catch {
    return { error: GENERIC_SELECT_DECK_ERROR };
  }

  revalidatePath("/decks");
  revalidatePath("/");
  return undefined;
}
