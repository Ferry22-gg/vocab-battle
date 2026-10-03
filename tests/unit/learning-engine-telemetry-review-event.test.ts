import { describe, expect, it } from "vitest";

import { buildReviewEvent } from "@/lib/learning-engine/telemetry/review-event";
import type {
  BuildReviewEventInput,
  ReviewEventExposureContext,
  ReviewEventFsrsContext,
  ReviewEventGoalContext,
  ReviewEventMasteryContext,
  ReviewEventPolicyContext,
  ReviewEventPosition,
  ReviewEventSelectionContext,
} from "@/lib/learning-engine/telemetry/review-event";
import {
  applyFirstPresentation,
  applyLongTermWrong,
  applyNormalCorrect,
  applyQualifyingFsrsCorrect,
  applyRelearningRepairCorrect,
  applyRepairCorrect,
  applySpacedCorrect,
  applyWrong,
} from "@/lib/learning-engine/transitions";
import { INITIAL_CARD_STATE } from "@/lib/learning-engine/state";
import type { LearningEngineCardState } from "@/lib/learning-engine/state";

/**
 * Unit tests for lib/learning-engine/telemetry/review-event.ts (Phase 8,
 * remaining scope after the Phase 8 schema review).
 *
 * Covers this phase's brief section 30 ("Unit tests -- review event
 * builder"): representative paths across Active/Due/Near-Due/Critical
 * Due/repair/relearning/Random Mastered/emergency-fallback, verifying
 * before/after state, FSRS before/after where applicable, mastery
 * counter before values, selection reason/weights, policy/version
 * context, and null semantics where a field does not apply.
 *
 * Before/after card states are produced by the REAL Phase 2 transition
 * functions (lib/learning-engine/transitions.ts), not hand-written, so
 * these tests exercise the builder against states the engine itself can
 * actually produce.
 */

const OCCURRED_AT = new Date("2026-02-01T12:00:00.000Z");

const IDENTITY = {
  clientEventId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  deckId: "33333333-3333-3333-3333-333333333333",
  cardId: "44444444-4444-4444-4444-444444444444",
  sessionId: "55555555-5555-5555-5555-555555555555",
  occurredAt: OCCURRED_AT,
};

const POSITION: ReviewEventPosition = { sessionPosition: 10, schedulerPosition: 500, schedulerRevision: 2 };

const POLICY: ReviewEventPolicyContext = {
  policyVersion: "learning-engine-v1.0",
  fsrsVersion: "ts-fsrs@5.4.2",
  parameterSetId: null,
  experimentAssignmentId: null,
};

const NO_GOAL_CONTEXT: ReviewEventGoalContext = { dailyGoalCompleteBefore: false, streakMinimumCompleteBefore: false };

const NO_EXPOSURE: ReviewEventExposureContext = {
  sameDaySeenCountBefore: 1,
  sameDayWrongCountBefore: 0,
  previousPresentationSchedulerPosition: null,
  lastSeenAtBefore: null,
};

const NO_FSRS: ReviewEventFsrsContext = {
  fsrsDBefore: null,
  fsrsSBefore: null,
  fsrsRBefore: null,
  fsrsDAfter: null,
  fsrsSAfter: null,
  fsrsRAfter: null,
  elapsedDays: null,
  scheduledIntervalDays: null,
};

const NO_MASTERY: ReviewEventMasteryContext = { fsrsReviewCorrectCountBefore: 0, fsrsReviewCorrectStreakBefore: 0 };

function activeSelection(overrides: Partial<ReviewEventSelectionContext> = {}): ReviewEventSelectionContext {
  return {
    selectionTraceId: "66666666-6666-6666-6666-666666666666",
    source: "ACTIVE",
    selectionReason: "active_weighted_selection",
    schedulerMode: "pre_goal_balanced",
    cardPriorityWeight: 1.0,
    candidateCount: 4,
    sourceWeightActive: 0.7,
    sourceWeightDue: 0.25,
    sourceWeightNear: 0.05,
    sourceWeightRandomMastered: null,
    sourceWeightActiveRaw: 0.7,
    sourceWeightDueRaw: 0.25,
    sourceWeightNearRaw: 0.05,
    sourceWeightRandomMasteredRaw: null,
    ...overrides,
  };
}

