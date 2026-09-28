import { requireOnboardedTester } from "@/lib/auth/dal";
import { startOrResumeSession, getNextSessionCard } from "@/lib/sessions/dal";
import { SessionScreen } from "./session-screen";

/**
 * Phase F1 vertical slice: the Session route. `requireOnboardedTester()`
 * is the single gate (unauthenticated -> /login, profile-missing ->
 * /profile-missing, disabled -> /account-disabled, admin -> /admin, not
 * onboarded -> /onboarding/*).
 *
 * Zero-Cognitive-Load (MVP_UI_SPEC.md 2.2/8.3): visiting this route always
 * calls startOrResumeSession() with no deck argument (resolves to the
 * tester's own profiles.selected_deck_id server-side) -- it resumes the
 * caller's existing active session automatically if one exists, or starts
 * a new one otherwise. The UI never asks "New or Resume?".
 *
 * Any failure here (RPC error, e.g. a genuine DB/network failure) is
 * deliberately left to throw and propagate to app/session/error.tsx
 * (Next.js route error boundary) rather than being caught inline -- that
 * boundary already renders a generic, safe message and an exit path,
 * matching the "do not leak raw DB/service-role errors" rule without
 * duplicating that handling here.
 */
export default async function SessionPage() {
  await requireOnboardedTester();

  const session = await startOrResumeSession();
  const initialCard = await getNextSessionCard(session.id);

  return <SessionScreen sessionId={session.id} initialCard={initialCard} />;
}
