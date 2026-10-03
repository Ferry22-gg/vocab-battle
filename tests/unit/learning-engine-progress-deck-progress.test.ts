import { describe, expect, it } from "vitest";

import {
  cardProgressContribution,
  classifyDeckProgressState,
  computeDeckProgress,
  type DeckProgressCardInput,
} from "@/lib/learning-engine/progress/deck-progress";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 28.2
 * ("Deck Progress"), Phase 9. Covers both the normative contribution table
 * and the Phase 9 decision that incomplete legacy state (LEARNING + null
 * learning_stage) must never silently become a numeric percentage.
 */

function card(cardStatus: DeckProgressCardInput["cardStatus"], learningStage: DeckProgressCardInput["learningStage"] = null): DeckProgressCardInput {
  return { cardStatus, learningStage };
}

describe("classifyDeckProgressState / cardProgressContribution (section 28.2)", () => {
  it("1. NEW -> 0.00", () => {
    const result = classifyDeckProgressState(card("NEW"));
    expect(result).toEqual({ kind: "classified", bucket: "NEW" });
    expect(cardProgressContribution("NEW")).toBe(0.0);
  });

  it("2. LEARNING + FRESH -> 0.10", () => {
    const result = classifyDeckProgressState(card("LEARNING", "FRESH"));
    expect(result).toEqual({ kind: "classified", bucket: "FRESH" });
    expect(cardProgressContribution("FRESH")).toBe(0.1);
  });

  it("3. LEARNING + LEARNING_1 -> 0.30", () => {
    const result = classifyDeckProgressState(card("LEARNING", "LEARNING_1"));
    expect(result).toEqual({ kind: "classified", bucket: "LEARNING_1" });
    expect(cardProgressContribution("LEARNING_1")).toBe(0.3);
  });

  it("4. LEARNING + LEARNING_2 -> 0.50", () => {
    const result = classifyDeckProgressState(card("LEARNING", "LEARNING_2"));
    expect(result).toEqual({ kind: "classified", bucket: "LEARNING_2" });
    expect(cardProgressContribution("LEARNING_2")).toBe(0.5);
  });

  it("5. ACQUIRED -> 0.70", () => {
    const result = classifyDeckProgressState(card("ACQUIRED"));
    expect(result).toEqual({ kind: "classified", bucket: "ACQUIRED" });
    expect(cardProgressContribution("ACQUIRED")).toBe(0.7);
  });

  it("6. LEARNED -> 1.00", () => {
    const result = classifyDeckProgressState(card("LEARNED"));
    expect(result).toEqual({ kind: "classified", bucket: "LEARNED" });
    expect(cardProgressContribution("LEARNED")).toBe(1.0);
  });

  it("7. FORGOTTEN -> 0.50", () => {
    const result = classifyDeckProgressState(card("FORGOTTEN"));
    expect(result).toEqual({ kind: "classified", bucket: "FORGOTTEN" });
    expect(cardProgressContribution("FORGOTTEN")).toBe(0.5);
  });

  it("does not confuse scheduler Fresh-capacity membership with learner progress: a backend-NEW card classifies as NEW regardless of pool status (pool_status is not even part of the input)", () => {
    // classifyDeckProgressState's input type has no poolStatus field at
    // all -- this test documents that omission is deliberate, not an
    // oversight (spec section 3.1 / Phase 9 audit instruction).
    const result = classifyDeckProgressState(card("NEW"));
    expect(result).toEqual({ kind: "classified", bucket: "NEW" });
  });
});

describe("computeDeckProgress (section 28.2 formula)", () => {
  it("8. mixed complete v1 deck -> exact weighted result", () => {
    const cards: DeckProgressCardInput[] = [
      card("NEW"),
      card("LEARNING", "FRESH"),
      card("LEARNING", "LEARNING_1"),
      card("LEARNING", "LEARNING_2"),
      card("ACQUIRED"),
      card("LEARNED"),
      card("FORGOTTEN"),
    ];
    // (0.00 + 0.10 + 0.30 + 0.50 + 0.70 + 1.00 + 0.50) / 7
    const expected = (0.0 + 0.1 + 0.3 + 0.5 + 0.7 + 1.0 + 0.5) / 7;
    const result = computeDeckProgress(cards);
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.progress).toBeCloseTo(expected, 10);
  });

  it("9. all NEW -> 0%", () => {
    const cards: DeckProgressCardInput[] = [card("NEW"), card("NEW"), card("NEW")];
    expect(computeDeckProgress(cards)).toEqual({ kind: "ok", progress: 0 });
  });

  it("10. all LEARNED -> 100%", () => {
    const cards: DeckProgressCardInput[] = [card("LEARNED"), card("LEARNED"), card("LEARNED")];
    expect(computeDeckProgress(cards)).toEqual({ kind: "ok", progress: 1 });
  });

  it("11. a lapse (LEARNED -> FORGOTTEN) reduces progress", () => {
    const beforeLapse: DeckProgressCardInput[] = [card("LEARNED"), card("LEARNED")];
    const afterLapse: DeckProgressCardInput[] = [card("FORGOTTEN"), card("LEARNED")];

    const before = computeDeckProgress(beforeLapse);
    const after = computeDeckProgress(afterLapse);

    expect(before).toEqual({ kind: "ok", progress: 1 });
    expect(after.kind).toBe("ok");
    expect(after.kind === "ok" && after.progress).toBeLessThan(before.kind === "ok" ? before.progress : Infinity);
  });

  it("12. ACQUIRED is not Mastered-equivalent in the progress table (0.70, not 1.00)", () => {
    expect(cardProgressContribution("ACQUIRED")).not.toBe(1.0);
    expect(cardProgressContribution("ACQUIRED")).toBe(0.7);
  });

  it("13. empty deck behavior is explicit, not a division-by-zero NaN", () => {
    const result = computeDeckProgress([]);
    expect(result).toEqual({ kind: "empty" });
  });

  it("14. LEARNING + learning_stage = NULL does NOT classify as FRESH", () => {
    const result = classifyDeckProgressState(card("LEARNING", null));
    expect(result).not.toEqual({ kind: "classified", bucket: "FRESH" });
    expect(result).toEqual({ kind: "incomplete" });
  });

  it("15. LEARNING + NULL does NOT produce a 0.10 contribution via any path", () => {
    const result = classifyDeckProgressState(card("LEARNING", null));
    expect(result.kind).toBe("incomplete");
    // No bucket is present to even feed into cardProgressContribution.
    expect("bucket" in result).toBe(false);
  });

  it("16. an aggregate containing one unclassifiable LEARNING row does not silently produce an authoritative numeric percentage", () => {
    const cards: DeckProgressCardInput[] = [card("NEW"), card("LEARNED"), card("LEARNING", null)];
    const result = computeDeckProgress(cards);
    expect(result).toEqual({ kind: "incomplete" });
  });

  it("17. no approximation/fallback path exists: incomplete input never degrades to a classified result", () => {
    const allLegacyLikeRows: DeckProgressCardInput[] = [
      card("NEW"),
      card("LEARNING", null),
      card("LEARNED"),
      card("FORGOTTEN"),
    ];
    const result = computeDeckProgress(allLegacyLikeRows);
    expect(result.kind).toBe("incomplete");
    expect(result).not.toHaveProperty("progress");
  });
});
