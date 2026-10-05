import { describe, expect, it } from "vitest";

import { INITIAL_CARD_STATE, type LearningEngineCardState } from "@/lib/learning-engine/state";
import {
  applyFirstPresentation,
  applyLongTermWrong,
  applyNormalCorrect,
  applyQualifyingFsrsCorrect,
  applyRelearningRepairCorrect,
  applyRelearningRepairRetryWrong,
  applyRepairCorrect,
  applyRepairRetryWrong,
  applySpacedConfirmationWrong,
  applySpacedCorrect,
  applyWrong,
} from "@/lib/learning-engine/transitions";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md's Phase 2
 * pure transition functions. Organized in two parts:
 *  - one describe block per function: happy path(s) + every documented
 *    precondition throws when violated;
 *  - a final "spec acceptance scenarios" block composing these functions
 *    into the exact sequences section 38's acceptance tests describe,
 *    for every test in that list whose outcome is fully determined by
 *    Phase 2 state transitions alone (position/gap/RNG enforcement --
 *    Phase 3/4/6 -- is assumed already satisfied by the caller in these
 *    sequences, exactly as every function's own doc comment states).
 */

// A LEARNING/FRESH card, as if freshly presented for the first time.
const FRESH: LearningEngineCardState = applyFirstPresentation(INITIAL_CARD_STATE);

function acquired(overrides: Partial<LearningEngineCardState> = {}): LearningEngineCardState {
  return {
    ...INITIAL_CARD_STATE,
    cardStatus: "ACQUIRED",
    poolStatus: "OUTSIDE",
    ...overrides,
  };
}

function learned(overrides: Partial<LearningEngineCardState> = {}): LearningEngineCardState {
  return {
    ...INITIAL_CARD_STATE,
    cardStatus: "LEARNED",
    poolStatus: "OUTSIDE",
    hasEverBeenMastered: true,
    ...overrides,
  };
}

describe("applyFirstPresentation (section 3)", () => {
  it("NEW -> LEARNING/FRESH", () => {
    const next = applyFirstPresentation(INITIAL_CARD_STATE);
    expect(next.cardStatus).toBe("LEARNING");
    expect(next.learningStage).toBe("FRESH");
  });

  it("does not touch poolStatus (Active Pool admission is a separate concern, section 3: 'a card may already be placed in ACTIVE while still NEW')", () => {
    const next = applyFirstPresentation({ ...INITIAL_CARD_STATE, poolStatus: "ACTIVE" });
    expect(next.poolStatus).toBe("ACTIVE");
  });

  it("throws if cardStatus is not NEW", () => {
    expect(() => applyFirstPresentation(FRESH)).toThrow(/requires cardStatus NEW/);
  });
});

describe("applyNormalCorrect (sections 10, 11.2)", () => {
  it("FRESH -> LEARNING_1", () => {
    const next = applyNormalCorrect(FRESH);
    expect(next.cardStatus).toBe("LEARNING");
    expect(next.learningStage).toBe("LEARNING_1");
  });

  it("LEARNING_1 -> LEARNING_2", () => {
    const l1 = applyNormalCorrect(FRESH);
    const next = applyNormalCorrect(l1);
    expect(next.learningStage).toBe("LEARNING_2");
    expect(next.cardStatus).toBe("LEARNING");
  });

  it("LEARNING_2 -> ACQUIRED, learningStage null, poolStatus OUTSIDE ('acquisition graduation', section 11.2)", () => {
    const l1 = applyNormalCorrect(FRESH);
    const l2 = applyNormalCorrect(l1);
    const next = applyNormalCorrect(l2);
    expect(next.cardStatus).toBe("ACQUIRED");
    expect(next.learningStage).toBeNull();
    expect(next.poolStatus).toBe("OUTSIDE");
  });

  it("throws if cardStatus is not LEARNING", () => {
    expect(() => applyNormalCorrect(INITIAL_CARD_STATE)).toThrow(/requires cardStatus LEARNING/);
  });

  it("throws if repairPending is true (this is the non-repair path; see applyRepairCorrect)", () => {
    const withPendingRepair = { ...FRESH, repairPending: true };
    expect(() => applyNormalCorrect(withPendingRepair)).toThrow(/requires repairPending === false/);
  });
});

describe("applyWrong (section 12.1-12.2)", () => {
  it("sets repairPending true without changing cardStatus/learningStage", () => {
    const next = applyWrong(FRESH);
    expect(next.repairPending).toBe(true);
    expect(next.cardStatus).toBe("LEARNING");
    expect(next.learningStage).toBe("FRESH");
  });

  it("throws if cardStatus is not LEARNING", () => {
    expect(() => applyWrong(INITIAL_CARD_STATE)).toThrow(/requires cardStatus LEARNING/);
  });

  it("throws if repairPending is already true", () => {
    const alreadyPending = { ...FRESH, repairPending: true };
    expect(() => applyWrong(alreadyPending)).toThrow(/requires repairPending === false/);
  });
});

describe("applyRepairCorrect (section 12.3-12.4)", () => {
  it("FRESH exception: FRESH + repair correct -> LEARNING_1 (section 12.4)", () => {
    const wronged = applyWrong(FRESH);
    const next = applyRepairCorrect(wronged);
    expect(next.learningStage).toBe("LEARNING_1");
    expect(next.repairPending).toBe(false);
    expect(next.cardStatus).toBe("LEARNING");
  });

  it("LEARNING_1 + repair correct -> stage unchanged (section 12.3: repair does not advance stage)", () => {
    const l1 = applyNormalCorrect(FRESH);
    const wronged = applyWrong(l1);
    const next = applyRepairCorrect(wronged);
    expect(next.learningStage).toBe("LEARNING_1");
    expect(next.repairPending).toBe(false);
  });

  it("LEARNING_2 + repair correct -> stage unchanged, never reaches ACQUIRED via repair", () => {
    const l1 = applyNormalCorrect(FRESH);
    const l2 = applyNormalCorrect(l1);
    const wronged = applyWrong(l2);
    const next = applyRepairCorrect(wronged);
    expect(next.learningStage).toBe("LEARNING_2");
    expect(next.cardStatus).toBe("LEARNING");
  });

  it("throws if repairPending is false", () => {
    expect(() => applyRepairCorrect(FRESH)).toThrow(/requires repairPending === true/);
  });

  it("throws if cardStatus is not LEARNING", () => {
    expect(() => applyRepairCorrect({ ...INITIAL_CARD_STATE, repairPending: true })).toThrow(/requires cardStatus LEARNING/);
  });
});

describe("applyRepairRetryWrong (RC-C spec-gap correction, section 12.2)", () => {
  it("FRESH + repair-retry Wrong -> stage unchanged (FRESH), still repairPending", () => {
    const wronged = applyWrong(FRESH);
    const next = applyRepairRetryWrong(wronged);
    expect(next.learningStage).toBe("FRESH");
    expect(next.cardStatus).toBe("LEARNING");
    expect(next.repairPending).toBe(true);
  });

  it("LEARNING_1 + repair-retry Wrong -> stage unchanged (LEARNING_1)", () => {
    const l1 = applyNormalCorrect(FRESH);
    const wronged = applyWrong(l1);
    const next = applyRepairRetryWrong(wronged);
    expect(next.learningStage).toBe("LEARNING_1");
    expect(next.repairPending).toBe(true);
  });

  it("LEARNING_2 + repair-retry Wrong -> stage unchanged (LEARNING_2)", () => {
    const l1 = applyNormalCorrect(FRESH);
    const l2 = applyNormalCorrect(l1);
    const wronged = applyWrong(l2);
    const next = applyRepairRetryWrong(wronged);
    expect(next.learningStage).toBe("LEARNING_2");
    expect(next.repairPending).toBe(true);
  });

  it("throws if repairPending is false (the non-pending Wrong path must call applyWrong instead)", () => {
    expect(() => applyRepairRetryWrong(FRESH)).toThrow(/requires repairPending === true/);
  });

  it("throws if cardStatus is not LEARNING", () => {
    expect(() => applyRepairRetryWrong({ ...INITIAL_CARD_STATE, repairPending: true })).toThrow(/requires cardStatus LEARNING/);
  });

  it("does not touch mastery counters", () => {
    const wronged = applyWrong({ ...FRESH, fsrsReviewCorrectCount: 3, fsrsReviewCorrectStreak: 2 });
    const next = applyRepairRetryWrong(wronged);
    expect(next.fsrsReviewCorrectCount).toBe(3);
    expect(next.fsrsReviewCorrectStreak).toBe(2);
  });
});

describe("applyLongTermWrong (sections 16.3, 34.3)", () => {
  it("ACQUIRED/OUTSIDE Wrong -> FORGOTTEN, pool ACTIVE, REPAIR_PENDING, streak reset, count preserved", () => {
    const before = acquired({ fsrsReviewCorrectCount: 2, fsrsReviewCorrectStreak: 2 });
    const next = applyLongTermWrong(before);
    expect(next.cardStatus).toBe("FORGOTTEN");
    expect(next.poolStatus).toBe("ACTIVE");
    expect(next.relearningPhase).toBe("REPAIR_PENDING");
    expect(next.fsrsReviewCorrectStreak).toBe(0);
    expect(next.fsrsReviewCorrectCount).toBe(2);
  });

  it("LEARNED/OUTSIDE Wrong (a lapse) -> FORGOTTEN, hasEverBeenMastered stays true", () => {
    const before = learned({ fsrsReviewCorrectCount: 5, fsrsReviewCorrectStreak: 3 });
    const next = applyLongTermWrong(before);
    expect(next.cardStatus).toBe("FORGOTTEN");
    expect(next.hasEverBeenMastered).toBe(true);
    expect(next.fsrsReviewCorrectCount).toBe(5);
    expect(next.fsrsReviewCorrectStreak).toBe(0);
  });

  it("throws if poolStatus is not OUTSIDE", () => {
    expect(() => applyLongTermWrong(acquired({ poolStatus: "ACTIVE" }))).toThrow(/requires poolStatus OUTSIDE/);
  });

  it("throws if cardStatus is not ACQUIRED or LEARNED", () => {
    expect(() => applyLongTermWrong(FRESH)).toThrow(/requires cardStatus ACQUIRED or LEARNED/);
  });
});

describe("applyRelearningRepairCorrect (section 13)", () => {
  it("REPAIR_PENDING -> SPACED_CONFIRMATION_PENDING, cardStatus stays FORGOTTEN", () => {
    const forgotten = applyLongTermWrong(acquired());
    const next = applyRelearningRepairCorrect(forgotten);
    expect(next.relearningPhase).toBe("SPACED_CONFIRMATION_PENDING");
    expect(next.cardStatus).toBe("FORGOTTEN");
  });

  it("throws if relearningPhase is not REPAIR_PENDING", () => {
    expect(() => applyRelearningRepairCorrect({ ...INITIAL_CARD_STATE, cardStatus: "FORGOTTEN" })).toThrow(
      /requires relearningPhase REPAIR_PENDING/,
    );
  });

  it("throws if cardStatus is not FORGOTTEN", () => {
    expect(() => applyRelearningRepairCorrect(acquired())).toThrow(/requires cardStatus FORGOTTEN/);
  });
});

describe("applyRelearningRepairRetryWrong (RC-C spec-gap correction, section 13)", () => {
  it("FORGOTTEN + REPAIR_PENDING + Wrong -> remains FORGOTTEN, remains REPAIR_PENDING (never advances to SPACED_CONFIRMATION_PENDING)", () => {
    const forgotten = applyLongTermWrong(acquired());
    const repairPending: LearningEngineCardState = { ...forgotten, repairPending: true };
    const next = applyRelearningRepairRetryWrong(repairPending);
    expect(next.cardStatus).toBe("FORGOTTEN");
    expect(next.relearningPhase).toBe("REPAIR_PENDING");
  });

  it("preserves hasEverBeenMastered", () => {
    const forgotten = applyLongTermWrong(learned());
    const repairPending: LearningEngineCardState = { ...forgotten, repairPending: true };
    const next = applyRelearningRepairRetryWrong(repairPending);
    expect(next.hasEverBeenMastered).toBe(true);
  });

  it("throws if relearningPhase is not REPAIR_PENDING", () => {
    expect(() =>
      applyRelearningRepairRetryWrong({ ...INITIAL_CARD_STATE, cardStatus: "FORGOTTEN", relearningPhase: "SPACED_CONFIRMATION_PENDING" }),
    ).toThrow(/requires relearningPhase REPAIR_PENDING/);
  });

  it("throws if repairPending is false", () => {
    const forgotten = applyLongTermWrong(acquired());
    expect(() => applyRelearningRepairRetryWrong(forgotten)).toThrow(/requires repairPending === true/);
  });

  it("throws if cardStatus is not FORGOTTEN", () => {
    expect(() => applyRelearningRepairRetryWrong(acquired())).toThrow(/requires cardStatus FORGOTTEN/);
  });
});

/**
 * A valid FORGOTTEN + SPACED_CONFIRMATION_PENDING fixture -- repairPending
 * false, per the snapshot-mapper's own universal invariant (the triggering
 * obligation has already been cleared). Built directly rather than via
 * applyRelearningRepairCorrect, which alone does not clear repairPending --
 * that merge is resolveRelearningRepairCorrect's `clearedRepairFields`
 * composition's job (see repair-scheduler.ts), not this function's.
 */
function spacedConfirmationPending(overrides: Partial<LearningEngineCardState> = {}): LearningEngineCardState {
  return {
    ...applyLongTermWrong(acquired()),
    relearningPhase: "SPACED_CONFIRMATION_PENDING",
    repairPending: false,
    ...overrides,
  };
}

describe("applySpacedConfirmationWrong (RC-C spec-gap correction, section 13)", () => {
  it("FORGOTTEN + SPACED_CONFIRMATION_PENDING + Wrong -> falls back to REPAIR_PENDING, stays FORGOTTEN", () => {
    const next = applySpacedConfirmationWrong(spacedConfirmationPending());
    expect(next.cardStatus).toBe("FORGOTTEN");
    expect(next.relearningPhase).toBe("REPAIR_PENDING");
  });

  it("does NOT itself set repairPending (left to the caller that creates the fresh obligation -- see repair-scheduler.ts's resolveSpacedConfirmationWrong)", () => {
    const next = applySpacedConfirmationWrong(spacedConfirmationPending());
    expect(next.repairPending).toBe(false);
  });

  it("preserves hasEverBeenMastered", () => {
    const next = applySpacedConfirmationWrong(spacedConfirmationPending({ hasEverBeenMastered: true }));
    expect(next.hasEverBeenMastered).toBe(true);
  });

  it("throws if relearningPhase is not SPACED_CONFIRMATION_PENDING", () => {
    const repairPending = applyLongTermWrong(acquired());
    expect(() => applySpacedConfirmationWrong(repairPending)).toThrow(/requires relearningPhase SPACED_CONFIRMATION_PENDING/);
  });

  it("throws if repairPending is true (SPACED_CONFIRMATION_PENDING always implies the triggering obligation was already cleared)", () => {
    expect(() => applySpacedConfirmationWrong(spacedConfirmationPending({ repairPending: true }))).toThrow(/requires repairPending === false/);
  });

  it("throws if cardStatus is not FORGOTTEN", () => {
    expect(() => applySpacedConfirmationWrong(acquired())).toThrow(/requires cardStatus FORGOTTEN/);
  });
});

describe("applySpacedCorrect (sections 13, 25.2)", () => {
  it("never-before-mastered card: relearning complete -> ACQUIRED (must re-earn Mastery)", () => {
    const forgotten = applyLongTermWrong(acquired());
    const repaired = applyRelearningRepairCorrect(forgotten);
    const next = applySpacedCorrect(repaired);
    expect(next.cardStatus).toBe("ACQUIRED");
    expect(next.poolStatus).toBe("OUTSIDE");
    expect(next.relearningPhase).toBeNull();
    expect(next.hasEverBeenMastered).toBe(false);
  });

  it("previously-mastered card: relearning complete -> LEARNED (MASTERED RESTORED, short restoration)", () => {
    const forgotten = applyLongTermWrong(learned());
    const repaired = applyRelearningRepairCorrect(forgotten);
    const next = applySpacedCorrect(repaired);
    expect(next.cardStatus).toBe("LEARNED");
    expect(next.poolStatus).toBe("OUTSIDE");
    expect(next.relearningPhase).toBeNull();
  });

  it("does not touch fsrs_review_correct_count/streak (section 15: repair/spaced Corrects are not mastery-counter evidence)", () => {
    const forgotten = applyLongTermWrong(acquired({ fsrsReviewCorrectCount: 2, fsrsReviewCorrectStreak: 2 }));
    const repaired = applyRelearningRepairCorrect(forgotten);
    const next = applySpacedCorrect(repaired);
    expect(next.fsrsReviewCorrectCount).toBe(2);
    expect(next.fsrsReviewCorrectStreak).toBe(0);
  });

  it("throws if relearningPhase is not SPACED_CONFIRMATION_PENDING", () => {
    const forgotten = applyLongTermWrong(acquired());
    expect(() => applySpacedCorrect(forgotten)).toThrow(/requires relearningPhase SPACED_CONFIRMATION_PENDING/);
  });

  it("throws if cardStatus is not FORGOTTEN", () => {
    expect(() => applySpacedCorrect(acquired())).toThrow(/requires cardStatus FORGOTTEN/);
  });
});

describe("applyQualifyingFsrsCorrect (section 15)", () => {
  it("increments count and streak without reaching Mastery below threshold", () => {
    const next = applyQualifyingFsrsCorrect(acquired());
    expect(next.fsrsReviewCorrectCount).toBe(1);
    expect(next.fsrsReviewCorrectStreak).toBe(1);
    expect(next.cardStatus).toBe("ACQUIRED");
    expect(next.hasEverBeenMastered).toBe(false);
  });

  it("an already-LEARNED card keeps accumulating cumulative evidence (never capped)", () => {
    const next = applyQualifyingFsrsCorrect(learned({ fsrsReviewCorrectCount: 10, fsrsReviewCorrectStreak: 5 }));
    expect(next.cardStatus).toBe("LEARNED");
    expect(next.fsrsReviewCorrectCount).toBe(11);
    expect(next.fsrsReviewCorrectStreak).toBe(6);
  });

  it("throws if poolStatus is not OUTSIDE", () => {
    expect(() => applyQualifyingFsrsCorrect(acquired({ poolStatus: "ACTIVE" }))).toThrow(/requires poolStatus OUTSIDE/);
  });

  it("throws if cardStatus is not ACQUIRED or LEARNED", () => {
    expect(() => applyQualifyingFsrsCorrect(FRESH)).toThrow(/requires cardStatus ACQUIRED or LEARNED/);
  });

  // Section 38, Test 13 -- exact threshold combinations, reached via one
  // qualifying Correct from an explicit prior count/streak (never
  // constructed directly at the post-increment value, since the function
  // always increments by exactly 1).
  describe("Test 13 -- First-time Mastery threshold combinations", () => {
    it("count=3, streak=1 -> not Mastered (streak requirement not met)", () => {
      const next = applyQualifyingFsrsCorrect(acquired({ fsrsReviewCorrectCount: 2, fsrsReviewCorrectStreak: 0 }));
      expect(next.fsrsReviewCorrectCount).toBe(3);
      expect(next.fsrsReviewCorrectStreak).toBe(1);
      expect(next.cardStatus).toBe("ACQUIRED");
    });

    it("count=2, streak=2 -> not Mastered (count requirement not met)", () => {
      const next = applyQualifyingFsrsCorrect(acquired({ fsrsReviewCorrectCount: 1, fsrsReviewCorrectStreak: 1 }));
      expect(next.fsrsReviewCorrectCount).toBe(2);
      expect(next.fsrsReviewCorrectStreak).toBe(2);
      expect(next.cardStatus).toBe("ACQUIRED");
    });

    it("count=3, streak=2 -> Mastered", () => {
      const next = applyQualifyingFsrsCorrect(acquired({ fsrsReviewCorrectCount: 2, fsrsReviewCorrectStreak: 1 }));
      expect(next.fsrsReviewCorrectCount).toBe(3);
      expect(next.fsrsReviewCorrectStreak).toBe(2);
      expect(next.cardStatus).toBe("LEARNED");
      expect(next.hasEverBeenMastered).toBe(true);
    });
  });
});

describe("spec acceptance scenarios (section 38)", () => {
  it("Test 3 -- Fresh Wrong then repair Correct -> LEARNING_1 (position/window enforcement is Phase 4, not tested here)", () => {
    const wronged = applyWrong(FRESH);
    const next = applyRepairCorrect(wronged);
    expect(next.learningStage).toBe("LEARNING_1");
  });

  it("Test 4 -- L1 Wrong, Repair Correct -> stage remains L1", () => {
    const l1 = applyNormalCorrect(FRESH); // normal progression to L1, not via repair
    const wronged = applyWrong(l1);
    const next = applyRepairCorrect(wronged);
    expect(next.learningStage).toBe("LEARNING_1");
  });

  it("Test 5 -- Fresh Correct, Correct, Correct -> ACQUIRED (5+ card spacing is Phase 3/4, not tested here)", () => {
    const l1 = applyNormalCorrect(FRESH);
    const l2 = applyNormalCorrect(l1);
    const acquiredCard = applyNormalCorrect(l2);
    expect(acquiredCard.cardStatus).toBe("ACQUIRED");
    expect(acquiredCard.learningStage).toBeNull();
    expect(acquiredCard.poolStatus).toBe("OUTSIDE");
  });

  it("Test 14 -- Correct, Correct, Wrong, Correct, Correct -> count=4, streak=2, Mastered=true", () => {
    let state = acquired();
    state = applyQualifyingFsrsCorrect(state); // Correct #1: count=1, streak=1
    state = applyQualifyingFsrsCorrect(state); // Correct #2: count=2, streak=2
    state = applyLongTermWrong(state); // Wrong: streak=0, count preserved=2, -> FORGOTTEN relearning
    state = applyRelearningRepairCorrect(state); // relearning repair (does not touch counters)
    state = applySpacedCorrect(state); // relearning complete -> back to ACQUIRED (not yet mastered)
    state = applyQualifyingFsrsCorrect(state); // Correct #3 (post-relearning): count=3, streak=1
    state = applyQualifyingFsrsCorrect(state); // Correct #4: count=4, streak=2 -> Mastered

    expect(state.fsrsReviewCorrectCount).toBe(4);
    expect(state.fsrsReviewCorrectStreak).toBe(2);
    expect(state.cardStatus).toBe("LEARNED");
    expect(state.hasEverBeenMastered).toBe(true);
  });

  it("Test 15 -- Previously Mastered lapse: MASTERED -> Wrong -> Relearning -> Repair Correct -> Spaced Correct -> MASTERED RESTORED", () => {
    const mastered = learned({ fsrsReviewCorrectCount: 6, fsrsReviewCorrectStreak: 4 });
    const forgotten = applyLongTermWrong(mastered);
    expect(forgotten.cardStatus).toBe("FORGOTTEN");

    const repaired = applyRelearningRepairCorrect(forgotten);
    expect(repaired.relearningPhase).toBe("SPACED_CONFIRMATION_PENDING");

    const restored = applySpacedCorrect(repaired);
    expect(restored.cardStatus).toBe("LEARNED");
    expect(restored.hasEverBeenMastered).toBe(true);
    // The FSRS lapse history (count/streak) is not erased or re-derived by
    // restoration itself -- it reflects whatever applyLongTermWrong left it
    // at (count preserved, streak reset to 0 at the moment of the lapse).
    expect(restored.fsrsReviewCorrectCount).toBe(6);
    expect(restored.fsrsReviewCorrectStreak).toBe(0);
  });

  it("Test 20 (partial) -- a brand-new card starts with has_ever_been_mastered = false and cannot use short restoration", () => {
    expect(INITIAL_CARD_STATE.hasEverBeenMastered).toBe(false);
    const freshAcquired = applyNormalCorrect(applyNormalCorrect(applyFirstPresentation(INITIAL_CARD_STATE)));
    const fullyAcquired = applyNormalCorrect(freshAcquired);
    const forgotten = applyLongTermWrong(fullyAcquired);
    const repaired = applyRelearningRepairCorrect(forgotten);
    const next = applySpacedCorrect(repaired);
    // Never having been mastered, relearning completion lands on ACQUIRED,
    // not a restored LEARNED -- it must re-earn first-time Mastery.
    expect(next.cardStatus).toBe("ACQUIRED");
  });
});
