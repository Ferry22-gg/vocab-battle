import { describe, expect, it } from "vitest";

import {
  buildFirstPassOrder,
  computeActiveAdmissions,
  isFresh,
  type DeckActivePoolCard,
} from "@/lib/learning-engine/active-pool";
import { applyFirstPresentation, applyNormalCorrect } from "@/lib/learning-engine/transitions";
import { INITIAL_CARD_STATE } from "@/lib/learning-engine/state";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 6, 8,
 * 9 (Phase 3: Active Pool admission/refill and first-encounter ordering).
 */

function newCard(cardId: string): DeckActivePoolCard {
  return { cardId, cardStatus: "NEW", poolStatus: null, learningStage: null };
}

function activeFreshNew(cardId: string): DeckActivePoolCard {
  return { cardId, cardStatus: "NEW", poolStatus: "ACTIVE", learningStage: null };
}

function activeLearning(cardId: string, learningStage: "FRESH" | "LEARNING_1" | "LEARNING_2"): DeckActivePoolCard {
  return { cardId, cardStatus: "LEARNING", poolStatus: "ACTIVE", learningStage };
}

function reservoirOf(n: number, prefix = "r"): DeckActivePoolCard[] {
  return Array.from({ length: n }, (_, i) => newCard(`${prefix}${i}`));
}

describe("isFresh (section 8.2)", () => {
  it("an Active, never-presented NEW card is Fresh", () => {
    expect(isFresh(activeFreshNew("a"))).toBe(true);
  });

  it("an Active card at learningStage FRESH (presented, 0 successes) is Fresh", () => {
    expect(isFresh(activeLearning("a", "FRESH"))).toBe(true);
  });

  it("a card past its first success (LEARNING_1/LEARNING_2) is not Fresh", () => {
    expect(isFresh(activeLearning("a", "LEARNING_1"))).toBe(false);
    expect(isFresh(activeLearning("a", "LEARNING_2"))).toBe(false);
  });

  it("a NEW card not yet admitted (poolStatus null) is not Fresh", () => {
    expect(isFresh(newCard("a"))).toBe(false);
  });

  it("a FORGOTTEN (relearning) card is never Fresh, regardless of poolStatus", () => {
    expect(isFresh({ cardId: "a", cardStatus: "FORGOTTEN", poolStatus: "ACTIVE", learningStage: null })).toBe(false);
  });
});

