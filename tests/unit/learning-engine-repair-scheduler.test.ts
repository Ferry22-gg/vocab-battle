import { describe, expect, it } from "vitest";

import {
  clearRepairObligationFields,
  createRepairObligation,
  findMandatoryRepairInterrupt,
  isGovernedByRepairObligation,
  isRepairHardCapReached,
  isRepairTargetReached,
  isSpacedConfirmationDue,
  resolveOrdinaryRepairCorrect,
  resolveOrdinaryRepairWrong,
  resolveRelearningRepairCorrect,
  resolveRelearningRepairWrong,
  resolveSpacedConfirmationWrong,
  sampleRepairGap,
  selectRepairCandidate,
  type RepairObligation,
} from "@/lib/learning-engine/repair-scheduler";
import {
  advanceActiveDrawCounters,
  isEligibleForNormalSelection,
  type ActiveDrawCounterCard,
} from "@/lib/learning-engine/active-priority";
import { applyLongTermWrong, applySpacedCorrect, applyWrong } from "@/lib/learning-engine/transitions";
import { INITIAL_CARD_STATE, type LearningEngineCardState } from "@/lib/learning-engine/state";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 12,
 * 13, 22.1, 35.2 (Phase 4: repair scheduler).
 */

function scriptedRandom(values: readonly number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

/** Deterministic LCG for broad/varied coverage without Math.random. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const FRESH: LearningEngineCardState = { ...INITIAL_CARD_STATE, cardStatus: "LEARNING", learningStage: "FRESH" };

function acquired(overrides: Partial<LearningEngineCardState> = {}): LearningEngineCardState {
  return { ...INITIAL_CARD_STATE, cardStatus: "ACQUIRED", poolStatus: "OUTSIDE", ...overrides };
}

// =============================================================================
// 1. Position semantics
// =============================================================================

describe("repair position semantics (section 12.2, off-by-one review)", () => {
  it("Test case 1: Wrong at N with sampled gap 3 -- N+1..N+3 blocked, N+4 repair eligible", () => {
    const N = 100;
    const repair = createRepairObligation({ cardId: "a", wrongPosition: N, random: scriptedRandom([0]) }); // index 0 -> gap 3
    expect(repair.targetPosition).toBe(N + 4);

    expect(isRepairTargetReached(repair, N + 1)).toBe(false);
    expect(isRepairTargetReached(repair, N + 2)).toBe(false);
    expect(isRepairTargetReached(repair, N + 3)).toBe(false);
    expect(isRepairTargetReached(repair, N + 4)).toBe(true);
  });

  it("Test case 2: Wrong at N with sampled gap 6 -- N+1..N+6 blocked, N+7 cannot be delayed further (hard cap)", () => {
    const N = 100;
    const repair = createRepairObligation({ cardId: "a", wrongPosition: N, random: scriptedRandom([0.99]) }); // index 3 -> gap 6
    expect(repair.targetPosition).toBe(N + 7);
    expect(repair.hardCapPosition).toBe(N + 7); // sampled gap 6 happens to coincide with the fixed hard cap here

    for (let p = N + 1; p <= N + 6; p += 1) {
      expect(isRepairTargetReached(repair, p)).toBe(false);
      expect(isRepairHardCapReached(repair, p)).toBe(false);
    }
    expect(isRepairTargetReached(repair, N + 7)).toBe(true);
    expect(isRepairHardCapReached(repair, N + 7)).toBe(true);
  });

  it("hard cap is always wrongPosition + 7, independent of the sampled gap (never derived from it)", () => {
    const N = 50;
    for (const randomValue of [0, 0.3, 0.6, 0.99]) {
      const repair = createRepairObligation({ cardId: "a", wrongPosition: N, random: scriptedRandom([randomValue]) });
      expect(repair.hardCapPosition).toBe(N + 7);
    }
  });

  it("explicit boundary proof for a gap-4 and a gap-5 obligation too", () => {
    const N = 20;
    const gap4 = createRepairObligation({ cardId: "a", wrongPosition: N, random: scriptedRandom([0.26]) }); // index 1 -> gap 4
    expect(gap4.targetPosition).toBe(N + 5);
    expect(isRepairTargetReached(gap4, N + 4)).toBe(false);
    expect(isRepairTargetReached(gap4, N + 5)).toBe(true);

    const gap5 = createRepairObligation({ cardId: "a", wrongPosition: N, random: scriptedRandom([0.51]) }); // index 2 -> gap 5
    expect(gap5.targetPosition).toBe(N + 6);
    expect(isRepairTargetReached(gap5, N + 5)).toBe(false);
    expect(isRepairTargetReached(gap5, N + 6)).toBe(true);
  });
});

// =============================================================================
// Creating a repair obligation / sampling
// =============================================================================

describe("createRepairObligation / sampleRepairGap (section 12.2)", () => {
  it("Test case 3: the sampled gap is always one of 3/4/5/6 intervening cards", () => {
    const seen = new Set<number>();
    const random = lcg(7);
    for (let i = 0; i < 500; i += 1) {
      const gap = sampleRepairGap(random);
      expect([3, 4, 5, 6]).toContain(gap);
      seen.add(gap);
    }
    // Over 500 draws from a 4-value uniform distribution, every value
    // should appear at least once (not a strict statistical test, just a
    // sanity check that sampling isn't degenerate/constant).
    expect(seen).toEqual(new Set([3, 4, 5, 6]));
  });

  it("Test case 4: deterministic RNG produces reproducible target positions", () => {
    const build = () => createRepairObligation({ cardId: "a", wrongPosition: 42, random: lcg(123) });
    expect(build()).toEqual(build());
  });

  it("Test case 5: a repair is never immediate -- the earliest possible target is wrongPosition + 4, for every possible sampled gap", () => {
    const N = 10;
    for (const randomValue of [0, 0.24, 0.26, 0.49, 0.51, 0.74, 0.76, 0.99]) {
      const repair = createRepairObligation({ cardId: "a", wrongPosition: N, random: scriptedRandom([randomValue]) });
      expect(repair.targetPosition).toBeGreaterThanOrEqual(N + 4);
      expect(isRepairTargetReached(repair, N)).toBe(false);
      expect(isRepairTargetReached(repair, N + 1)).toBe(false);
    }
  });

  it("creating an obligation does not itself exclude the card from being presented later -- it only records positions (no mutation of unrelated state)", () => {
    const repair = createRepairObligation({ cardId: "x", wrongPosition: 5, random: scriptedRandom([0.5]) });
    expect(repair.cardId).toBe("x");
    expect(repair.wrongPosition).toBe(5);
  });
});

describe("clearRepairObligationFields (section 8 of the Phase 4 brief)", () => {
  it("returns the fully-cleared shape of all four repair scheduling columns", () => {
    expect(clearRepairObligationFields()).toEqual({
      repairPending: false,
      repairWrongPosition: null,
      repairTargetPosition: null,
      repairHardCapPosition: null,
    });
  });
});

// =============================================================================
// Repair target selection / collision handling
// =============================================================================

describe("selectRepairCandidate / findMandatoryRepairInterrupt (sections 22.1, 35.2)", () => {
  function obligation(cardId: string, wrongPosition: number, hardCapPosition: number): RepairObligation {
    return { cardId, wrongPosition, targetPosition: wrongPosition + 4, hardCapPosition };
  }

  it("Test case 10: multiple simultaneous repair obligations resolve oldest-Wrong-first", () => {
    const repairs = [obligation("late", 20, 27), obligation("oldest", 10, 17), obligation("mid", 15, 22)];
    const winner = selectRepairCandidate(repairs, scriptedRandom([0.5]));
    expect(winner?.cardId).toBe("oldest");
  });

  it("random tie-break only fires when priority is genuinely equal", () => {
    const repairs = [obligation("a", 10, 17), obligation("b", 10, 17)];
    const winnerLow = selectRepairCandidate(repairs, scriptedRandom([0])); // index 0 -> "a"
    const winnerHigh = selectRepairCandidate(repairs, scriptedRandom([0.99])); // index 1 -> "b"
    expect(winnerLow?.cardId).toBe("a");
    expect(winnerHigh?.cardId).toBe("b");
  });

  it("never discards a non-winning repair -- it is simply not the one returned", () => {
    const repairs = [obligation("oldest", 10, 17), obligation("newer", 15, 22)];
    const winner = selectRepairCandidate(repairs, scriptedRandom([0.5]));
    expect(winner?.cardId).toBe("oldest");
    // The caller's own obligation set is untouched by this pure function --
    // "newer" is still present in `repairs`, available for the next draw.
    expect(repairs.some((r) => r.cardId === "newer")).toBe(true);
  });

  it("Test case 11: a hard-cap-reached candidate wins over a merely target-reached (non-hard-cap) candidate", () => {
    const repairs = [
      obligation("target-only", 10, 17), // target reached at 14, hard cap at 17 -- not yet
      obligation("hard-cap-due", 5, 12), // hard cap reached at 12
    ];
    const currentPosition = 14; // target-only IS target-reached here, but NOT hard-cap-reached; hard-cap-due's hard cap (12) has passed
    const winner = findMandatoryRepairInterrupt(repairs, currentPosition, scriptedRandom([0.5]));
    expect(winner?.cardId).toBe("hard-cap-due");
  });

  it("Test case 12: no repair survives beyond its hard cap -- findMandatoryRepairInterrupt always returns a due repair once its hard cap is reached", () => {
    const repair = obligation("a", 10, 17);
    expect(findMandatoryRepairInterrupt([repair], 16, scriptedRandom([0.5]))).toBeNull();
    expect(findMandatoryRepairInterrupt([repair], 17, scriptedRandom([0.5]))?.cardId).toBe("a");
    expect(findMandatoryRepairInterrupt([repair], 30, scriptedRandom([0.5]))?.cardId).toBe("a"); // still surfaces well past the cap -- never silently dropped
  });

  it("returns null when no repair's hard cap has been reached yet, even if obligations exist", () => {
    const repairs = [obligation("a", 10, 17), obligation("b", 12, 19)];
    expect(findMandatoryRepairInterrupt(repairs, 16, scriptedRandom([0.5]))).toBeNull();
  });

  it("Test case 15: identical obligation set + identical RNG gives an identical scheduling result", () => {
    const repairs = [obligation("a", 10, 17), obligation("b", 10, 17), obligation("c", 20, 27)];
    const run = () => findMandatoryRepairInterrupt(repairs, 17, lcg(99));
    expect(run()).toEqual(run());
  });
});

// =============================================================================
// Ordinary acquisition Repair Correct (sections 5, 6 of the Phase 4 brief;
// spec sections 12.3, 12.4)
// =============================================================================

describe("resolveOrdinaryRepairCorrect (sections 12.3, 12.4)", () => {
  it("Test case 6: LEARNING_1 Wrong -> Repair Correct remains LEARNING_1", () => {
    const l1 = { ...FRESH, learningStage: "LEARNING_1" as const, repairPending: true };
    const result = resolveOrdinaryRepairCorrect(l1, 50);
    expect(result.cardState.learningStage).toBe("LEARNING_1");
    expect(result.cardState.cardStatus).toBe("LEARNING");
  });

  it("Test case 7: LEARNING_2 Wrong -> Repair Correct remains LEARNING_2", () => {
    const l2 = { ...FRESH, learningStage: "LEARNING_2" as const, repairPending: true };
    const result = resolveOrdinaryRepairCorrect(l2, 50);
    expect(result.cardState.learningStage).toBe("LEARNING_2");
  });

  it("Test case 8: FRESH Wrong -> Repair Correct becomes LEARNING_1 (Fresh exception)", () => {
    const freshPending = { ...FRESH, repairPending: true };
    const result = resolveOrdinaryRepairCorrect(freshPending, 50);
    expect(result.cardState.learningStage).toBe("LEARNING_1");
  });

  it("a Repair Correct is never a normal stage-advancing success -- it cannot reach ACQUIRED even from LEARNING_2", () => {
    const l2 = { ...FRESH, learningStage: "LEARNING_2" as const, repairPending: true };
    const result = resolveOrdinaryRepairCorrect(l2, 50);
    expect(result.cardState.cardStatus).not.toBe("ACQUIRED");
  });

  it("Test case 9: a successful repair clears the old repair obligation", () => {
    const l1 = { ...FRESH, learningStage: "LEARNING_1" as const, repairPending: true };
    const result = resolveOrdinaryRepairCorrect(l1, 50);
    expect(result.cardState.repairPending).toBe(false);
    expect(result.clearedRepairFields).toEqual({
      repairPending: false,
      repairWrongPosition: null,
      repairTargetPosition: null,
      repairHardCapPosition: null,
    });
  });

  it("begins the normal 5-intervening-card Correct cooldown after resolving (section 5)", () => {
    const l1 = { ...FRESH, learningStage: "LEARNING_1" as const, repairPending: true };
    const result = resolveOrdinaryRepairCorrect(l1, 50);
    expect(result.nextCorrectCooldownUntilPosition).toBe(56); // 50 + 5 + 1, matching active-priority.ts's own (corrected) semantics

    const cooldownCard = { correctCooldownUntilPosition: result.nextCorrectCooldownUntilPosition };
    for (let p = 51; p <= 55; p += 1) {
      expect(isEligibleForNormalSelection(cooldownCard, p)).toBe(false);
    }
    expect(isEligibleForNormalSelection(cooldownCard, 56)).toBe(true);
  });
});

// =============================================================================
// RC-C spec-gap correction: Wrong during an already-pending repair/
// spaced-confirmation retry (docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md
// sections 12.2/13, now-normative).
// =============================================================================

describe("resolveOrdinaryRepairWrong (RC-C spec-gap correction, section 12.2)", () => {
  it("items 1-3: FRESH/L1/L2 repair-retry Wrong -> stage unchanged, new obligation created", () => {
    for (const stage of ["FRESH", "LEARNING_1", "LEARNING_2"] as const) {
      const pending = { ...FRESH, learningStage: stage, repairPending: true };
      const result = resolveOrdinaryRepairWrong({ cardState: pending, cardId: "card-1", wrongPosition: 50, random: scriptedRandom([0]) });
      expect(result.cardState.learningStage).toBe(stage);
      expect(result.cardState.cardStatus).toBe("LEARNING");
      expect(result.cardState.repairPending).toBe(true);
    }
  });

  it("item 5: the new obligation's wrongPosition equals the current committed position", () => {
    const pending = { ...FRESH, repairPending: true };
    const result = resolveOrdinaryRepairWrong({ cardState: pending, cardId: "card-1", wrongPosition: 77, random: scriptedRandom([0]) });
    expect(result.repairObligation.wrongPosition).toBe(77);
  });

  it("item 6: target/hard-cap positions come from createRepairObligation, not a second formula", () => {
    const pending = { ...FRESH, repairPending: true };
    const viaResolve = resolveOrdinaryRepairWrong({ cardState: pending, cardId: "card-1", wrongPosition: 77, random: scriptedRandom([0]) });
    const viaDirect = createRepairObligation({ cardId: "card-1", wrongPosition: 77, random: scriptedRandom([0]) });
    expect(viaResolve.repairObligation).toEqual(viaDirect);
  });

  it("item 4: the old obligation is replaced, not retained -- the caller persists only the returned obligation", () => {
    const pending = { ...FRESH, repairPending: true };
    const result = resolveOrdinaryRepairWrong({ cardState: pending, cardId: "card-1", wrongPosition: 77, random: scriptedRandom([0]) });
    // The resolution carries exactly one obligation (the fresh one) -- there
    // is no field anywhere in RepairWrongResolution for a second, stale one.
    expect(Object.keys(result)).toEqual(["cardState", "repairObligation"]);
    expect(result.repairObligation.wrongPosition).toBe(77);
  });

  it("item 15: does not touch mastery counters", () => {
    const pending = { ...FRESH, repairPending: true, fsrsReviewCorrectCount: 3, fsrsReviewCorrectStreak: 2 };
    const result = resolveOrdinaryRepairWrong({ cardState: pending, cardId: "card-1", wrongPosition: 50, random: scriptedRandom([0]) });
    expect(result.cardState.fsrsReviewCorrectCount).toBe(3);
    expect(result.cardState.fsrsReviewCorrectStreak).toBe(2);
  });

  it("item 16: repeated Repair Wrongs can restart repair multiple times without breaking invariants", () => {
    let state = { ...FRESH, repairPending: true };
    let position = 10;
    for (let i = 0; i < 5; i += 1) {
      const result = resolveOrdinaryRepairWrong({ cardState: state, cardId: "card-1", wrongPosition: position, random: scriptedRandom([i / 5]) });
      expect(result.cardState.repairPending).toBe(true);
      expect(result.repairObligation.wrongPosition).toBe(position);
      expect(result.repairObligation.targetPosition).toBeGreaterThan(position);
      expect(result.repairObligation.hardCapPosition).toBeGreaterThan(position);
      state = result.cardState;
      position += 10;
    }
  });

  it("a later Repair Correct (against the fresh obligation) still follows the existing rules", () => {
    const pending = { ...FRESH, learningStage: "LEARNING_1" as const, repairPending: true };
    const wrongResult = resolveOrdinaryRepairWrong({ cardState: pending, cardId: "card-1", wrongPosition: 50, random: scriptedRandom([0]) });
    const correctResult = resolveOrdinaryRepairCorrect(wrongResult.cardState, 55);
    expect(correctResult.cardState.learningStage).toBe("LEARNING_1"); // unchanged, section 12.3
    expect(correctResult.cardState.repairPending).toBe(false);
  });
});

describe("resolveRelearningRepairWrong (RC-C spec-gap correction, section 13)", () => {
  it("item 7: FORGOTTEN + REPAIR_PENDING + Wrong remains FORGOTTEN/REPAIR_PENDING", () => {
    const forgotten = applyLongTermWrong(acquired());
    const pending = { ...forgotten, repairPending: true };
    const result = resolveRelearningRepairWrong({ cardState: pending, cardId: "card-1", wrongPosition: 100, random: scriptedRandom([0]) });
    expect(result.cardState.cardStatus).toBe("FORGOTTEN");
    expect(result.cardState.relearningPhase).toBe("REPAIR_PENDING");
    expect(result.cardState.repairPending).toBe(true);
  });

  it("item 8: never advances to SPACED_CONFIRMATION_PENDING on a Wrong", () => {
    const forgotten = applyLongTermWrong(acquired());
    const pending = { ...forgotten, repairPending: true };
    const result = resolveRelearningRepairWrong({ cardState: pending, cardId: "card-1", wrongPosition: 100, random: scriptedRandom([0]) });
    expect(result.cardState.relearningPhase).not.toBe("SPACED_CONFIRMATION_PENDING");
  });

  it("the fresh obligation is anchored at the current Wrong position", () => {
    const forgotten = applyLongTermWrong(acquired());
    const pending = { ...forgotten, repairPending: true };
    const result = resolveRelearningRepairWrong({ cardState: pending, cardId: "card-1", wrongPosition: 123, random: scriptedRandom([0]) });
    expect(result.repairObligation.wrongPosition).toBe(123);
  });

  it("preserves hasEverBeenMastered and does not touch mastery counters (the original qualifying long-term Wrong already reset the streak)", () => {
    const forgotten = applyLongTermWrong({ ...acquired(), cardStatus: "LEARNED", hasEverBeenMastered: true, fsrsReviewCorrectCount: 5 });
    const pending = { ...forgotten, repairPending: true };
    const result = resolveRelearningRepairWrong({ cardState: pending, cardId: "card-1", wrongPosition: 100, random: scriptedRandom([0]) });
    expect(result.cardState.hasEverBeenMastered).toBe(true);
    expect(result.cardState.fsrsReviewCorrectCount).toBe(5);
    expect(result.cardState.fsrsReviewCorrectStreak).toBe(0);
  });
});

/**
 * A valid FORGOTTEN + SPACED_CONFIRMATION_PENDING fixture, reached via the
 * real composition: a long-term Wrong, the orchestration-layer merge of
 * repairPending:true + a created obligation, a Repair Correct, and finally
 * merging resolveRelearningRepairCorrect's own clearedRepairFields (which
 * applyRelearningRepairCorrect alone does not apply -- see that function's
 * doc comment) to reach the valid repairPending:false precondition
 * applySpacedConfirmationWrong requires.
 */
function makeSpacedConfirmationPending(baseAcquired: LearningEngineCardState, wrongPosition: number): LearningEngineCardState {
  const forgotten = applyLongTermWrong(baseAcquired);
  const pending = { ...forgotten, repairPending: true };
  const repairResult = resolveRelearningRepairCorrect(pending, wrongPosition);
  return { ...repairResult.cardState, ...repairResult.clearedRepairFields };
}

describe("resolveSpacedConfirmationWrong (RC-C spec-gap correction, section 13)", () => {
  it("items 9-10: FORGOTTEN + SPACED_CONFIRMATION_PENDING + Wrong -> REPAIR_PENDING with a fresh complete obligation", () => {
    const spacedPending = makeSpacedConfirmationPending(acquired(), 100);
    expect(spacedPending.relearningPhase).toBe("SPACED_CONFIRMATION_PENDING");
    expect(spacedPending.repairPending).toBe(false);

    const result = resolveSpacedConfirmationWrong({ cardState: spacedPending, cardId: "card-1", wrongPosition: 106, random: scriptedRandom([0]) });
    expect(result.cardState.cardStatus).toBe("FORGOTTEN");
    expect(result.cardState.relearningPhase).toBe("REPAIR_PENDING");
    expect(result.cardState.repairPending).toBe(true);
    expect(result.repairObligation.wrongPosition).toBe(106);
    expect(result.repairObligation.targetPosition).toBeGreaterThan(106);
    expect(result.repairObligation.hardCapPosition).toBeGreaterThan(106);
  });

  it("item 11: a subsequent Repair Correct can re-enter SPACED_CONFIRMATION_PENDING", () => {
    const spacedPending = makeSpacedConfirmationPending(acquired(), 100);
    const wrongResult = resolveSpacedConfirmationWrong({ cardState: spacedPending, cardId: "card-1", wrongPosition: 106, random: scriptedRandom([0]) });

    const correctResult = resolveRelearningRepairCorrect(wrongResult.cardState, 110);
    expect(correctResult.cardState.relearningPhase).toBe("SPACED_CONFIRMATION_PENDING");
    expect(correctResult.cardState.cardStatus).toBe("FORGOTTEN");
  });

  it("item 12: a subsequent Spaced Correct can still complete relearning (never-mastered -> ACQUIRED)", () => {
    const spacedPending = makeSpacedConfirmationPending(acquired(), 100);
    const wrongResult = resolveSpacedConfirmationWrong({ cardState: spacedPending, cardId: "card-1", wrongPosition: 106, random: scriptedRandom([0]) });
    const correctResult = resolveRelearningRepairCorrect(wrongResult.cardState, 110);
    const finalMerged = { ...correctResult.cardState, ...correctResult.clearedRepairFields };

    const finalState = applySpacedCorrect(finalMerged);
    expect(finalState.cardStatus).toBe("ACQUIRED");
    expect(finalState.poolStatus).toBe("OUTSIDE");
  });

  it("item 12b: previously-mastered card restores to LEARNED via the same second attempt", () => {
    const spacedPending = makeSpacedConfirmationPending({ ...acquired(), cardStatus: "LEARNED", hasEverBeenMastered: true }, 100);
    const wrongResult = resolveSpacedConfirmationWrong({ cardState: spacedPending, cardId: "card-1", wrongPosition: 106, random: scriptedRandom([0]) });
    const correctResult = resolveRelearningRepairCorrect(wrongResult.cardState, 110);
    const finalMerged = { ...correctResult.cardState, ...correctResult.clearedRepairFields };

    const finalState = applySpacedCorrect(finalMerged);
    expect(finalState.cardStatus).toBe("LEARNED");
  });

  it("item 14: does not touch mastery counters", () => {
    const spacedPending = makeSpacedConfirmationPending(acquired({ fsrsReviewCorrectCount: 2 }), 100);
    const result = resolveSpacedConfirmationWrong({ cardState: spacedPending, cardId: "card-1", wrongPosition: 106, random: scriptedRandom([0]) });
    expect(result.cardState.fsrsReviewCorrectCount).toBe(2);
    expect(result.cardState.fsrsReviewCorrectStreak).toBe(0);
  });
});

// =============================================================================
// Relearning (long-term/Near-Due) repair -- sections 7 of the Phase 4
// brief; spec sections 13, 16.3, 6.2
// =============================================================================

describe("resolveRelearningRepairCorrect (sections 13, 16.3)", () => {
  it("Test case 13: a FORGOTTEN card remains ACTIVE (set by the triggering long-term Wrong), and relearning_phase moves REPAIR_PENDING -> SPACED_CONFIRMATION_PENDING", () => {
    const forgotten = applyLongTermWrong(acquired());
    expect(forgotten.cardStatus).toBe("FORGOTTEN");
    expect(forgotten.poolStatus).toBe("ACTIVE");
    expect(forgotten.relearningPhase).toBe("REPAIR_PENDING");

    const result = resolveRelearningRepairCorrect(forgotten, 100);
    expect(result.cardState.cardStatus).toBe("FORGOTTEN"); // the first Repair Correct alone does not complete relearning
    expect(result.cardState.poolStatus).toBe("ACTIVE"); // untouched, still Active
    expect(result.cardState.relearningPhase).toBe("SPACED_CONFIRMATION_PENDING");
  });

  it("clears the repair obligation that triggered relearning, same as the ordinary path", () => {
    const forgotten = applyLongTermWrong(acquired());
    const result = resolveRelearningRepairCorrect(forgotten, 100);
    expect(result.clearedRepairFields.repairPending).toBe(false);
  });

  it("Test case 14: spaced confirmation cannot occur until 5 full intervening cards have passed (N+1..N+5 blocked, N+6 eligible)", () => {
    const forgotten = applyLongTermWrong(acquired());
    const result = resolveRelearningRepairCorrect(forgotten, 100);
    const N = 100;
    expect(result.nextCorrectCooldownUntilPosition).toBe(N + 6);

    const gate = { correctCooldownUntilPosition: result.nextCorrectCooldownUntilPosition };
    expect(isEligibleForNormalSelection(gate, N + 1)).toBe(false);
    expect(isEligibleForNormalSelection(gate, N + 2)).toBe(false);
    expect(isEligibleForNormalSelection(gate, N + 3)).toBe(false);
    expect(isEligibleForNormalSelection(gate, N + 4)).toBe(false);
    expect(isEligibleForNormalSelection(gate, N + 5)).toBe(false);
    expect(isEligibleForNormalSelection(gate, N + 6)).toBe(true);
  });
});

// =============================================================================
// Active Pool interaction (section 9 of the Phase 4 brief)
// =============================================================================

describe("isGovernedByRepairObligation / interaction with Phase 3 aging (section 9)", () => {
  it("a card with a pending within-day repair is governed, even before its target is reached", () => {
    const wronged = applyWrong(FRESH);
    expect(isGovernedByRepairObligation(wronged)).toBe(true);
  });

  it("a card in any relearning phase is governed", () => {
    const forgotten = applyLongTermWrong(acquired());
    expect(isGovernedByRepairObligation(forgotten)).toBe(true);

    const repaired = resolveRelearningRepairCorrect(forgotten, 100).cardState;
    expect(isGovernedByRepairObligation(repaired)).toBe(true); // still governed -- SPACED_CONFIRMATION_PENDING, not yet resolved
  });

  it("an ordinary eligible Active card (no repair, no relearning) is not governed", () => {
    expect(isGovernedByRepairObligation(FRESH)).toBe(false);
  });

  it("does not immediately repeat the Wrong card: it is excluded from ordinary selection AND its repair target has not been reached yet", () => {
    const N = 10;
    const wronged = applyWrong(FRESH);
    const repair = createRepairObligation({ cardId: "a", wrongPosition: N, random: scriptedRandom([0]) });

    expect(isGovernedByRepairObligation(wronged)).toBe(true); // excluded from ordinary selection
    expect(isRepairTargetReached(repair, N + 1)).toBe(false); // not yet due via the repair channel either
  });

  it("worked composition: active_draws_since_eligible does not accumulate for a repair-governed card across repeated draws, while ordinary eligible cards keep aging normally (does not rewrite advanceActiveDrawCounters -- demonstrates feeding it `eligible: false`)", () => {
    const wronged = applyWrong(FRESH);
    const governed = isGovernedByRepairObligation(wronged);
    expect(governed).toBe(true);

    let cards: ActiveDrawCounterCard[] = [
      { cardId: "repairing", activeDrawsSinceEligible: 3, eligible: !governed }, // frozen throughout
      { cardId: "a", activeDrawsSinceEligible: 0, eligible: true },
      { cardId: "b", activeDrawsSinceEligible: 0, eligible: true },
    ];

    // Alternately select "a" and "b" five times -- each should keep
    // accumulating/resetting normally, while "repairing" never moves.
    const selections = ["a", "b", "a", "b", "a"];
    for (const selected of selections) {
      const next = advanceActiveDrawCounters(cards, selected);
      cards = cards.map((c) => ({ ...c, activeDrawsSinceEligible: next.get(c.cardId)! }));
    }

    expect(cards.find((c) => c.cardId === "repairing")?.activeDrawsSinceEligible).toBe(3); // frozen, never accumulated
    expect(cards.find((c) => c.cardId === "a")?.activeDrawsSinceEligible).toBe(0); // selected last -> reset to 0
    expect(cards.find((c) => c.cardId === "b")?.activeDrawsSinceEligible).toBe(1); // selected second-to-last-but-one -> survived 1 draw since
  });
});

// =============================================================================
// Lifecycle gap (review): what makes a SPACED_CONFIRMATION_PENDING card
// selectable again once its 5-intervening-card gate has passed.
// =============================================================================

describe("isSpacedConfirmationDue -- the full relearning lifecycle (sections 9, 13 of the Phase 4 brief)", () => {
  function relearningRepairedAt(wrongPosition: number) {
    const forgotten = applyLongTermWrong(acquired());
    const result = resolveRelearningRepairCorrect(forgotten, wrongPosition);
    return { card: result.cardState, gatePosition: result.nextCorrectCooldownUntilPosition };
  }

  it("1. REPAIR_PENDING: excluded from ordinary selection while waiting for its repair (already governed; isSpacedConfirmationDue never applies to this phase)", () => {
    const forgotten = applyLongTermWrong(acquired());
    expect(forgotten.relearningPhase).toBe("REPAIR_PENDING");
    expect(isGovernedByRepairObligation(forgotten)).toBe(true);
    // isSpacedConfirmationDue only ever concerns SPACED_CONFIRMATION_PENDING;
    // a REPAIR_PENDING card is never "due" through this function (it's due,
    // if at all, through isRepairTargetReached/findMandatoryRepairInterrupt).
    expect(isSpacedConfirmationDue({ relearningPhase: forgotten.relearningPhase, correctCooldownUntilPosition: null }, 999)).toBe(false);
  });

  it("2. SPACED_CONFIRMATION_PENDING: blocked for the full 5-card spacing window (N+1..N+5)", () => {
    const N = 100;
    const { card, gatePosition } = relearningRepairedAt(N);
    expect(card.relearningPhase).toBe("SPACED_CONFIRMATION_PENDING");

    const spacedCard = { relearningPhase: card.relearningPhase, correctCooldownUntilPosition: gatePosition };
    for (let p = N + 1; p <= N + 5; p += 1) {
      expect(isSpacedConfirmationDue(spacedCard, p)).toBe(false);
      // Still excluded from the ordinary stage-weighted channel throughout.
      expect(isGovernedByRepairObligation(card)).toBe(true);
    }
  });

  it("3. becomes eligible for the required Spaced Correct exactly at N+6, the earliest legal position", () => {
    const N = 100;
    const { card, gatePosition } = relearningRepairedAt(N);
    const spacedCard = { relearningPhase: card.relearningPhase, correctCooldownUntilPosition: gatePosition };

    expect(isSpacedConfirmationDue(spacedCard, N + 5)).toBe(false);
    expect(isSpacedConfirmationDue(spacedCard, N + 6)).toBe(true);
    expect(isSpacedConfirmationDue(spacedCard, N + 7)).toBe(true); // stays due afterward, not a one-shot window

    // Crucially: isGovernedByRepairObligation does NOT flip to false just
    // because the gate opened -- the card is still not an ORDINARY
    // stage-weighted candidate (no learningStage). It is a candidate via
    // this SEPARATE, newly-added channel instead -- proving the two
    // predicates answer different questions rather than contradicting.
    expect(isGovernedByRepairObligation(card)).toBe(true);
  });

  it("4. cannot remain permanently excluded: once due, applySpacedCorrect (Phase 2) actually completes relearning and the card leaves the governed state entirely", () => {
    const N = 100;
    const { card, gatePosition } = relearningRepairedAt(N);
    const spacedCard = { relearningPhase: card.relearningPhase, correctCooldownUntilPosition: gatePosition };

    expect(isSpacedConfirmationDue(spacedCard, N + 6)).toBe(true);

    // Phase 6 would present the card here and, on a Correct, call Phase
    // 2's applySpacedCorrect -- reused unchanged, not duplicated.
    const restored = applySpacedCorrect(card);
    expect(restored.cardStatus).toBe("ACQUIRED"); // never-before-mastered path
    expect(restored.relearningPhase).toBeNull();
    expect(restored.poolStatus).toBe("OUTSIDE");

    // The card is no longer governed by any repair/relearning obligation --
    // the exclusion was never permanent, it ended exactly when relearning
    // genuinely completed.
    expect(isGovernedByRepairObligation(restored)).toBe(false);
  });

  it("5. active_draws_since_eligible stays coherent: frozen for the ENTIRE relearning episode, including after the spaced-confirmation gate opens -- there is no 'unfreezing' moment before relearning actually completes, because a FORGOTTEN card was never a computeActiveWeight candidate in the first place", () => {
    const N = 100;
    const { card, gatePosition } = relearningRepairedAt(N);
    const spacedCard = { relearningPhase: card.relearningPhase, correctCooldownUntilPosition: gatePosition };

    // isGovernedByRepairObligation takes no position argument at all -- it
    // is position-independent by construction, so it stays true uniformly
    // across every position checked here, before AND after the gate opens
    // at N+6 -- even though isSpacedConfirmationDue (a different, position-
    // dependent question) flips from false to true at exactly that point.
    for (const p of [N + 1, N + 5, N + 6, N + 20]) {
      expect(isGovernedByRepairObligation(card)).toBe(true);
      expect(isSpacedConfirmationDue(spacedCard, p)).toBe(p >= N + 6);
    }

    let cards: ActiveDrawCounterCard[] = [
      { cardId: "relearning", activeDrawsSinceEligible: 11, eligible: !isGovernedByRepairObligation(card) },
      { cardId: "other", activeDrawsSinceEligible: 0, eligible: true },
    ];

    // Simulate draws straddling the gate (N+1 through N+7): "relearning"'s
    // counter must not move at any point, gate-opening included, since
    // feeding it into advanceActiveDrawCounters is still governed by
    // isGovernedByRepairObligation, not isSpacedConfirmationDue.
    for (let p = N + 1; p <= N + 7; p += 1) {
      const next = advanceActiveDrawCounters(cards, "other");
      cards = cards.map((c) => ({ ...c, activeDrawsSinceEligible: next.get(c.cardId)! }));
    }

    expect(cards.find((c) => c.cardId === "relearning")?.activeDrawsSinceEligible).toBe(11); // untouched throughout
  });
});
