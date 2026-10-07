import { describe, expect, it, vi } from "vitest";
import { createEmptyCard, Rating } from "ts-fsrs";

vi.mock("server-only", () => ({}));

const { prepareLearningEngineAnswer } = await import("@/lib/learning-engine/runtime/prepare-answer");
const { applyFirstPresentation, applyLongTermWrong, applyNormalCorrect, applyRelearningRepairCorrect, applyWrong } = await import(
  "@/lib/learning-engine/transitions"
);
const { INITIAL_CARD_STATE } = await import("@/lib/learning-engine/state");
import type { LearningEngineCardState } from "@/lib/learning-engine/state";

/**
 * Unit tests for the RC-C pure answer-preparation function
 * prepareLearningEngineAnswer (lib/learning-engine/runtime/prepare-answer.ts).
 * Covers the RC-C brief's minimum transition matrix (sections 8/37/38).
 * FSRS/repair/mastery arithmetic itself is already exhaustively tested at
 * the Phase 2/4/5 layer this module composes -- these tests assert that
 * COMPOSITION is correct (the right pure function is reached for the right
 * selectionReason/cardStatus combination), not re-derive that arithmetic.
 */

const NOW = new Date("2026-01-01T00:00:00.000Z");
const CARD_ID = "card-1";

function scriptedRandom(values: readonly number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

const FRESH: LearningEngineCardState = applyFirstPresentation(INITIAL_CARD_STATE);
const EMPTY_FSRS_CARD = createEmptyCard(NOW);

function acquired(overrides: Partial<LearningEngineCardState> = {}): LearningEngineCardState {
  return { ...INITIAL_CARD_STATE, cardStatus: "ACQUIRED", poolStatus: "OUTSIDE", ...overrides };
}

function learned(overrides: Partial<LearningEngineCardState> = {}): LearningEngineCardState {
  return { ...INITIAL_CARD_STATE, cardStatus: "LEARNED", poolStatus: "OUTSIDE", hasEverBeenMastered: true, ...overrides };
}

/** ts-fsrs's own createEmptyCard already provides a valid Card for an OUTSIDE-pool FSRS path -- ts-fsrs's `next()` handles a never-reviewed (State.New) card correctly, same as every other FSRS-lifecycle unit test file's fixture convention. */
function reviewedFsrsCard() {
  return EMPTY_FSRS_CARD;
}

const BASE_INPUT = {
  cardId: CARD_ID,
  desiredRetention: 0.9,
  newSchedulerPosition: 10,
  responseTimeMs: 1000,
  comboBefore: 0,
  enemyHpBefore: 100,
  now: NOW,
};

describe("prepareLearningEngineAnswer -- ordinary within-day Active (sections 9-12)", () => {
  it("NEW Correct -> first presentation then normal Correct (FRESH -> LEARNING_1)", () => {
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: INITIAL_CARD_STATE,
      fsrsCard: EMPTY_FSRS_CARD,
      selectionReason: "active_first_pass",
      correct: true,
      random: scriptedRandom([0.5]),
    });
    expect(result.cardStateAfter.cardStatus).toBe("LEARNING");
    expect(result.cardStateAfter.learningStage).toBe("LEARNING_1");
    // Position-semantics fix: gate arithmetic uses presentationPosition
    // (newSchedulerPosition - 1 = 9, the claim's own PRE-answer position,
    // i.e. the position this card was actually presented/claimed at) --
    // never newSchedulerPosition (10, the POST-answer committed position)
    // directly. 9 + 5 + 1 = 15, matching the canonical "Correct at
    // presentation position N -> N+1..N+5 blocked -> N+6 eligible" rule
    // with N=9.
    expect(result.correctCooldownUntilPositionAfter).toBe(9 + 5 + 1);
    expect(result.repairObligationAfter).toBeNull();
    expect(result.fsrsUpdate).toBeNull();
    expect(result.battle.enemyHpAfter).toBeLessThanOrEqual(100);
  });

  it("NEW Wrong -> first presentation then Wrong, creates a repair obligation", () => {
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: INITIAL_CARD_STATE,
      fsrsCard: EMPTY_FSRS_CARD,
      selectionReason: "active_first_pass",
      correct: false,
      random: scriptedRandom([0]),
    });
    expect(result.cardStateAfter.cardStatus).toBe("LEARNING");
    expect(result.cardStateAfter.learningStage).toBe("FRESH");
    expect(result.cardStateAfter.repairPending).toBe(true);
    expect(result.repairObligationAfter).not.toBeNull();
    // Position-semantics fix: wrongPosition is the claim's own PRE-answer
    // presentation position (presentationPosition = newSchedulerPosition
    // - 1 = 9), not newSchedulerPosition (10) itself -- see this file's
    // other updated assertion above for the full rationale.
    expect(result.repairObligationAfter!.wrongPosition).toBe(9);
    expect(result.correctCooldownUntilPositionAfter).toBeNull();
    expect(result.battle.damage).toBe(0);
  });

  it("FRESH Correct -> LEARNING_1 / FRESH Wrong -> stays FRESH with obligation", () => {
    const correctResult = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: FRESH,
      fsrsCard: EMPTY_FSRS_CARD,
      selectionReason: "active_weighted_selection",
      correct: true,
      random: scriptedRandom([0.5]),
    });
    expect(correctResult.cardStateAfter.learningStage).toBe("LEARNING_1");

    const wrongResult = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: FRESH,
      fsrsCard: EMPTY_FSRS_CARD,
      selectionReason: "active_weighted_selection",
      correct: false,
      random: scriptedRandom([0]),
    });
    expect(wrongResult.cardStateAfter.learningStage).toBe("FRESH");
    expect(wrongResult.cardStateAfter.repairPending).toBe(true);
  });

  it("L1 Correct -> L2 / L1 Wrong -> stays L1 with obligation", () => {
    const l1 = applyNormalCorrect(FRESH);
    const correctResult = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: l1,
      fsrsCard: EMPTY_FSRS_CARD,
      selectionReason: "active_weighted_selection",
      correct: true,
      random: scriptedRandom([0.5]),
    });
    expect(correctResult.cardStateAfter.learningStage).toBe("LEARNING_2");

    const wrongResult = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: l1,
      fsrsCard: EMPTY_FSRS_CARD,
      selectionReason: "active_weighted_selection",
      correct: false,
      random: scriptedRandom([0]),
    });
    expect(wrongResult.cardStateAfter.learningStage).toBe("LEARNING_1");
    expect(wrongResult.cardStateAfter.repairPending).toBe(true);
  });

  it("L2 Correct -> ACQUIRED, no Mastery XP milestone (LEARNING_2 -> ACQUIRED grants no milestone XP, section 19)", () => {
    const l1 = applyNormalCorrect(FRESH);
    const l2 = applyNormalCorrect(l1);
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: l2,
      fsrsCard: EMPTY_FSRS_CARD,
      selectionReason: "active_weighted_selection",
      correct: true,
      random: scriptedRandom([0.5]),
    });
    expect(result.cardStateAfter.cardStatus).toBe("ACQUIRED");
    expect(result.cardStateAfter.poolStatus).toBe("OUTSIDE");
    expect(result.masteryXp).toBeNull();
    expect(result.cardMasteredJustNow).toBe(false);
  });

  it("throws if an ordinary Active selectionReason is given a repair-pending card", () => {
    const wronged = applyWrong(FRESH);
    expect(() =>
      prepareLearningEngineAnswer({
        ...BASE_INPUT,
        cardState: wronged,
        fsrsCard: EMPTY_FSRS_CARD,
        selectionReason: "active_weighted_selection",
        correct: true,
        random: scriptedRandom([0.5]),
      }),
    ).toThrow(/requires repairPending === false/);
  });
});

