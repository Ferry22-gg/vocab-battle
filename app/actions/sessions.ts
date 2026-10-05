"use server";

/**
 * Public Server Action surface for the Session UI's card-fetch calls
 * (app/session/session-screen.tsx). Deliberately thin, matching
 * app/actions/answers.ts's own pattern: resolve the authenticated
 * identity, then delegate entirely to the trusted routing layer
 * (lib/learning/engine-router.ts's getNextSessionCardForEngine(), which
 * routes to legacy's getNextSessionCard() -- DATABASE_SCHEMA.md
 * 4.4/4.6/4.7/9.1/10.3/11 -- or RC-B's claimNextLearningEngineCard() by
 * this session's own pinned engine_version, Runtime Cutover RC-D). No
 * queue/eligibility logic lives here or in any client component; this
 * file only adds the auth gate a Client Component call requires.
 */

import { requireOnboardedTester } from "@/lib/auth/dal";
import { getNextSessionCardForEngine } from "@/lib/learning/engine-router";
import type { NextSessionCard } from "@/lib/sessions/dal";

export type { NextSessionCard };

/**
 * Resolves the caller via requireOnboardedTester() (redirects on
 * unauthenticated/profile-missing/disabled/admin/not-onboarded, same as
 * every other protected entry point) before reading the next card.
 * `getNextSessionCardForEngine()` derives which engine owns this
 * sessionId from the session's own trusted engine_version -- never from
 * anything client-supplied -- so a sessionId belonging to another tester
 * simply comes back as `not_found`, never another user's data.
 */
export async function getNextSessionCardAction(sessionId: string): Promise<NextSessionCard> {
  const tester = await requireOnboardedTester();
  return getNextSessionCardForEngine(tester.id, sessionId);
}
