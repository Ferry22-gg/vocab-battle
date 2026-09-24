/**
 * Data Access Layer for auth/authorization. This is the authoritative
 * layer -- proxy.ts (lib/auth/optimistic-guard.ts) only performs a cheap,
 * cookie-based authenticated/unauthenticated check and must never be
 * trusted as the real gate. Every protected Server Component, Server
 * Action, and Route Handler must call into one of the `require*` functions
 * below instead of re-deriving auth state itself.
 *
 * Never derives the acting user from anything client-supplied -- the user
 * id always comes from the verified JWT (`getClaims()`), never a request
 * parameter, matching the same rule DATABASE_SCHEMA.md section 10.6
 * requires of every trusted Postgres function.
 */

import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const PROFILE_COLUMNS =
  "id, public_user_id, role, account_status, nickname, onboarding_completed, selected_deck_id";

type ProfileRow = {
  id: string;
  public_user_id: string;
  role: "tester" | "admin";
  account_status: "active" | "disabled";
  nickname: string | null;
  onboarding_completed: boolean;
  selected_deck_id: string | null;
};

export type TesterProfile = {
  id: string;
  publicUserId: string;
  role: "tester";
  accountStatus: "active" | "disabled";
  nickname: string | null;
  onboardingCompleted: boolean;
  selectedDeckId: string | null;
};

export type AdminProfile = {
  id: string;
  publicUserId: string;
  role: "admin";
  accountStatus: "active" | "disabled";
};

export type AuthProfile = TesterProfile | AdminProfile;

/**
 * Three distinct states, not two -- collapsing "no session" and "session
 * valid but no profile row" into a single `authenticated: false` caused a
 * redirect loop: Proxy's optimistic check only verifies the JWT (never
 * queries profiles, see lib/auth/optimistic-guard.ts), so it treats a
 * profile-less session as authenticated and bounces /login back to "/",
 * while a DAL that also called that case "unauthenticated" sent it to
 * /login -- each side correct on its own, contradictory together.
 * `profileMissing` breaks that by giving the no-profile case a redirect
 * target (/profile-missing) that Proxy's optimistic check won't bounce an
 * authenticated user away from.
 */
type AuthContext =
  | { status: "unauthenticated" }
  | { status: "profileMissing" }
  | { status: "authenticated"; profile: AuthProfile };

function toAuthProfile(row: ProfileRow): AuthProfile {
  if (row.role === "admin") {
    return {
      id: row.id,
      publicUserId: row.public_user_id,
      role: "admin",
      accountStatus: row.account_status,
    };
  }

  return {
    id: row.id,
    publicUserId: row.public_user_id,
    role: "tester",
    accountStatus: row.account_status,
    nickname: row.nickname,
    onboardingCompleted: row.onboarding_completed,
    selectedDeckId: row.selected_deck_id,
  };
}

/**
 * Resolves the current request's auth state once per render pass (React
 * `cache`). Verifies the JWT locally via `getClaims()` rather than trusting
 * the cookie's contents, then loads only the profile columns auth/
 * onboarding decisions need -- never the full row.
 *
 * Uses `maybeSingle()`, not `single()`, so a genuine zero-row result
 * (`data: null, error: null`) is distinguishable from a real query failure
 * (`error` set -- RLS misconfiguration, connection issue, etc.). Zero rows
 * with a verified JWT is `profileMissing`; a real query error is neither
 * `unauthenticated` nor `profileMissing` -- it's thrown, so it surfaces as
 * an application error instead of silently being treated as one of those
 * two known states.
 */
export const getAuthContext = cache(async (): Promise<AuthContext> => {
  const supabase = await createClient();

  const { data: claimsData } = await supabase.auth.getClaims();
  const userId = claimsData?.claims.sub;

  if (!userId) {
    return { status: "unauthenticated" };
  }

  const { data: row, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", userId)
    .maybeSingle<ProfileRow>();

  if (error) {
    throw new Error("Failed to load auth profile", { cause: error });
  }

  if (!row) {
    return { status: "profileMissing" };
  }

  return { status: "authenticated", profile: toAuthProfile(row) };
});

export async function requireAuthenticated(): Promise<AuthProfile> {
  const ctx = await getAuthContext();

  if (ctx.status === "unauthenticated") {
    redirect("/login");
  }

  if (ctx.status === "profileMissing") {
    redirect("/profile-missing");
  }

  return ctx.profile;
}

/**
 * A disabled account can still hold a valid Supabase session (Supabase
 * Auth has no concept of account_status), so this check must happen here,
 * server-side, on every protected request -- never assumed from the JWT
 * alone.
 */
export async function requireActiveAccount(): Promise<AuthProfile> {
  const profile = await requireAuthenticated();

  if (profile.accountStatus !== "active") {
    redirect("/account-disabled");
  }

  return profile;
}

export async function requireActiveTester(): Promise<TesterProfile> {
  const profile = await requireActiveAccount();

  if (profile.role !== "tester") {
    redirect("/admin");
  }

  return profile;
}

export async function requireAdmin(): Promise<AdminProfile> {
  const profile = await requireActiveAccount();

  if (profile.role !== "admin") {
    redirect("/");
  }

  return profile;
}

/**
 * Enforces nickname -> starter deck -> onboarding complete, in that order.
 * `onboarding_completed` is read directly as authoritative persisted state
 * (set atomically with `selected_deck_id` by duplicate_starter_deck(), see
 * supabase/migrations/20260923190000_duplicate_and_session_functions.sql)
 * rather than re-derived here.
 *
 * The `selectedDeckId` check below is a separate defensive guard, not a
 * redefinition of `onboardingCompleted`: the two are set atomically by
 * duplicate_starter_deck() and can't diverge through that path, but
 * profiles.selected_deck_id has ON DELETE SET NULL against decks.id
 * (DATABASE_SCHEMA.md 4.1), so a deck hard-deleted outside the normal
 * soft-delete path could null it out while onboarding_completed stays
 * true. Catching that here stops a corrupted profile from reaching Home
 * without a selected deck.
 */
export async function requireOnboardedTester(): Promise<TesterProfile> {
  const tester = await requireActiveTester();

  if (!tester.nickname) {
    redirect("/onboarding/nickname");
  }

  if (!tester.onboardingCompleted || !tester.selectedDeckId) {
    redirect("/onboarding/deck");
  }

  return tester;
}
