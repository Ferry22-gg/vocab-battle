"use server";

import { redirect } from "next/navigation";
import { requireActiveTester } from "@/lib/auth/dal";
import { isValidStarterDeckId } from "@/lib/decks/dal";
import { createClient } from "@/lib/supabase/server";
import { NICKNAME_MAX_LENGTH } from "@/lib/onboarding/constants";

export type SetNicknameState = { error: string } | undefined;

const DUPLICATE_NICKNAME_ERROR = "That nickname is taken. Please choose another.";
const EMPTY_NICKNAME_ERROR = "Nickname can't be empty.";
const NICKNAME_TOO_LONG_ERROR = `Nickname must be ${NICKNAME_MAX_LENGTH} characters or fewer.`;
const GENERIC_NICKNAME_ERROR = "Something went wrong. Please try again.";

// Postgres unique_violation SQLSTATE, raised by profiles_nickname_lower_idx
// (case-insensitive uniqueness) on a duplicate.
const UNIQUE_VIOLATION = "23505";

export async function setNickname(
  _prevState: SetNicknameState,
  formData: FormData
): Promise<SetNicknameState> {
  // Identity comes only from the authenticated session -- the acting
  // profile id is never read from formData, and requireActiveTester()
  // already excludes admin/disabled/profile-missing/unauthenticated
  // callers before any write is attempted.
  const tester = await requireActiveTester();

  const rawNickname = formData.get("nickname");

  if (typeof rawNickname !== "string") {
    return { error: GENERIC_NICKNAME_ERROR };
  }

  const nickname = rawNickname.trim();

  if (nickname.length === 0) {
    return { error: EMPTY_NICKNAME_ERROR };
  }

  if (nickname.length > NICKNAME_MAX_LENGTH) {
    return { error: NICKNAME_TOO_LONG_ERROR };
  }

  const supabase = await createClient();

  // Column-level grant restricts `authenticated` to updating only
  // `nickname` (grants_and_rls.sql), and RLS's profiles_update_own scopes
  // this to the caller's own row -- `.eq("id", tester.id)` is redundant
  // with that policy, not a substitute for it.
  const { error } = await supabase
    .from("profiles")
    .update({ nickname })
    .eq("id", tester.id);

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return { error: DUPLICATE_NICKNAME_ERROR };
    }
    return { error: GENERIC_NICKNAME_ERROR };
  }

  redirect("/onboarding/deck");
}

export type SelectStarterDeckState = { error: string } | undefined;

const INVALID_DECK_ERROR =
  "That isn't a valid starter deck. Please choose one of the options below.";
const GENERIC_DECK_ERROR =
  "Something went wrong selecting your starter deck. Please try again.";

export async function selectStarterDeck(
  _prevState: SelectStarterDeckState,
  formData: FormData
): Promise<SelectStarterDeckState> {
  const tester = await requireActiveTester();

  // Defense in depth against a direct POST that skips the deck page's own
  // nickname check: onboarding order (nickname, then deck) is enforced
  // here too, not only at the page level.
  if (!tester.nickname) {
    redirect("/onboarding/nickname");
  }

  // Same defense in depth for "already onboarded": without this, a fully
  // onboarded tester could POST directly to this action with the *other*
  // official deck's id and get a second duplicated deck with
  // selected_deck_id silently repointed to it -- this action is the
  // onboarding entry point only, not a general deck-switcher (that's
  // select_deck()'s job later).
  if (tester.onboardingCompleted && tester.selectedDeckId) {
    redirect("/");
  }

  const rawDeckId = formData.get("deckId");

  if (typeof rawDeckId !== "string" || rawDeckId.length === 0) {
    return { error: INVALID_DECK_ERROR };
  }

  // A deck id merely existing in the table is not enough -- confirm it's
  // actually one of the official starter templates before ever calling
  // the RPC. duplicate_starter_deck() re-validates this itself, but that
  // check exists to protect the database, not to give a clean UI error.
  if (!(await isValidStarterDeckId(rawDeckId))) {
    return { error: INVALID_DECK_ERROR };
  }

  const supabase = await createClient();

  // Never writes selected_deck_id/onboarding_completed directly --
  // duplicate_starter_deck() sets both atomically, re-deriving the acting
  // user from auth.uid() server-side rather than trusting a client id.
  const { error } = await supabase.rpc("duplicate_starter_deck", {
    p_source_deck_id: rawDeckId,
  });

  if (error) {
    return { error: GENERIC_DECK_ERROR };
  }

  redirect("/");
}