describe("prepareLearningEngineAnswer -- repair retry (sections 12.2/12.5)", () => {
  it("ordinary Repair Correct: LEARNING_1 stays LEARNING_1, obligation cleared, cooldown set", () => {
    const l1 = applyNormalCorrect(FRESH);
    const wronged = applyWrong(l1);
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: wronged,
      fsrsCard: EMPTY_FSRS_CARD,
      selectionReason: "repair_target",
      correct: true,
      random: scriptedRandom([0.5]),
    });
    expect(result.cardStateAfter.learningStage).toBe("LEARNING_1");
    expect(result.cardStateAfter.repairPending).toBe(false);
    expect(result.repairObligationAfter).toBeNull();
    // Position-semantics fix -- see the "NEW Correct" test above.
    expect(result.correctCooldownUntilPositionAfter).toBe(9 + 5 + 1);
  });

  it("ordinary Repair Wrong: stage unchanged, old obligation replaced by a fresh one anchored at the new position", () => {
    const l1 = applyNormalCorrect(FRESH);
    const wronged = applyWrong(l1);
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: wronged,
      fsrsCard: EMPTY_FSRS_CARD,
      selectionReason: "repair_hard_cap",
      correct: false,
      random: scriptedRandom([0]),
    });
    expect(result.cardStateAfter.learningStage).toBe("LEARNING_1");
    expect(result.cardStateAfter.repairPending).toBe(true);
    expect(result.repairObligationAfter).not.toBeNull();
    // Position-semantics fix -- see the "NEW Wrong" test above.
    expect(result.repairObligationAfter!.wrongPosition).toBe(9);
    expect(result.correctCooldownUntilPositionAfter).toBeNull();
  });
});

