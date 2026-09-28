"use server";

/**
 * Public Server Action surface for the Session UI's card-fetch calls
 * (app/session/session-screen.tsx). Deliberately thin, matching
 * app/actions/answers.ts's own pattern: resolve the authenticated
 * identity, then delegate entirely to the trusted DAL
 * (lib/sessions/dal.ts's getNextSessionCard(), which itself calls only
 * the authoritative get_next_session_card() RPC -- DATABASE_SCHEMA.md
 * 4.4/4.6/4.7/9.1/10.3/11). No queue/eligibility logic lives here or in
 * any client component; this file only adds the auth gate a Client
 * Component call requires.
 */

import { requireOnboardedTester } from "@/lib/auth/dal";
import { getNextSessionCard } from "@/lib/sessions/dal";
import type { NextSessionCard } from "@/lib/sessions/dal";

export type { NextSessionCard };

/**
 * Resolves the caller via requireOnboardedTester() (redirects on
 * unauthenticated/profile-missing/disabled/admin/not-onboarded, same as
 * every other protected entry point) before reading the next card.
 * `getNextSessionCard()` itself never accepts or needs a userId -- it
 * derives the caller from the authenticated request's own Supabase
 * session (RLS), so a sessionId belonging to another tester simply comes
 * back as `not_found`, never another user's data.
 */
export async function getNextSessionCardAction(sessionId: string): Promise<NextSessionCard> {
  await requireOnboardedTester();
  return getNextSessionCard(sessionId);
}