function build(
  overrides: Partial<BuildReviewEventInput> & {
    beforeState: LearningEngineCardState;
    afterState: LearningEngineCardState;
    correct: boolean;
  },
) {
  const { beforeState, afterState, correct, ...rest } = overrides;
  return buildReviewEvent({
    identity: IDENTITY,
    position: POSITION,
    behavior: { correct, responseTimeMs: 1500, timeToFirstActionMs: null },
    selection: activeSelection(),
    goal: NO_GOAL_CONTEXT,
    exposure: NO_EXPOSURE,
    fsrs: NO_FSRS,
    mastery: NO_MASTERY,
    policy: POLICY,
    beforeState,
    afterState,
    ...rest,
  });
}

describe("buildReviewEvent", () => {
  it("1. Active NEW first presentation: NEW->LEARNING/FRESH, not a stage-advancing success (no Correct occurred)", () => {
    const before = INITIAL_CARD_STATE;
    const after = applyFirstPresentation(before);
    const event = build({ beforeState: before, afterState: after, correct: false, selection: activeSelection({ selectionReason: "active_first_pass" }) });

    expect(event.cardStatusBefore).toBe("NEW");
    expect(event.cardStatusAfter).toBe("LEARNING");
    expect(event.learningStageAfter).toBe("FRESH");
    expect(event.isStageAdvancingSuccess).toBe(false);
    expect(event.isRepairRetry).toBe(false);
  });

  it("2. Active normal Correct: FRESH->LEARNING_1, isStageAdvancingSuccess true, not a repair retry", () => {
    const before: LearningEngineCardState = { ...INITIAL_CARD_STATE, cardStatus: "LEARNING", learningStage: "FRESH" };
    const after = applyNormalCorrect(before);
    const event = build({ beforeState: before, afterState: after, correct: true });

    expect(event.learningStageBefore).toBe("FRESH");
    expect(event.learningStageAfter).toBe("LEARNING_1");
    expect(event.isStageAdvancingSuccess).toBe(true);
    expect(event.isRepairRetry).toBe(false);
    expect(event.repairPendingBefore).toBe(false);
  });

  it("3. Active Wrong creating repair: repairPending false->true, repairPendingBefore reflects the BEFORE value", () => {
    const before: LearningEngineCardState = { ...INITIAL_CARD_STATE, cardStatus: "LEARNING", learningStage: "LEARNING_1" };
    const after = applyWrong(before);
    const event = build({ beforeState: before, afterState: after, correct: false });

    expect(after.repairPending).toBe(true);
    expect(event.repairPendingBefore).toBe(false);
    expect(event.isRepairRetry).toBe(false);
    expect(event.isStageAdvancingSuccess).toBe(false);
  });

  it("4. Repair retry Correct: repairPendingBefore true, isRepairRetry true, L1 stage unchanged (not stage-advancing)", () => {
    const wronged: LearningEngineCardState = { ...INITIAL_CARD_STATE, cardStatus: "LEARNING", learningStage: "LEARNING_1" };
    const before = applyWrong(wronged);
    const after = applyRepairCorrect(before);
    const event = build({ beforeState: before, afterState: after, correct: true, selection: activeSelection({ selectionReason: "repair_target", cardPriorityWeight: null }) });

    expect(before.repairPending).toBe(true);
    expect(event.repairPendingBefore).toBe(true);
    expect(event.isRepairRetry).toBe(true);
    expect(event.learningStageBefore).toBe("LEARNING_1");
    expect(event.learningStageAfter).toBe("LEARNING_1");
    expect(event.isStageAdvancingSuccess).toBe(false);
  });

  it("4b. FRESH repair exception: repair retry Correct DOES advance stage (FRESH -> LEARNING_1)", () => {
    const wronged: LearningEngineCardState = { ...INITIAL_CARD_STATE, cardStatus: "LEARNING", learningStage: "FRESH" };
    const before = applyWrong(wronged);
    const after = applyRepairCorrect(before);
    const event = build({ beforeState: before, afterState: after, correct: true, selection: activeSelection({ selectionReason: "repair_target", cardPriorityWeight: null }) });

    expect(event.isRepairRetry).toBe(true);
    expect(event.learningStageBefore).toBe("FRESH");
    expect(event.learningStageAfter).toBe("LEARNING_1");
    expect(event.isStageAdvancingSuccess).toBe(true);
  });

  it("5. Spaced Confirmation (never-before-mastered): FORGOTTEN/SPACED_CONFIRMATION_PENDING -> ACQUIRED, not a repair retry", () => {
    const before: LearningEngineCardState = {
      ...INITIAL_CARD_STATE,
      cardStatus: "FORGOTTEN",
      relearningPhase: "SPACED_CONFIRMATION_PENDING",
      hasEverBeenMastered: false,
    };
    const after = applySpacedCorrect(before);
    const event = build({ beforeState: before, afterState: after, correct: true, selection: activeSelection({ selectionReason: "spaced_confirmation", cardPriorityWeight: null }) });

    expect(event.cardStatusBefore).toBe("FORGOTTEN");
    expect(event.cardStatusAfter).toBe("ACQUIRED");
    expect(event.isRepairRetry).toBe(false);
    expect(event.isStageAdvancingSuccess).toBe(true);
    expect(event.hasEverBeenMastered).toBe(false);
  });

  it("5b. Spaced Confirmation (previously mastered): short restoration -> LEARNED, hasEverBeenMastered stays true", () => {
    const before: LearningEngineCardState = {
      ...INITIAL_CARD_STATE,
      cardStatus: "FORGOTTEN",
      relearningPhase: "SPACED_CONFIRMATION_PENDING",
      hasEverBeenMastered: true,
    };
    const after = applySpacedCorrect(before);
    const event = build({ beforeState: before, afterState: after, correct: true, selection: activeSelection({ selectionReason: "spaced_confirmation", cardPriorityWeight: null }) });

    expect(event.cardStatusAfter).toBe("LEARNED");
    expect(event.hasEverBeenMastered).toBe(true);
  });

  it("6. Due Correct (qualifying FSRS): mastery evidence increments, FSRS before/after populated, isStageAdvancingSuccess false (no learning_stage/card_status change pre-mastery)", () => {
    const before: LearningEngineCardState = { ...INITIAL_CARD_STATE, cardStatus: "ACQUIRED", poolStatus: "OUTSIDE" };
    const after = applyQualifyingFsrsCorrect(before);
    const event = build({
      beforeState: before,
      afterState: after,
      correct: true,
      selection: activeSelection({ source: "FSRS_DUE", selectionReason: "due_weighted_selection", cardPriorityWeight: 2.1, sourceWeightDue: 0.48, sourceWeightDueRaw: 0.48 }),
      fsrs: { ...NO_FSRS, fsrsDBefore: 5.0, fsrsSBefore: 10.0, fsrsRBefore: 0.4, fsrsDAfter: 5.0, fsrsSAfter: 15.0, fsrsRAfter: 0.95 },
      mastery: { fsrsReviewCorrectCountBefore: 0, fsrsReviewCorrectStreakBefore: 0 },
    });

    expect(after.fsrsReviewCorrectCount).toBe(1);
    expect(event.cardStatusAfter).toBe("ACQUIRED");
    expect(event.isStageAdvancingSuccess).toBe(false);
    expect(event.fsrsRBefore).toBe(0.4);
    expect(event.fsrsRAfter).toBe(0.95);
    expect(event.fsrsReviewCorrectCountBefore).toBe(0);
  });

  it("6b. Due Correct reaching first-time Mastery IS a stage-advancing success (card_status ACQUIRED -> LEARNED)", () => {
    const before: LearningEngineCardState = {
      ...INITIAL_CARD_STATE,
      cardStatus: "ACQUIRED",
      poolStatus: "OUTSIDE",
      fsrsReviewCorrectCount: 2,
      fsrsReviewCorrectStreak: 1,
    };
    const after = applyQualifyingFsrsCorrect(before);
    const event = build({
      beforeState: before,
      afterState: after,
      correct: true,
      selection: activeSelection({ source: "FSRS_DUE", selectionReason: "due_weighted_selection", cardPriorityWeight: 1.5 }),
      mastery: { fsrsReviewCorrectCountBefore: 2, fsrsReviewCorrectStreakBefore: 1 },
    });

    expect(after.cardStatus).toBe("LEARNED");
    expect(event.cardStatusAfter).toBe("LEARNED");
    expect(event.isStageAdvancingSuccess).toBe(true);
    expect(event.hasEverBeenMastered).toBe(true);
  });

  it("7. Due Wrong: FORGOTTEN/REPAIR_PENDING, streak reset, count preserved, FSRS Again-style values", () => {
    const before: LearningEngineCardState = {
      ...INITIAL_CARD_STATE,
      cardStatus: "ACQUIRED",
      poolStatus: "OUTSIDE",
      fsrsReviewCorrectCount: 4,
      fsrsReviewCorrectStreak: 2,
    };
    const after = applyLongTermWrong(before);
    const event = build({
      beforeState: before,
      afterState: after,
      correct: false,
      selection: activeSelection({ source: "FSRS_DUE", selectionReason: "due_weighted_selection", cardPriorityWeight: 2.8 }),
      mastery: { fsrsReviewCorrectCountBefore: 4, fsrsReviewCorrectStreakBefore: 2 },
    });

    expect(after.cardStatus).toBe("FORGOTTEN");
    expect(after.relearningPhase).toBe("REPAIR_PENDING");
    expect(after.fsrsReviewCorrectCount).toBe(4);
    expect(after.fsrsReviewCorrectStreak).toBe(0);
    expect(event.fsrsReviewCorrectCountBefore).toBe(4);
    expect(event.fsrsReviewCorrectStreakBefore).toBe(2);
    expect(event.isRepairRetry).toBe(false);
  });

  it("8. Near-Due Correct: card state byte-for-byte unchanged (no mastery increment, no stage change)", () => {
    const before: LearningEngineCardState = {
      ...INITIAL_CARD_STATE,
      cardStatus: "ACQUIRED",
      poolStatus: "OUTSIDE",
      fsrsReviewCorrectCount: 1,
      fsrsReviewCorrectStreak: 1,
    };
    const after = before; // resolveNearDueCorrect returns cardState unchanged -- see lib/learning-engine/fsrs/lifecycle.ts
    const event = build({
      beforeState: before,
      afterState: after,
      correct: true,
      selection: activeSelection({ source: "NEAR_DUE", selectionReason: "near_due_weighted_selection", cardPriorityWeight: 1.3, sourceWeightNear: 0.1 }),
      mastery: { fsrsReviewCorrectCountBefore: 1, fsrsReviewCorrectStreakBefore: 1 },
    });

    expect(event.cardStatusBefore).toBe(event.cardStatusAfter);
    expect(event.isStageAdvancingSuccess).toBe(false);
    expect(event.fsrsReviewCorrectCountBefore).toBe(1);
  });

  it("9. Near-Due Wrong: identical mechanics to Due Wrong (relearning triggered)", () => {
    const before: LearningEngineCardState = { ...INITIAL_CARD_STATE, cardStatus: "LEARNED", poolStatus: "OUTSIDE", hasEverBeenMastered: true, fsrsReviewCorrectCount: 6, fsrsReviewCorrectStreak: 3 };
    const after = applyLongTermWrong(before);
    const event = build({
      beforeState: before,
      afterState: after,
      correct: false,
      selection: activeSelection({ source: "NEAR_DUE", selectionReason: "near_due_weighted_selection", cardPriorityWeight: 1.4 }),
      mastery: { fsrsReviewCorrectCountBefore: 6, fsrsReviewCorrectStreakBefore: 3 },
    });

    expect(event.cardStatusBefore).toBe("LEARNED");
    expect(event.cardStatusAfter).toBe("FORGOTTEN");
    expect(event.hasEverBeenMastered).toBe(true);
    expect(event.fsrsReviewCorrectCountBefore).toBe(6);
  });

  it("10. Critical Due: due_weighted-style priority fields populated via critical_due_interrupt reason", () => {
    const before: LearningEngineCardState = { ...INITIAL_CARD_STATE, cardStatus: "ACQUIRED", poolStatus: "OUTSIDE" };
    const after = applyQualifyingFsrsCorrect(before);
    const event = build({
      beforeState: before,
      afterState: after,
      correct: true,
      selection: activeSelection({ source: "FSRS_DUE", selectionReason: "critical_due_interrupt", cardPriorityWeight: 3.0 }),
      fsrs: { ...NO_FSRS, fsrsRBefore: 0.1, fsrsRAfter: 0.98 },
    });

    expect(event.selectionReason).toBe("critical_due_interrupt");
    expect(event.fsrsRBefore).toBe(0.1);
  });

  it("11. Active starvation: deterministic-priority selection, cardPriorityWeight null", () => {
    const before: LearningEngineCardState = { ...INITIAL_CARD_STATE, cardStatus: "LEARNING", learningStage: "LEARNING_2" };
    const after = applyNormalCorrect(before);
    const event = build({
      beforeState: before,
      afterState: after,
      correct: true,
      selection: activeSelection({ selectionReason: "active_starvation", cardPriorityWeight: null, sourceWeightActive: 0.5 }),
    });

    expect(event.selectionReason).toBe("active_starvation");
    expect(event.cardPriorityWeight).toBeNull();
    expect(event.isStageAdvancingSuccess).toBe(true);
  });

  it("12. RANDOM_MASTERED Correct: Good update visible, mastery counters NOT incremented, card remains LEARNED (section 40 semantics)", () => {
    const before: LearningEngineCardState = { ...INITIAL_CARD_STATE, cardStatus: "LEARNED", poolStatus: "OUTSIDE", hasEverBeenMastered: true, fsrsReviewCorrectCount: 5, fsrsReviewCorrectStreak: 2 };
    const after = before; // resolveRandomMasteredCorrect = resolveNearDueCorrect: cardState unchanged
    const event = build({
      beforeState: before,
      afterState: after,
      correct: true,
      selection: activeSelection({ source: "RANDOM_MASTERED", selectionReason: "random_mastered_shuffle_bag", cardPriorityWeight: null, sourceWeightActive: null, sourceWeightDue: null, sourceWeightNear: null, sourceWeightRandomMastered: 0.3, sourceWeightActiveRaw: null, sourceWeightDueRaw: null, sourceWeightNearRaw: null, sourceWeightRandomMasteredRaw: 0.3 }),
      fsrs: { ...NO_FSRS, fsrsRBefore: 0.85, fsrsRAfter: 0.99 },
      mastery: { fsrsReviewCorrectCountBefore: 5, fsrsReviewCorrectStreakBefore: 2 },
    });

    expect(event.cardStatusAfter).toBe("LEARNED");
    expect(event.fsrsReviewCorrectCountBefore).toBe(5);
    expect(after.fsrsReviewCorrectCount).toBe(5); // unchanged, not re-incremented
    expect(event.isStageAdvancingSuccess).toBe(false);
    expect(event.fsrsRAfter).toBe(0.99);
  });

  it("13. RANDOM_MASTERED Wrong: Again update visible, FORGOTTEN after-state, historical mastery preserved", () => {
    const before: LearningEngineCardState = { ...INITIAL_CARD_STATE, cardStatus: "LEARNED", poolStatus: "OUTSIDE", hasEverBeenMastered: true, fsrsReviewCorrectCount: 5, fsrsReviewCorrectStreak: 2 };
    const after = applyLongTermWrong(before); // resolveRandomMasteredWrong = resolveLongTermWrong
    const event = build({
      beforeState: before,
      afterState: after,
      correct: false,
      selection: activeSelection({ source: "RANDOM_MASTERED", selectionReason: "random_mastered_shuffle_bag", cardPriorityWeight: null }),
      mastery: { fsrsReviewCorrectCountBefore: 5, fsrsReviewCorrectStreakBefore: 2 },
    });

    expect(event.cardStatusBefore).toBe("LEARNED");
    expect(event.cardStatusAfter).toBe("FORGOTTEN");
    expect(event.hasEverBeenMastered).toBe(true);
    expect(after.fsrsReviewCorrectCount).toBe(5); // preserved
    expect(after.fsrsReviewCorrectStreak).toBe(0); // reset
  });

  it("14. emergency cooldown relaxation-selected card: ordinary Correct telemetry, reason records the emergency path", () => {
    const before: LearningEngineCardState = { ...INITIAL_CARD_STATE, cardStatus: "LEARNING", learningStage: "FRESH" };
    const after = applyNormalCorrect(before);
    const event = build({
      beforeState: before,
      afterState: after,
      correct: true,
      selection: activeSelection({ selectionReason: "emergency_cooldown_relaxation", cardPriorityWeight: null }),
    });

    expect(event.selectionReason).toBe("emergency_cooldown_relaxation");
    expect(event.isStageAdvancingSuccess).toBe(true);
  });

  it("relearning repair retry (FORGOTTEN, REPAIR_PENDING -> SPACED_CONFIRMATION_PENDING) is a repair retry but not stage-advancing", () => {
    const wronged: LearningEngineCardState = { ...INITIAL_CARD_STATE, cardStatus: "ACQUIRED", poolStatus: "OUTSIDE" };
    const before = applyLongTermWrong(wronged);
    const after = applyRelearningRepairCorrect(before);
    const event = build({ beforeState: before, afterState: after, correct: true, selection: activeSelection({ selectionReason: "repair_target", cardPriorityWeight: null }) });

    expect(before.relearningPhase).toBe("REPAIR_PENDING");
    expect(event.isRepairRetry).toBe(true);
    expect(event.cardStatusBefore).toBe("FORGOTTEN");
    expect(event.cardStatusAfter).toBe("FORGOTTEN");
    expect(event.isStageAdvancingSuccess).toBe(false);
  });

  it("derives scheduledIntervalSec/intervalProgress/daysOverdue from elapsed/scheduled days, and null when not applicable", () => {
    const before: LearningEngineCardState = { ...INITIAL_CARD_STATE, cardStatus: "ACQUIRED", poolStatus: "OUTSIDE" };
    const after = applyQualifyingFsrsCorrect(before);

    const overdueEvent = build({
      beforeState: before,
      afterState: after,
      correct: true,
      fsrs: { ...NO_FSRS, elapsedDays: 12, scheduledIntervalDays: 10 },
    });
    expect(overdueEvent.scheduledIntervalSec).toBe(10 * 86400);
    expect(overdueEvent.intervalProgress).toBeCloseTo(1.2, 5);
    expect(overdueEvent.daysOverdue).toBeCloseTo(2, 5);

    const notOverdueEvent = build({
      beforeState: before,
      afterState: after,
      correct: true,
      fsrs: { ...NO_FSRS, elapsedDays: 8, scheduledIntervalDays: 10 },
    });
    expect(notOverdueEvent.daysOverdue).toBe(0);

    const naEvent = build({ beforeState: before, afterState: after, correct: true });
    expect(naEvent.scheduledIntervalSec).toBeNull();
    expect(naEvent.intervalProgress).toBeNull();
    expect(naEvent.daysOverdue).toBeNull();
  });

  it("derives secondsSinceLastSeen from authoritative pre-mutation lastSeenAtBefore, and null for a first-ever presentation", () => {
    const before = INITIAL_CARD_STATE;
    const after = applyFirstPresentation(before);

    const seenBefore = build({
      beforeState: before,
      afterState: after,
      correct: true,
      exposure: { ...NO_EXPOSURE, lastSeenAtBefore: new Date(OCCURRED_AT.getTime() - 90_000) },
    });
    expect(seenBefore.secondsSinceLastSeen).toBe(90);

    const neverSeen = build({ beforeState: before, afterState: after, correct: true });
    expect(neverSeen.secondsSinceLastSeen).toBeNull();
  });

  it("cardsSinceLastSeen is null whenever no authoritative previous scheduler position is supplied (the documented Phase 8 gap)", () => {
    const before: LearningEngineCardState = { ...INITIAL_CARD_STATE, cardStatus: "LEARNING", learningStage: "FRESH" };
    const after = applyNormalCorrect(before);
    const event = build({ beforeState: before, afterState: after, correct: true });
    expect(event.cardsSinceLastSeen).toBeNull();
  });

  it("computes cardsSinceLastSeen once an authoritative previous scheduler position IS supplied", () => {
    const before: LearningEngineCardState = { ...INITIAL_CARD_STATE, cardStatus: "LEARNING", learningStage: "FRESH" };
    const after = applyNormalCorrect(before);
    const event = build({
      beforeState: before,
      afterState: after,
      correct: true,
      exposure: { ...NO_EXPOSURE, previousPresentationSchedulerPosition: 490 },
    });
    // schedulerPosition (POSITION.schedulerPosition) is 500 -> 500 - 490 - 1 = 9 intervening cards.
    expect(event.cardsSinceLastSeen).toBe(9);
  });

  it("is pure: does not mutate beforeState/afterState", () => {
    const before = Object.freeze({ ...INITIAL_CARD_STATE, cardStatus: "LEARNING" as const, learningStage: "FRESH" as const });
    const after = Object.freeze(applyNormalCorrect(before));
    expect(() => build({ beforeState: before, afterState: after, correct: true })).not.toThrow();
  });
});