describe("prepareLearningEngineAnswer -- long-term FSRS (sections 15-18)", () => {
  it("ACQUIRED Due Correct: qualifying FSRS Correct increments mastery counters", () => {
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: acquired({ fsrsReviewCorrectCount: 1, fsrsReviewCorrectStreak: 1 }),
      fsrsCard: reviewedFsrsCard(),
      selectionReason: "due_weighted_selection",
      correct: true,
      random: scriptedRandom([0.5]),
    });
    expect(result.cardStateAfter.fsrsReviewCorrectCount).toBe(2);
    expect(result.cardStateAfter.fsrsReviewCorrectStreak).toBe(2);
    expect(result.fsrsUpdate).not.toBeNull();
    expect(result.fsrsGrade).toBe(Rating.Good);
  });

  it("first Mastery transition: count 2->3, streak 1->2 crosses both thresholds -> LEARNED, cardMasteredJustNow true, masteryXp card_learned", () => {
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: acquired({ fsrsReviewCorrectCount: 2, fsrsReviewCorrectStreak: 1 }),
      fsrsCard: reviewedFsrsCard(),
      selectionReason: "due_weighted_selection",
      correct: true,
      random: scriptedRandom([0.5]),
    });
    expect(result.cardStateAfter.cardStatus).toBe("LEARNED");
    expect(result.cardStateAfter.hasEverBeenMastered).toBe(true);
    expect(result.cardMasteredJustNow).toBe(true);
    expect(result.masteryXp).toEqual({ amount: 15, reason: "card_learned" });
  });

  it("ACQUIRED Due Wrong -> LEARNED Wrong both lapse to FORGOTTEN with a fresh repair obligation and FSRS Again", () => {
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: acquired({ fsrsReviewCorrectCount: 2, fsrsReviewCorrectStreak: 2 }),
      fsrsCard: reviewedFsrsCard(),
      selectionReason: "due_weighted_selection",
      correct: false,
      random: scriptedRandom([0]),
    });
    expect(result.cardStateAfter.cardStatus).toBe("FORGOTTEN");
    expect(result.cardStateAfter.relearningPhase).toBe("REPAIR_PENDING");
    expect(result.cardStateAfter.repairPending).toBe(true);
    expect(result.cardStateAfter.fsrsReviewCorrectStreak).toBe(0);
    expect(result.cardStateAfter.fsrsReviewCorrectCount).toBe(2);
    expect(result.repairObligationAfter).not.toBeNull();
    expect(result.fsrsGrade).toBe(Rating.Again);
  });

  it("LEARNED Wrong -> FORGOTTEN, hasEverBeenMastered preserved", () => {
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: learned({ fsrsReviewCorrectCount: 5, fsrsReviewCorrectStreak: 3 }),
      fsrsCard: reviewedFsrsCard(),
      selectionReason: "due_weighted_selection",
      correct: false,
      random: scriptedRandom([0]),
    });
    expect(result.cardStateAfter.cardStatus).toBe("FORGOTTEN");
    expect(result.cardStateAfter.hasEverBeenMastered).toBe(true);
  });

  it("Near-Due Correct does not increment mastery counters or promote ACQUIRED -> LEARNED", () => {
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: acquired({ fsrsReviewCorrectCount: 2, fsrsReviewCorrectStreak: 1 }),
      fsrsCard: reviewedFsrsCard(),
      selectionReason: "near_due_weighted_selection",
      correct: true,
      random: scriptedRandom([0.5]),
    });
    expect(result.cardStateAfter.cardStatus).toBe("ACQUIRED");
    expect(result.cardStateAfter.fsrsReviewCorrectCount).toBe(2);
    expect(result.cardStateAfter.fsrsReviewCorrectStreak).toBe(1);
    expect(result.masteryXp).toBeNull();
  });

  it("Critical Due marker: shouldUpdateLastCriticalDuePosition is true regardless of correctness", () => {
    const correctResult = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: acquired(),
      fsrsCard: reviewedFsrsCard(),
      selectionReason: "critical_due_interrupt",
      correct: true,
      random: scriptedRandom([0.5]),
    });
    expect(correctResult.shouldUpdateLastCriticalDuePosition).toBe(true);

    const wrongResult = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: acquired(),
      fsrsCard: reviewedFsrsCard(),
      selectionReason: "critical_due_interrupt",
      correct: false,
      random: scriptedRandom([0]),
    });
    expect(wrongResult.shouldUpdateLastCriticalDuePosition).toBe(true);
  });

  it("every non-critical-due reason reports shouldUpdateLastCriticalDuePosition false", () => {
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: acquired(),
      fsrsCard: reviewedFsrsCard(),
      selectionReason: "due_weighted_selection",
      correct: true,
      random: scriptedRandom([0.5]),
    });
    expect(result.shouldUpdateLastCriticalDuePosition).toBe(false);
  });

  it("RANDOM_MASTERED Correct: FSRS updates, mastery counters unchanged, stays LEARNED", () => {
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: learned({ fsrsReviewCorrectCount: 5, fsrsReviewCorrectStreak: 3 }),
      fsrsCard: reviewedFsrsCard(),
      selectionReason: "random_mastered_shuffle_bag",
      correct: true,
      random: scriptedRandom([0.5]),
    });
    expect(result.cardStateAfter.cardStatus).toBe("LEARNED");
    expect(result.cardStateAfter.fsrsReviewCorrectCount).toBe(5);
    expect(result.cardStateAfter.fsrsReviewCorrectStreak).toBe(3);
    expect(result.fsrsUpdate).not.toBeNull();
    expect(result.masteryXp).toBeNull();
  });

  it("RANDOM_MASTERED Wrong: full long-term lapse, never a lighter free-play rule", () => {
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: learned({ fsrsReviewCorrectCount: 5, fsrsReviewCorrectStreak: 3 }),
      fsrsCard: reviewedFsrsCard(),
      selectionReason: "random_mastered_shuffle_bag",
      correct: false,
      random: scriptedRandom([0]),
    });
    expect(result.cardStateAfter.cardStatus).toBe("FORGOTTEN");
    expect(result.cardStateAfter.relearningPhase).toBe("REPAIR_PENDING");
    expect(result.cardStateAfter.fsrsReviewCorrectStreak).toBe(0);
    expect(result.cardStateAfter.fsrsReviewCorrectCount).toBe(5);
    expect(result.repairObligationAfter).not.toBeNull();
  });
});