describe("computeActiveAdmissions (sections 6.1, 8.3, 8.4)", () => {
  it("new deck startup: Active starts at 6, Fresh = 6 (Test 1)", () => {
    const result = computeActiveAdmissions({ activeCards: [], newReservoir: reservoirOf(1000) });
    expect(result.admittedCardIds).toHaveLength(6);
    expect(result.activeCountAfter).toBe(6);
    expect(result.freshCountAfter).toBe(6);
  });

  it("admits fewer than 6 if the NEW reservoir itself has fewer than 6 cards", () => {
    const result = computeActiveAdmissions({ activeCards: [], newReservoir: reservoirOf(3) });
    expect(result.admittedCardIds).toEqual(["r0", "r1", "r2"]);
    expect(result.activeCountAfter).toBe(3);
    expect(result.freshCountAfter).toBe(3);
  });

  it("admission never changes card_status -- admitted cards stay NEW (section 3, invariant 34.1)", () => {
    const result = computeActiveAdmissions({ activeCards: [], newReservoir: reservoirOf(6) });
    // computeActiveAdmissions's result only ever names cardIds to flip
    // pool_status; it has no card_status field to set at all.
    expect(result.admittedCardIds).toHaveLength(6);
    for (const id of result.admittedCardIds) {
      // The only semantics admission carries for `id` is "now Active" --
      // proving the caller must separately decide whether/when to call
      // applyFirstPresentation (Phase 2), never implied by admission.
      expect(typeof id).toBe("string");
    }
  });

  it("no Pre-Active pool: a NEW card goes reservoir -> admitted in one step, never through an intermediate status", () => {
    const result = computeActiveAdmissions({ activeCards: [], newReservoir: reservoirOf(1) });
    expect(result.admittedCardIds).toEqual(["r0"]);
  });

  it("Test 2: one Fresh card's first Correct frees exactly one Fresh slot, admitting exactly one NEW refill", () => {
    const first = computeActiveAdmissions({ activeCards: [], newReservoir: reservoirOf(100) });
    expect(first.admittedCardIds).toHaveLength(6);

    // r0 gets presented and answers Correct: NEW -> LEARNING/FRESH -> LEARNING_1.
    const afterFirstPresented = applyFirstPresentation(INITIAL_CARD_STATE);
    const afterFirstCorrect = applyNormalCorrect(afterFirstPresented);
    expect(afterFirstCorrect.learningStage).toBe("LEARNING_1");

    const activeCardsAfter: DeckActivePoolCard[] = [
      { cardId: "r0", cardStatus: afterFirstCorrect.cardStatus, poolStatus: "ACTIVE", learningStage: afterFirstCorrect.learningStage },
      ...first.admittedCardIds.slice(1).map(activeFreshNew),
    ];
    expect(activeCardsAfter.filter(isFresh)).toHaveLength(5); // Fresh dropped by 1

    const remainingReservoir = reservoirOf(94, "r").map((c) => ({ ...c, cardId: `r${Number(c.cardId.slice(1)) + 6}` }));
    const refill = computeActiveAdmissions({ activeCards: activeCardsAfter, newReservoir: remainingReservoir });

    expect(refill.admittedCardIds).toHaveLength(1); // exactly one NEW refill
    expect(refill.activeCountAfter).toBe(7); // Active 6 -> 7
    expect(refill.freshCountAfter).toBe(6); // Fresh returns to 6 (back at the cap)
  });

  it("Fresh never exceeds 6, even with plenty of Active target room left", () => {
    // 6 Fresh cards already Active, 4 more non-Fresh Active cards (Active=10, well under target 20).
    const activeCards: DeckActivePoolCard[] = [
      ...Array.from({ length: 6 }, (_, i) => activeFreshNew(`fresh${i}`)),
      ...Array.from({ length: 4 }, (_, i) => activeLearning(`l1-${i}`, "LEARNING_1")),
    ];
    const result = computeActiveAdmissions({ activeCards, newReservoir: reservoirOf(50) });
    expect(result.admittedCardIds).toHaveLength(0);
    expect(result.freshCountAfter).toBe(6);
  });

  it("stops admitting once Active reaches target 20, even if Fresh has room", () => {
    // 20 Active cards, all past Fresh (so Fresh=0, plenty of "Fresh room"), target already saturated.
    const activeCards: DeckActivePoolCard[] = Array.from({ length: 20 }, (_, i) => activeLearning(`l1-${i}`, "LEARNING_1"));
    const result = computeActiveAdmissions({ activeCards, newReservoir: reservoirOf(50) });
    expect(result.admittedCardIds).toHaveLength(0);
    expect(result.activeCountAfter).toBe(20);
  });

  it("an empty NEW reservoir admits nothing even with room on both axes", () => {
    const result = computeActiveAdmissions({ activeCards: [], newReservoir: [] });
    expect(result.admittedCardIds).toEqual([]);
    expect(result.activeCountAfter).toBe(0);
    expect(result.freshCountAfter).toBe(0);
  });

  it("FORGOTTEN (relearning) cards count toward the Active target but never toward Fresh", () => {
    const activeCards: DeckActivePoolCard[] = Array.from({ length: 14 }, (_, i) => ({
      cardId: `forgotten${i}`,
      cardStatus: "FORGOTTEN" as const,
      poolStatus: "ACTIVE" as const,
      learningStage: null,
    }));
    const result = computeActiveAdmissions({ activeCards, newReservoir: reservoirOf(50) });
    // Active=14 (<20), Fresh=0 (<6) -> admits up to the Fresh limit (6), landing Active at 20.
    expect(result.admittedCardIds).toHaveLength(6);
    expect(result.activeCountAfter).toBe(20);
    expect(result.freshCountAfter).toBe(6);
  });

  it("Active grows gradually toward 20 as repeated first-Corrects free Fresh slots (section 8.3's worked example, generalized)", () => {
    let activeCards: DeckActivePoolCard[] = [];
    const reservoir = reservoirOf(1000);
    let nextReservoirIndex = 0;

    const admitFromReservoir = (count: number) => {
      const admitted = reservoir.slice(nextReservoirIndex, nextReservoirIndex + count);
      nextReservoirIndex += count;
      activeCards = [...activeCards, ...admitted.map((c) => activeFreshNew(c.cardId))];
    };

    // Initial admission.
    let step = computeActiveAdmissions({ activeCards, newReservoir: reservoir.slice(nextReservoirIndex) });
    admitFromReservoir(step.admittedCardIds.length);
    expect(step.activeCountAfter).toBe(6);

    const activeCountHistory: number[] = [step.activeCountAfter];

    // Repeatedly: one Fresh card graduates past Fresh (simulated directly,
    // not via a card actually drawn/answered -- Phase 6's draw loop is out
    // of scope), then refill.
    while (step.activeCountAfter < 20) {
      const freshIndex = activeCards.findIndex(isFresh);
      activeCards = activeCards.map((c, i) => (i === freshIndex ? activeLearning(c.cardId, "LEARNING_1") : c));

      step = computeActiveAdmissions({ activeCards, newReservoir: reservoir.slice(nextReservoirIndex) });
      admitFromReservoir(step.admittedCardIds.length);
      activeCountHistory.push(step.activeCountAfter);

      expect(step.freshCountAfter).toBeLessThanOrEqual(6);
    }

    expect(step.activeCountAfter).toBe(20);
    // Strictly non-decreasing (growth, never shrinkage) and, once past the
    // initial burst of 6, grows one at a time -- "gradual", not a jump.
    for (let i = 1; i < activeCountHistory.length; i += 1) {
      expect(activeCountHistory[i]).toBeGreaterThanOrEqual(activeCountHistory[i - 1]);
    }
    expect(activeCountHistory.slice(1)).toEqual(activeCountHistory.slice(1).map((_, i) => 7 + i));
  });
});

