import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyCard } from "ts-fsrs";

import {
  chooseActiveCard,
  findActiveStarvationCandidates,
  selectOrdinaryActiveCandidates,
} from "@/lib/learning-engine/scheduler/active-selection";
import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 19
 * (Phase 6C: ACTIVE source candidate selection).
 */

const NOW = new Date("2026-01-01T00:00:00.000Z");

function activeCard(overrides: Partial<SchedulableCardRow> = {}): SchedulableCardRow {
  return {
    cardId: "card-1",
    cardStatus: "LEARNING",
    learningStage: "FRESH",
    poolStatus: "ACTIVE",
    relearningPhase: null,
    hasEverBeenMastered: false,
    repairPending: false,
    fsrsReviewCorrectCount: 0,
    fsrsReviewCorrectStreak: 0,
    correctCooldownUntilPosition: null,
    activeDrawsSinceEligible: 0,
    repairObligation: null,
    fsrsCard: createEmptyCard(NOW),
    ...overrides,
  };
}

/** A card admitted to Active but never yet presented (section 3): card_status NEW, pool_status ACTIVE, learning_stage still null. */
function newActiveCard(overrides: Partial<SchedulableCardRow> = {}): SchedulableCardRow {
  return activeCard({
    cardStatus: "NEW",
    learningStage: null,
    ...overrides,
  });
}

