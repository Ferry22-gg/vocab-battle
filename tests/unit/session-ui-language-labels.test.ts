import { describe, expect, it } from "vitest";
import { getLanguageDisplayName } from "@/lib/session-ui/language-labels";

/**
 * Unit tests for the flashcard eyebrow-label mapping
 * (app/session/flash-card.tsx's previously-hardcoded "English"/"Japanese"
 * labels, now derived from a deck's own front_language/back_language --
 * see lib/session-ui/language-labels.ts's module header). Presentation
 * only; never Learning Engine policy.
 */
describe("getLanguageDisplayName", () => {
  it("A. en -> English (existing TOEFL decks' front language)", () => {
    expect(getLanguageDisplayName("en")).toBe("English");
  });

  it("A. ja -> Japanese (existing TOEFL decks' back language)", () => {
    expect(getLanguageDisplayName("ja")).toBe("Japanese");
  });

  it("B. sw -> Swahili (the new Swahili Basics deck's front language)", () => {
    expect(getLanguageDisplayName("sw")).toBe("Swahili");
  });

  it("D. an unknown/future language code falls back to its uppercased code, never throws", () => {
    expect(() => getLanguageDisplayName("fr")).not.toThrow();
    expect(getLanguageDisplayName("fr")).toBe("FR");
  });

  it("D. never returns a raw lowercase code for a KNOWN language", () => {
    for (const code of ["en", "ja", "sw"]) {
      expect(getLanguageDisplayName(code)).not.toBe(code);
    }
  });
});
