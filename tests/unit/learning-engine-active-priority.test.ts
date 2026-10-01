import { describe, expect, it } from "vitest";

import {
  advanceActiveDrawCounters,
  agingMultiplier,
  applyCorrectCooldown,
  computeActiveWeight,
  isEligibleForNormalSelection,
  stageBaseWeight,
  type ActiveDrawCounterCard,
} from "@/lib/learning-engine/active-priority";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 11.1,
 * 19, 19.1, 22.3 (Phase 3: Active card priority).
 */

describe("Correct cooldown (section 11.1)", () => {
  it("applyCorrectCooldown sets the target to N+6 -- the first ELIGIBLE position, not the last blocked one", () => {
    // Correct at N=10: intervening positions 11-15 (5 of them) must be
    // blocked, so the earliest legal reappearance is 16, not 15.
    expect(applyCorrectCooldown(10)).toBe(16);
  });

  it("boundary check: N+1 through N+5 all blocked, N+6 is the earliest eligible position (off-by-one regression test)", () => {
    const N = 10;
    const cooldownUntil = applyCorrectCooldown(N); // 16
    const card = { correctCooldownUntilPosition: cooldownUntil };

    expect(isEligibleForNormalSelection(card, N + 1)).toBe(false); // 11
    expect(isEligibleForNormalSelection(card, N + 2)).toBe(false); // 12
    expect(isEligibleForNormalSelection(card, N + 3)).toBe(false); // 13
    expect(isEligibleForNormalSelection(card, N + 4)).toBe(false); // 14
    expect(isEligibleForNormalSelection(card, N + 5)).toBe(false); // 15 -- the previously-broken case: 5 full intervening cards (11-15) must still be blocked here
    expect(isEligibleForNormalSelection(card, N + 6)).toBe(true); // 16 -- earliest legal reappearance
    expect(isEligibleForNormalSelection(card, N + 7)).toBe(true); // 17 -- stays eligible afterward
  });

  it("a card with no cooldown in force is always eligible", () => {
    expect(isEligibleForNormalSelection({ correctCooldownUntilPosition: null }, 0)).toBe(true);
  });
});

describe("stageBaseWeight (section 19)", () => {
  it("matches the spec's exact per-stage weights", () => {
    expect(stageBaseWeight("FRESH")).toBe(1.0);
    expect(stageBaseWeight("LEARNING_1")).toBe(1.2);
    expect(stageBaseWeight("LEARNING_2")).toBe(1.1);
  });
});

describe("agingMultiplier (section 19.1)", () => {
  it("matches every documented bucket boundary", () => {
    expect(agingMultiplier(0)).toBe(1.0);
    expect(agingMultiplier(4)).toBe(1.0);
    expect(agingMultiplier(5)).toBe(1.1);
    expect(agingMultiplier(9)).toBe(1.1);
    expect(agingMultiplier(10)).toBe(1.2);
    expect(agingMultiplier(14)).toBe(1.2);
    expect(agingMultiplier(15)).toBe(1.3);
    expect(agingMultiplier(19)).toBe(1.3);
    expect(agingMultiplier(20)).toBe(1.4);
  });

  it("20+ draws all share the final 1.40 bucket (no upper bound)", () => {
    expect(agingMultiplier(20)).toBe(1.4);
    expect(agingMultiplier(100)).toBe(1.4);
    expect(agingMultiplier(10_000)).toBe(1.4);
  });
});

describe("computeActiveWeight (section 19)", () => {
  it("multiplies stage base weight by the aging multiplier", () => {
    expect(computeActiveWeight({ learningStage: "FRESH", activeDrawsSinceEligible: 0 })).toBeCloseTo(1.0 * 1.0);
    expect(computeActiveWeight({ learningStage: "LEARNING_1", activeDrawsSinceEligible: 5 })).toBeCloseTo(1.2 * 1.1);
    expect(computeActiveWeight({ learningStage: "LEARNING_2", activeDrawsSinceEligible: 20 })).toBeCloseTo(1.1 * 1.4);
  });
});

describe("advanceActiveDrawCounters (sections 19.1, 22.3)", () => {
  it("resets the selected card to 0 and increments every other eligible card by 1", () => {
    const cards: ActiveDrawCounterCard[] = [
      { cardId: "a", activeDrawsSinceEligible: 3, eligible: true },
      { cardId: "b", activeDrawsSinceEligible: 7, eligible: true },
      { cardId: "c", activeDrawsSinceEligible: 0, eligible: true },
    ];

    const result = advanceActiveDrawCounters(cards, "b");

    expect(result.get("a")).toBe(4);
    expect(result.get("b")).toBe(0);
    expect(result.get("c")).toBe(1);
  });

  it("leaves ineligible (on-cooldown) cards' counters untouched", () => {
    const cards: ActiveDrawCounterCard[] = [
      { cardId: "a", activeDrawsSinceEligible: 2, eligible: true },
      { cardId: "b", activeDrawsSinceEligible: 9, eligible: false }, // on cooldown
    ];

    const result = advanceActiveDrawCounters(cards, "a");

    expect(result.get("a")).toBe(0); // selected
    expect(result.get("b")).toBe(9); // frozen, not incremented
  });

  it("a card's counter correctly returns to 0 and starts counting fresh across a full select -> cooldown -> eligible-again cycle", () => {
    // Draw 1: "x" is selected (its own first Correct does not itself
    // necessarily trigger cooldown -- this exercises the counter
    // bookkeeping alone, independent of whether the answer was stage-
    // advancing).
    let counters = advanceActiveDrawCounters(
      [
        { cardId: "x", activeDrawsSinceEligible: 6, eligible: true },
        { cardId: "y", activeDrawsSinceEligible: 1, eligible: true },
      ],
      "x",
    );
    expect(counters.get("x")).toBe(0);

    // Draws 2-4: "x" is now on cooldown (ineligible); only "y" is drawn
    // from and advances. "x" stays frozen at 0 throughout.
    for (let i = 0; i < 3; i += 1) {
      counters = advanceActiveDrawCounters(
        [
          { cardId: "x", activeDrawsSinceEligible: counters.get("x")!, eligible: false },
          { cardId: "y", activeDrawsSinceEligible: counters.get("y") ?? 1, eligible: true },
        ],
        "y",
      );
    }
    expect(counters.get("x")).toBe(0);

    // Draw 5: "x"'s cooldown has cleared (now eligible again) but it is
    // not the one selected this draw -- its counter starts counting from
    // exactly 0 + 1, not from any stale pre-cooldown value.
    counters = advanceActiveDrawCounters(
      [
        { cardId: "x", activeDrawsSinceEligible: counters.get("x")!, eligible: true },
        { cardId: "y", activeDrawsSinceEligible: counters.get("y")!, eligible: true },
      ],
      "y",
    );
    expect(counters.get("x")).toBe(1);
  });
});