function scriptedRandom(values: readonly number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("selectOrdinaryActiveCandidates (eligibility, section 19 + Phase 6C brief section 2)", () => {
  it("4. a cooldown-blocked card is excluded", () => {
    const card = activeCard({ correctCooldownUntilPosition: 50 });
    expect(selectOrdinaryActiveCandidates([card], 40)).toHaveLength(0);
    expect(selectOrdinaryActiveCandidates([card], 50)).toHaveLength(1); // clear exactly at the boundary
  });

  it("5. a repair-governed card is excluded, even though learningStage is still FRESH/L1/L2", () => {
    const card = activeCard({ repairPending: true });
    expect(selectOrdinaryActiveCandidates([card], 0)).toHaveLength(0);
  });

  it("6. a FORGOTTEN (relearning) card is excluded from ordinary Active weighting entirely", () => {
    const forgotten = activeCard({
      cardId: "forgotten-1",
      cardStatus: "FORGOTTEN",
      learningStage: null,
      relearningPhase: "REPAIR_PENDING",
    });
    expect(selectOrdinaryActiveCandidates([forgotten], 0)).toHaveLength(0);
  });

  it("26. a SPACED_CONFIRMATION_PENDING card is also excluded (still FORGOTTEN, still repair-governed)", () => {
    const spacedPending = activeCard({
      cardId: "spaced-1",
      cardStatus: "FORGOTTEN",
      learningStage: null,
      relearningPhase: "SPACED_CONFIRMATION_PENDING",
    });
    expect(selectOrdinaryActiveCandidates([spacedPending], 0)).toHaveLength(0);
  });

  it("a card not Active (poolStatus OUTSIDE or null) is excluded even with a valid learningStage", () => {
    const outside = activeCard({ poolStatus: "OUTSIDE" });
    const reservoir = activeCard({ poolStatus: null, cardStatus: "NEW", learningStage: null });
    expect(selectOrdinaryActiveCandidates([outside, reservoir], 0)).toHaveLength(0);
  });

  it("an eligible FRESH/LEARNING_1/LEARNING_2 card is included", () => {
    const fresh = activeCard({ cardId: "a", learningStage: "FRESH" });
    const l1 = activeCard({ cardId: "b", learningStage: "LEARNING_1" });
    const l2 = activeCard({ cardId: "c", learningStage: "LEARNING_2" });
    expect(selectOrdinaryActiveCandidates([fresh, l1, l2], 0)).toHaveLength(3);
  });
});

describe("NEW+ACTIVE cards are ordinary Active candidates (review correction: sections 3, 8.2)", () => {
  it("a brand-new deck with 6 ACTIVE+NEW cards has selectable Active candidates", () => {
    const sixNewCards = Array.from({ length: 6 }, (_, i) => newActiveCard({ cardId: `new-${i}` }));
    expect(selectOrdinaryActiveCandidates(sixNewCards, 0)).toHaveLength(6);
  });

  it("chooseActiveCard() does not return null for a deck of only NEW+ACTIVE cards", () => {
    const sixNewCards = Array.from({ length: 6 }, (_, i) => newActiveCard({ cardId: `new-${i}` }));
    const result = chooseActiveCard(sixNewCards, 0, () => 0.5);
    expect(result).not.toBeNull();
    expect(result?.candidateCount).toBe(6);
  });

  it("ACTIVE+NEW receives the FRESH base weight (1.00 x aging)", () => {
    const result = chooseActiveCard([newActiveCard({ activeDrawsSinceEligible: 0 })], 0, () => 0.5);
    expect(result?.weight).toBeCloseTo(1.0);
  });

  it("selection does not mutate NEW -> LEARNING (stays pure)", () => {
    const card = newActiveCard();
    const cardBefore = { ...card };
    chooseActiveCard([card], 0, () => 0.5);
    selectOrdinaryActiveCandidates([card], 0);
    expect(card.cardStatus).toBe("NEW");
    expect(card.learningStage).toBeNull();
    expect(card).toEqual(cardBefore);
  });

  it("a mix of NEW and LEARNING cards uses the correct relative weights (NEW==FRESH 1.00 vs LEARNING_1 1.20)", () => {
    const newCard = newActiveCard({ cardId: "new" }); // effective weight 1.00
    const l1Card = activeCard({ cardId: "l1", learningStage: "LEARNING_1" }); // weight 1.20
    const total = 1.0 + 1.2;
    const newShare = 1.0 / total;

    const justUnder = chooseActiveCard([newCard, l1Card], 0, scriptedRandom([newShare - 0.001]));
    const justOver = chooseActiveCard([newCard, l1Card], 0, scriptedRandom([newShare + 0.001]));
    expect(justUnder?.cardId).toBe("new");
    expect(justOver?.cardId).toBe("l1");
  });

  it("a repair/relearning-governed NEW card remains excluded (defense-in-depth: not reachable under the engine's own invariants, since repair_pending/relearning_phase only ever apply to LEARNING/FORGOTTEN cards)", () => {
    const governedNew = newActiveCard({ repairPending: true });
    expect(selectOrdinaryActiveCandidates([governedNew], 0)).toHaveLength(0);
  });

  it("a cooldown-blocked NEW card is excluded (defense-in-depth: a never-presented NEW card should never actually carry a cooldown, since only a normal Correct sets one)", () => {
    const cooldownNew = newActiveCard({ correctCooldownUntilPosition: 50 });
    expect(selectOrdinaryActiveCandidates([cooldownNew], 40)).toHaveLength(0);
    expect(selectOrdinaryActiveCandidates([cooldownNew], 50)).toHaveLength(1);
  });

  it("a NEW card not yet admitted to Active (poolStatus null, the reservoir) is still excluded", () => {
    const reservoir = newActiveCard({ poolStatus: null });
    expect(selectOrdinaryActiveCandidates([reservoir], 0)).toHaveLength(0);
  });
});

describe("chooseActiveCard weights (section 19, reusing Phase 3's computeActiveWeight unchanged)", () => {
  it("1. FRESH weight = 1.00 x aging(0 draws = 1.00) = 1.00", () => {
    const result = chooseActiveCard([activeCard({ learningStage: "FRESH", activeDrawsSinceEligible: 0 })], 0, () => 0.5);
    expect(result?.weight).toBeCloseTo(1.0);
  });

  it("2. LEARNING_1 weight = 1.20 x aging(0 draws = 1.00) = 1.20", () => {
    const result = chooseActiveCard([activeCard({ learningStage: "LEARNING_1", activeDrawsSinceEligible: 0 })], 0, () => 0.5);
    expect(result?.weight).toBeCloseTo(1.2);
  });

  it("3. LEARNING_2 weight = 1.10 x aging(0 draws = 1.00) = 1.10", () => {
    const result = chooseActiveCard([activeCard({ learningStage: "LEARNING_2", activeDrawsSinceEligible: 0 })], 0, () => 0.5);
    expect(result?.weight).toBeCloseTo(1.1);
  });

  it("aging multiplier is applied on top of stage weight (FRESH, 10 draws -> 1.00 x 1.20)", () => {
    const result = chooseActiveCard([activeCard({ learningStage: "FRESH", activeDrawsSinceEligible: 10 })], 0, () => 0.5);
    expect(result?.weight).toBeCloseTo(1.0 * 1.2);
  });

  it("7. a higher-weight candidate gets a proportionally larger weighted range", () => {
    const low = activeCard({ cardId: "low", learningStage: "LEARNING_2", activeDrawsSinceEligible: 0 }); // weight 1.10
    const high = activeCard({ cardId: "high", learningStage: "LEARNING_1", activeDrawsSinceEligible: 0 }); // weight 1.20
    const total = 1.1 + 1.2;
    const lowShare = 1.1 / total;

    // Just under low's share -> low wins; just at/over -> high wins.
    const justUnder = chooseActiveCard([low, high], 0, scriptedRandom([lowShare - 0.001]));
    const justOver = chooseActiveCard([low, high], 0, scriptedRandom([lowShare + 0.001]));
    expect(justUnder?.cardId).toBe("low");
    expect(justOver?.cardId).toBe("high");
  });

  it("8. zero eligible candidates returns null, never throws", () => {
    const cooldownBlocked = activeCard({ correctCooldownUntilPosition: 100 });
    expect(chooseActiveCard([cooldownBlocked], 0, () => 0.5)).toBeNull();
    expect(chooseActiveCard([], 0, () => 0.5)).toBeNull();
  });

  it("9. seeded deterministic selection: identical candidates + identical RNG give identical results", () => {
    const cards = [
      activeCard({ cardId: "a", learningStage: "FRESH" }),
      activeCard({ cardId: "b", learningStage: "LEARNING_1" }),
      activeCard({ cardId: "c", learningStage: "LEARNING_2" }),
    ];
    const run = () => chooseActiveCard(cards, 0, scriptedRandom([0.42]));
    expect(run()).toEqual(run());
  });

  it("candidateCount reflects only the eligible subset, not the full input", () => {
    const eligible = activeCard({ cardId: "eligible" });
    const blocked = activeCard({ cardId: "blocked", correctCooldownUntilPosition: 100 });
    const result = chooseActiveCard([eligible, blocked], 0, () => 0.5);
    expect(result?.candidateCount).toBe(1);
  });
});

describe("findActiveStarvationCandidates (Phase 6C brief section 7: candidate exposure only, no override logic)", () => {
  it("includes a candidate whose activeDrawsSinceEligible meets or exceeds the threshold", () => {
    const candidates = selectOrdinaryActiveCandidates(
      [activeCard({ cardId: "starved", activeDrawsSinceEligible: 40 }), activeCard({ cardId: "fresh", activeDrawsSinceEligible: 0 })],
      0,
    );
    const starved = findActiveStarvationCandidates(candidates);
    expect(starved.map((c) => c.card.cardId)).toEqual(["starved"]);
  });

  it("excludes a candidate just under the threshold", () => {
    const candidates = selectOrdinaryActiveCandidates([activeCard({ activeDrawsSinceEligible: 39 })], 0);
    expect(findActiveStarvationCandidates(candidates)).toHaveLength(0);
  });

  it("accepts a custom threshold (for testability, not a spec change)", () => {
    const candidates = selectOrdinaryActiveCandidates([activeCard({ activeDrawsSinceEligible: 5 })], 0);
    expect(findActiveStarvationCandidates(candidates, 5)).toHaveLength(1);
    expect(findActiveStarvationCandidates(candidates, 6)).toHaveLength(0);
  });

  it("does not mutate or reset any candidate's activeDrawsSinceEligible", () => {
    const card = activeCard({ activeDrawsSinceEligible: 45 });
    const candidates = selectOrdinaryActiveCandidates([card], 0);
    findActiveStarvationCandidates(candidates);
    expect(card.activeDrawsSinceEligible).toBe(45);
  });
});

describe("determinism: no Math.random is ever called by this module", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("chooseActiveCard never touches Math.random", () => {
    const spy = vi.spyOn(Math, "random");
    chooseActiveCard(
      [activeCard({ cardId: "a" }), activeCard({ cardId: "b", learningStage: "LEARNING_1" })],
      0,
      scriptedRandom([0.3]),
    );
    expect(spy).not.toHaveBeenCalled();
  });
});
