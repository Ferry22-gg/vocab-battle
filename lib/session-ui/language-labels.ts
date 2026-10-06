/**
 * Deck `front_language`/`back_language` -> a human-readable display label
 * for the Session flashcard's eyebrow text (app/session/flash-card.tsx).
 * These two columns are plain, unconstrained `text` (no DB enum -- see
 * supabase/migrations/20260921151534_identity_and_content_tables.sql),
 * so this is a presentation-only concern, not Learning Engine policy: it
 * never affects which side is shown first, reveal/grading behavior, or
 * card content.
 *
 * Centralized here (rather than inlined in the JSX) so a future starter
 * deck in a new language needs exactly one new map entry, not a second
 * switch statement somewhere else.
 */
const LANGUAGE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  ja: "Japanese",
  sw: "Swahili",
};

/**
 * Never throws and never displays the raw code for a KNOWN language. For
 * an unrecognized future code, falls back to the uppercased code itself
 * (e.g. "fr") rather than crashing or guessing a name -- a safe, neutral
 * placeholder until that language gets its own map entry.
 */
export function getLanguageDisplayName(code: string): string {
  return LANGUAGE_DISPLAY_NAMES[code] ?? code.toUpperCase();
}
