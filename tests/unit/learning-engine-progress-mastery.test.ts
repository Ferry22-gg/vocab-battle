import { describe, expect, it } from "vitest";

import { countMasteredCards, isMasteredCardStatus } from "@/lib/learning-engine/progress/mastery";
import type { CardStatus } from "@/lib/learning-engine/state";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections
 * 15.2/28.1/34.1 ("Mastered" current-count semantics), Phase 9.
 */

describe("isMasteredCardStatus / countMasteredCards (sections 15.2/28.1/34.1)", () => {
  it("17. only LEARNED counts as current Mastered", () => {
    expect(isMasteredCardStatus("LEARNED")).toBe(true);
  });

  it("18. ACQUIRED does not count", () => {
    expect(isMasteredCardStatus("ACQUIRED")).toBe(false);
  });

  it("19. FORGOTTEN does not count", () => {
    expect(isMasteredCardStatus("FORGOTTEN")).toBe(false);
  });

  it("NEW and LEARNING also do not count", () => {
    expect(isMasteredCardStatus("NEW")).toBe(false);
    expect(isMasteredCardStatus("LEARNING")).toBe(false);
  });

  it("counts only LEARNED cards in a mixed set", () => {
    const statuses: CardStatus[] = ["NEW", "LEARNING", "ACQUIRED", "LEARNED", "LEARNED", "FORGOTTEN"];
    expect(countMasteredCards(statuses)).toBe(2);
  });

  it("20. current count can decrease after a lapse (LEARNED -> FORGOTTEN)", () => {
    const before: CardStatus[] = ["LEARNED", "LEARNED"];
    const afterLapse: CardStatus[] = ["FORGOTTEN", "LEARNED"];
    expect(countMasteredCards(before)).toBe(2);
    expect(countMasteredCards(afterLapse)).toBe(1);
  });

  it("21. a historical full-mastery flag plays no role here -- this module has no such input at all", () => {
    // countMasteredCards/isMasteredCardStatus take only CardStatus values;
    // there is no has_achieved_full_mastery/has_ever_been_mastered
    // parameter to even accidentally consult.
    const statuses: CardStatus[] = ["LEARNED"];
    expect(countMasteredCards(statuses)).toBe(1);
  });

  it("empty input counts as zero", () => {
    expect(countMasteredCards([])).toBe(0);
  });
});
