import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyCard } from "ts-fsrs";

import {
  selectActiveInternalCard,
  selectActiveStarvationCandidate,
  selectTargetReachedRepairCandidate,
} from "@/lib/learning-engine/scheduler/active-internal-selection";
import { findGlobalInterrupt } from "@/lib/learning-engine/scheduler/interrupts";
import type { RepairObligation } from "@/lib/learning-engine/repair-scheduler";
import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 22.3
 * (Active starvation) and the approved ACTIVE-source internal ordering
 * (Phase 6D brief sections 8-12): starvation > target-reached Repair >
 * Spaced Confirmation > ordinary weighted Active.
 */

const NOW = new Date("2026-01-01T00:00:00.000Z");

function scriptedRandom(values: readonly number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

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

function repairGovernedCard(cardId: string, obligation: RepairObligation, overrides: Partial<SchedulableCardRow> = {}): SchedulableCardRow {
  return activeCard({ cardId, repairPending: true, repairObligation: obligation, ...overrides });
}

function spacedConfirmationCard(cardId: string, gatePosition: number): SchedulableCardRow {
  return activeCard({
    cardId,
    cardStatus: "FORGOTTEN",
    learningStage: null,
    relearningPhase: "SPACED_CONFIRMATION_PENDING",
    correctCooldownUntilPosition: gatePosition,
  });
}

function obligation(cardId: string, wrongPosition: number, hardCapPosition: number): RepairObligation {
  return { cardId, wrongPosition, targetPosition: wrongPosition + 4, hardCapPosition };
}

// =============================================================================
// ACTIVE STARVATION (section 22.3)
// =============================================================================

describe("selectActiveStarvationCandidate (section 22.3)", () => {
  it("13. 39 draws -> no starvation guarantee", () => {
    const card = activeCard({ activeDrawsSinceEligible: 39 });
    expect(selectActiveStarvationCandidate([card], 0, scriptedRandom([0.5]))).toBeNull();
  });

  it("14. 40 draws -> starvation candidate", () => {
    const card = activeCard({ activeDrawsSinceEligible: 40 });
    const result = selectActiveStarvationCandidate([card], 0, scriptedRandom([0.5]));
    expect(result?.card.cardId).toBe("card-1");
  });

  it("15. 41+ draws remains a starvation candidate until actually selected (never silently expires)", () => {
    for (const draws of [41, 60, 500]) {
      const card = activeCard({ activeDrawsSinceEligible: draws });
      expect(selectActiveStarvationCandidate([card], 0, scriptedRandom([0.5]))?.card.cardId).toBe("card-1");
    }
  });

  it("16. the highest active_draws_since_eligible wins among multiple starved candidates", () => {
    const cards = [
      activeCard({ cardId: "a", activeDrawsSinceEligible: 40 }),
      activeCard({ cardId: "b", activeDrawsSinceEligible: 55 }),
      activeCard({ cardId: "c", activeDrawsSinceEligible: 41 }),
    ];
    const result = selectActiveStarvationCandidate(cards, 0, scriptedRandom([0.5]));
    expect(result?.card.cardId).toBe("b");
  });

  it("17. an exact tie in active_draws_since_eligible uses the injected RNG, not timestamps or any other aging rule", () => {
    const cards = [activeCard({ cardId: "a", activeDrawsSinceEligible: 40 }), activeCard({ cardId: "b", activeDrawsSinceEligible: 40 })];
    const low = selectActiveStarvationCandidate(cards, 0, scriptedRandom([0])); // index 0 -> "a"
    const high = selectActiveStarvationCandidate(cards, 0, scriptedRandom([0.99])); // index 1 -> "b"
    expect(low?.card.cardId).toBe("a");
    expect(high?.card.cardId).toBe("b");
  });

  it("only ordinary eligible Active candidates participate (cooldown-blocked and repair-governed cards never count, however high their draw count)", () => {
    const cooldownBlocked = activeCard({ cardId: "blocked", activeDrawsSinceEligible: 100, correctCooldownUntilPosition: 50 });
    const repairGoverned = repairGovernedCard("governed", obligation("governed", 10, 17), { activeDrawsSinceEligible: 100 });
    expect(selectActiveStarvationCandidate([cooldownBlocked], 0, scriptedRandom([0.5]))).toBeNull();
    expect(selectActiveStarvationCandidate([repairGoverned], 0, scriptedRandom([0.5]))).toBeNull();
  });

  it("18. starvation never produces a GLOBAL interrupt and cannot force the top-level source to ACTIVE -- findGlobalInterrupt is entirely blind to it", () => {
    const starved = activeCard({ cardId: "starved", activeDrawsSinceEligible: 1000 });
    const result = findGlobalInterrupt({
      cards: [starved],
      schedulerPosition: 100,
      now: NOW,
      desiredRetention: 0.9,
      lastCriticalDuePosition: null,
      random: scriptedRandom([0.5]),
    });
    expect(result).toBeNull();
  });
});

// =============================================================================
// TARGET-REACHED REPAIR, NOT HARD CAP (Phase 6D brief section 10)
// =============================================================================

describe("selectTargetReachedRepairCandidate (Phase 6D brief section 10)", () => {
  it("a target-reached repair (not yet hard-cap-reached) is a candidate", () => {
    const card = repairGovernedCard("r1", obligation("r1", 10, 17)); // target at 14, hard cap at 17
    const result = selectTargetReachedRepairCandidate([card], 14, scriptedRandom([0.5]));
    expect(result?.cardId).toBe("r1");
  });

  it("a hard-cap-reached repair is excluded from this channel (it is a GLOBAL interrupt, handled upstream)", () => {
    const card = repairGovernedCard("r1", obligation("r1", 10, 17));
    expect(selectTargetReachedRepairCandidate([card], 17, scriptedRandom([0.5]))).toBeNull();
  });

  it("a repair whose target has not yet been reached is excluded", () => {
    const card = repairGovernedCard("r1", obligation("r1", 10, 17));
    expect(selectTargetReachedRepairCandidate([card], 13, scriptedRandom([0.5]))).toBeNull();
  });

  it("multiple target-reached repairs resolve oldest-Wrong-first, reusing Phase 4's selectRepairCandidate", () => {
    // oldest: wrong=10 -> target 14, hard cap 17. newer: wrong=12 -> target
    // 16, hard cap 19. At position 16 both targets are reached but neither
    // hard cap is -- the window where this channel's own priority rule
    // (rather than the global hard-cap gate) actually decides the winner.
    const cards = [repairGovernedCard("newer", obligation("newer", 12, 19)), repairGovernedCard("oldest", obligation("oldest", 10, 17))];
    const result = selectTargetReachedRepairCandidate(cards, 16, scriptedRandom([0.5]));
    expect(result?.cardId).toBe("oldest");
  });
});

// =============================================================================
// ACTIVE INTERNAL PRIORITY (Phase 6D brief sections 9, 12)
// =============================================================================

describe("selectActiveInternalCard priority ordering (Phase 6D brief section 9)", () => {
  it("19. starvation beats a target-reached Repair candidate", () => {
    const starved = activeCard({ cardId: "starved", activeDrawsSinceEligible: 40 });
    const repairTarget = repairGovernedCard("repair", obligation("repair", 10, 17)); // target reached at 14
    const result = selectActiveInternalCard([starved, repairTarget], 14, scriptedRandom([0.5]));
    expect(result).toMatchObject({ cardId: "starved", reason: "active_starvation" });
  });

  it("20. a target-reached Repair candidate beats a due Spaced Confirmation candidate", () => {
    const repairTarget = repairGovernedCard("repair", obligation("repair", 10, 17)); // target reached at 14
    const spaced = spacedConfirmationCard("spaced", 10); // gate opened well before position 14
    const result = selectActiveInternalCard([repairTarget, spaced], 14, scriptedRandom([0.5]));
    expect(result).toMatchObject({ cardId: "repair", reason: "repair_target" });
  });

  it("21. a due Spaced Confirmation candidate beats an ordinary weighted Active candidate", () => {
    const spaced = spacedConfirmationCard("spaced", 10);
    const ordinary = activeCard({ cardId: "ordinary", learningStage: "LEARNING_1" });
    const result = selectActiveInternalCard([spaced, ordinary], 14, scriptedRandom([0.5]));
    expect(result).toMatchObject({ cardId: "spaced", reason: "spaced_confirmation" });
  });

  it("22. an ordinary weighted Active candidate is used only when starvation, target-reached Repair, and Spaced Confirmation are all absent", () => {
    const ordinary = activeCard({ cardId: "ordinary", learningStage: "LEARNING_1" });
    const result = selectActiveInternalCard([ordinary], 0, scriptedRandom([0.5]));
    expect(result).toMatchObject({ cardId: "ordinary", reason: "active_weighted_selection" });
  });

  it("23. an empty ACTIVE internal candidate set returns null, never throws", () => {
    expect(selectActiveInternalCard([], 0, scriptedRandom([0.5]))).toBeNull();

    const onlyIneligible = activeCard({ correctCooldownUntilPosition: 100 });
    expect(selectActiveInternalCard([onlyIneligible], 0, scriptedRandom([0.5]))).toBeNull();
  });

  it("full priority chain: starvation > repair_target > spaced_confirmation > active_weighted_selection, all present at once", () => {
    const starved = activeCard({ cardId: "starved", activeDrawsSinceEligible: 40 });
    const repairTarget = repairGovernedCard("repair", obligation("repair", 10, 17));
    const spaced = spacedConfirmationCard("spaced", 10);
    const ordinary = activeCard({ cardId: "ordinary", learningStage: "LEARNING_1" });

    const all = [starved, repairTarget, spaced, ordinary];
    expect(selectActiveInternalCard(all, 14, scriptedRandom([0.5]))).toMatchObject({ reason: "active_starvation" });
    expect(selectActiveInternalCard(all.filter((c) => c.cardId !== "starved"), 14, scriptedRandom([0.5]))).toMatchObject({
      reason: "repair_target",
    });
    expect(
      selectActiveInternalCard(
        all.filter((c) => c.cardId !== "starved" && c.cardId !== "repair"),
        14,
        scriptedRandom([0.5]),
      ),
    ).toMatchObject({ reason: "spaced_confirmation" });
    expect(selectActiveInternalCard([ordinary], 14, scriptedRandom([0.5]))).toMatchObject({ reason: "active_weighted_selection" });
  });
});

// =============================================================================
// GLOBAL VS INTERNAL (Phase 6D brief section 26)
// =============================================================================

describe("target-reached repair without a hard cap waits for an ACTIVE source slot (section 26)", () => {
  it("is not a global interrupt, but IS selectable once ACTIVE is the chosen source", () => {
    const repairTarget = repairGovernedCard("repair", obligation("repair", 10, 17)); // target reached at 14, hard cap 17

    const globalResult = findGlobalInterrupt({
      cards: [repairTarget],
      schedulerPosition: 14,
      now: NOW,
      desiredRetention: 0.9,
      lastCriticalDuePosition: null,
      random: scriptedRandom([0.5]),
    });
    expect(globalResult).toBeNull();

    const internalResult = selectActiveInternalCard([repairTarget], 14, scriptedRandom([0.5]));
    expect(internalResult).toMatchObject({ cardId: "repair", reason: "repair_target" });
  });
});

// =============================================================================
// DETERMINISM (Phase 6D brief section 14)
// =============================================================================

describe("determinism", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("28. identical state + RNG sequence -> identical Active internal result", () => {
    const cards = [
      activeCard({ cardId: "a", activeDrawsSinceEligible: 40 }),
      activeCard({ cardId: "b", activeDrawsSinceEligible: 40 }),
      repairGovernedCard("repair", obligation("repair", 10, 17)),
      spacedConfirmationCard("spaced", 10),
    ];
    const run = () => selectActiveInternalCard(cards, 14, lcg(7));
    expect(run()).toEqual(run());
  });

  it("29. Math.random is never called directly when an injected RandomSource is supplied", () => {
    const spy = vi.spyOn(Math, "random");
    const cards = [
      activeCard({ cardId: "a", activeDrawsSinceEligible: 40 }),
      activeCard({ cardId: "b", activeDrawsSinceEligible: 40 }),
      repairGovernedCard("repair", obligation("repair", 10, 17)),
      spacedConfirmationCard("spaced", 10),
    ];
    selectActiveInternalCard(cards, 14, scriptedRandom([0.3]));
    expect(spy).not.toHaveBeenCalled();
  });
});