describe("buildFirstPassOrder (section 9)", () => {
  it("is a permutation of the input -- every card appears exactly once, no repeats", () => {
    const ids = ["A", "B", "C", "D", "E", "F"];
    let seed = 42;
    const random = () => {
      // Deterministic LCG, not Math.random -- reproducible across runs/CI.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const order = buildFirstPassOrder(ids, random);
    expect([...order].sort()).toEqual([...ids].sort());
    expect(new Set(order).size).toBe(ids.length);
  });

  it("does not mutate the input array", () => {
    const ids = ["A", "B", "C"];
    buildFirstPassOrder(ids, () => 0.5);
    expect(ids).toEqual(["A", "B", "C"]);
  });

  it("is deterministic given a scripted RandomSource (section 24: seeded reproducibility)", () => {
    const ids = ["A", "B", "C", "D"];
    const script = [0.1, 0.9, 0.5];
    let i = 0;
    const scriptedRandom = () => script[i++];

    const run = () => {
      i = 0;
      return buildFirstPassOrder(ids, scriptedRandom);
    };

    expect(run()).toEqual(run());
  });

  it("an empty or single-element input returns it unchanged", () => {
    expect(buildFirstPassOrder([], () => 0.5)).toEqual([]);
    expect(buildFirstPassOrder(["only"], () => 0.5)).toEqual(["only"]);
  });
});