describe("prepareLearningEngineAnswer -- relearning restoration (sections 13/25.2)", () => {
  function forgottenWithRepairPending(baseAcquired: LearningEngineCardState): LearningEngineCardState {
    return { ...applyLongTermWrong(baseAcquired), repairPending: true };
  }

  it("FORGOTTEN Repair Correct -> SPACED_CONFIRMATION_PENDING", () => {
    const forgotten = forgottenWithRepairPending(acquired());
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: forgotten,
      fsrsCard: reviewedFsrsCard(),
      selectionReason: "repair_target",
      correct: true,
      random: scriptedRandom([0.5]),
    });
    expect(result.cardStateAfter.cardStatus).toBe("FORGOTTEN");
    expect(result.cardStateAfter.relearningPhase).toBe("SPACED_CONFIRMATION_PENDING");
    expect(result.cardStateAfter.repairPending).toBe(false);
    expect(result.repairObligationAfter).toBeNull();
  });

  it("never-mastered restoration: Spaced Confirmation Correct -> ACQUIRED", () => {
    const forgotten = forgottenWithRepairPending(acquired());
    const repaired = { ...applyRelearningRepairCorrect(forgotten), repairPending: false };
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: repaired,
      fsrsCard: reviewedFsrsCard(),
      selectionReason: "spaced_confirmation",
      correct: true,
      random: scriptedRandom([0.5]),
    });
    expect(result.cardStateAfter.cardStatus).toBe("ACQUIRED");
    expect(result.cardStateAfter.poolStatus).toBe("OUTSIDE");
  });

  it("previously-mastered restoration: Spaced Confirmation Correct -> LEARNED (MASTERED RESTORED)", () => {
    const forgotten = forgottenWithRepairPending(learned());
    const repaired = { ...applyRelearningRepairCorrect(forgotten), repairPending: false };
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: repaired,
      fsrsCard: reviewedFsrsCard(),
      selectionReason: "spaced_confirmation",
      correct: true,
      random: scriptedRandom([0.5]),
    });
    expect(result.cardStateAfter.cardStatus).toBe("LEARNED");
    expect(result.cardStateAfter.hasEverBeenMastered).toBe(true);
    // Restoration is NOT the Phase 9 Card-Mastered toast's scope (ACQUIRED -> LEARNED only) --
    // it IS a Mastery XP milestone, under the distinct "card_relearned" reason.
    expect(result.cardMasteredJustNow).toBe(false);
    expect(result.masteryXp).toEqual({ amount: 15, reason: "card_relearned" });
  });

  it("FORGOTTEN Spaced Confirmation Wrong falls back to REPAIR_PENDING with a fresh obligation", () => {
    const forgotten = forgottenWithRepairPending(acquired());
    const repaired = { ...applyRelearningRepairCorrect(forgotten), repairPending: false };
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: repaired,
      fsrsCard: reviewedFsrsCard(),
      selectionReason: "spaced_confirmation",
      correct: false,
      random: scriptedRandom([0]),
    });
    expect(result.cardStateAfter.relearningPhase).toBe("REPAIR_PENDING");
    expect(result.cardStateAfter.repairPending).toBe(true);
    expect(result.repairObligationAfter).not.toBeNull();
  });
});

describe("prepareLearningEngineAnswer -- Battle integration (section 24)", () => {
  it("Battle result is computed identically to calculateBattleResult(), independent of memory-state outcome", () => {
    const result = prepareLearningEngineAnswer({
      ...BASE_INPUT,
      cardState: FRESH,
      fsrsCard: EMPTY_FSRS_CARD,
      selectionReason: "active_weighted_selection",
      correct: true,
      comboBefore: 3,
      enemyHpBefore: 50,
      random: scriptedRandom([0.1, 0.9, 0.5]),
    });
    expect(result.battle.comboAfter).toBe(4);
  });
});
