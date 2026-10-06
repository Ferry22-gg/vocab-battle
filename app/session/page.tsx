import { requireOnboardedTester } from "@/lib/auth/dal";
import { startOrResumeSession } from "@/lib/sessions/dal";
import { getNextSessionCardForEngine } from "@/lib/learning/engine-router";
import { getDeckById } from "@/lib/decks/dal";
import { getLanguageDisplayName } from "@/lib/session-ui/language-labels";
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
  const tester = await requireOnboardedTester();

  const session = await startOrResumeSession();
  const initialCard = await getNextSessionCardForEngine(tester.id, session.id);

  // Presentation-only (flashcard eyebrow labels, e.g. "Swahili" / "English")
  // -- never Learning Engine state. Falls back to generic labels rather
  // than throwing if the deck row is ever unreachable (should not happen
  // for an active session's own deck, but this screen must never fail to
  // render over a label).
  const deck = await getDeckById(session.deck_id);
  const frontLanguageLabel = deck ? getLanguageDisplayName(deck.front_language) : "Front";
  const backLanguageLabel = deck ? getLanguageDisplayName(deck.back_language) : "Back";

  return (
    <SessionScreen
      sessionId={session.id}
      initialCard={initialCard}
      frontLanguageLabel={frontLanguageLabel}
      backLanguageLabel={backLanguageLabel}
    />
  );
}
