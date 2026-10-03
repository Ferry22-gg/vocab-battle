import { describe, expect, it } from "vitest";

import {
  INITIAL_SESSION_TELEMETRY_STATE,
  applyCommittedAnswerToSessionTelemetry,
  applyDailyGoalCompletion,
  buildSessionEndTelemetry,
  buildSessionStartTelemetry,
  deriveSecondsAfterGoal,
} from "@/lib/learning-engine/telemetry/session-telemetry";

/**
 * Unit tests for lib/learning-engine/telemetry/session-telemetry.ts
 * (Phase 8, remaining scope after the Phase 8 schema review). Covers this
 * phase's original brief section 43: start metrics, goal completion,
 * continue-after-goal (questionsAfterGoal), session end, repair counter,
 * Critical Due counter, Active starvation counter, voluntary exit
 * position.
 */

describe("session-telemetry helpers", () => {
  it("buildSessionStartTelemetry sets start snapshot fields and leaves every other field at its initial value", () => {
    const state = buildSessionStartTelemetry({ activePoolSize: 14, dueCount: 3, policyVersion: "learning-engine-v1.0" });

    expect(state.activePoolStart).toBe(14);
    expect(state.dueCountStart).toBe(3);
    expect(state.policyVersion).toBe("learning-engine-v1.0");
    expect(state.repairEvents).toBe(0);
    expect(state.criticalDueInterrupts).toBe(0);
    expect(state.activeStarvationGuarantees).toBe(0);
    expect(state.questionsAfterGoal).toBe(0);
    expect(state.dailyGoalCompletedAt).toBeNull();
    expect(state.activePoolEnd).toBeNull();
    expect(state.dueCountEnd).toBeNull();
    expect(state.voluntaryExitPosition).toBeNull();
  });

  it("applyCommittedAnswerToSessionTelemetry increments repairEvents only for an actual repair retry", () => {
    const afterRepair = applyCommittedAnswerToSessionTelemetry(INITIAL_SESSION_TELEMETRY_STATE, {
      selectionReason: "repair_target",
      isRepairRetry: true,
      dailyGoalCompleteBeforeThisAnswer: false,
    });
    expect(afterRepair.repairEvents).toBe(1);
    expect(afterRepair.criticalDueInterrupts).toBe(0);
    expect(afterRepair.activeStarvationGuarantees).toBe(0);

    const ordinary = applyCommittedAnswerToSessionTelemetry(INITIAL_SESSION_TELEMETRY_STATE, {
      selectionReason: "active_weighted_selection",
      isRepairRetry: false,
      dailyGoalCompleteBeforeThisAnswer: false,
    });
    expect(ordinary.repairEvents).toBe(0);
  });

  it("applyCommittedAnswerToSessionTelemetry increments criticalDueInterrupts exactly on that selectionReason", () => {
    const state = applyCommittedAnswerToSessionTelemetry(INITIAL_SESSION_TELEMETRY_STATE, {
      selectionReason: "critical_due_interrupt",
      isRepairRetry: false,
      dailyGoalCompleteBeforeThisAnswer: false,
    });
    expect(state.criticalDueInterrupts).toBe(1);
    expect(state.repairEvents).toBe(0);
    expect(state.activeStarvationGuarantees).toBe(0);
  });

  it("applyCommittedAnswerToSessionTelemetry increments activeStarvationGuarantees exactly on that selectionReason", () => {
    const state = applyCommittedAnswerToSessionTelemetry(INITIAL_SESSION_TELEMETRY_STATE, {
      selectionReason: "active_starvation",
      isRepairRetry: false,
      dailyGoalCompleteBeforeThisAnswer: false,
    });
    expect(state.activeStarvationGuarantees).toBe(1);
    expect(state.repairEvents).toBe(0);
    expect(state.criticalDueInterrupts).toBe(0);
  });

  it("applyCommittedAnswerToSessionTelemetry increments questionsAfterGoal only when dailyGoalCompleteBeforeThisAnswer is true -- the completing answer itself does not count", () => {
    const completingAnswer = applyCommittedAnswerToSessionTelemetry(INITIAL_SESSION_TELEMETRY_STATE, {
      selectionReason: "active_weighted_selection",
      isRepairRetry: false,
      dailyGoalCompleteBeforeThisAnswer: false, // goal was NOT yet complete before this answer -- this is the completing one
    });
    expect(completingAnswer.questionsAfterGoal).toBe(0);

    const afterGoalAnswer = applyCommittedAnswerToSessionTelemetry(completingAnswer, {
      selectionReason: "active_weighted_selection",
      isRepairRetry: false,
      dailyGoalCompleteBeforeThisAnswer: true,
    });
    expect(afterGoalAnswer.questionsAfterGoal).toBe(1);
  });

  it("applyCommittedAnswerToSessionTelemetry accumulates counters across multiple answers", () => {
    let state = INITIAL_SESSION_TELEMETRY_STATE;
    const answers = [
      { selectionReason: "repair_target" as const, isRepairRetry: true, dailyGoalCompleteBeforeThisAnswer: false },
      { selectionReason: "critical_due_interrupt" as const, isRepairRetry: false, dailyGoalCompleteBeforeThisAnswer: false },
      { selectionReason: "active_starvation" as const, isRepairRetry: false, dailyGoalCompleteBeforeThisAnswer: true },
      { selectionReason: "repair_hard_cap" as const, isRepairRetry: true, dailyGoalCompleteBeforeThisAnswer: true },
    ];
    for (const answer of answers) {
      state = applyCommittedAnswerToSessionTelemetry(state, answer);
    }
    expect(state.repairEvents).toBe(2);
    expect(state.criticalDueInterrupts).toBe(1);
    expect(state.activeStarvationGuarantees).toBe(1);
    expect(state.questionsAfterGoal).toBe(2);
  });

  it("applyDailyGoalCompletion records the completion instant exactly once (idempotent on retry)", () => {
    const firstAt = new Date("2026-02-01T12:00:00.000Z");
    const secondAt = new Date("2026-02-01T13:00:00.000Z");

    const afterFirst = applyDailyGoalCompletion(INITIAL_SESSION_TELEMETRY_STATE, firstAt);
    expect(afterFirst.dailyGoalCompletedAt).toEqual(firstAt);

    const afterSecond = applyDailyGoalCompletion(afterFirst, secondAt);
    expect(afterSecond.dailyGoalCompletedAt).toEqual(firstAt); // unchanged -- not overwritten
  });

  it("buildSessionEndTelemetry sets end snapshot and voluntary exit position", () => {
    const state = buildSessionEndTelemetry(INITIAL_SESSION_TELEMETRY_STATE, {
      activePoolSize: 20,
      dueCount: 0,
      voluntaryExitPosition: 742,
    });
    expect(state.activePoolEnd).toBe(20);
    expect(state.dueCountEnd).toBe(0);
    expect(state.voluntaryExitPosition).toBe(742);
  });

  it("buildSessionEndTelemetry allows a null voluntaryExitPosition for a non-voluntary end", () => {
    const state = buildSessionEndTelemetry(INITIAL_SESSION_TELEMETRY_STATE, {
      activePoolSize: 20,
      dueCount: 0,
      voluntaryExitPosition: null,
    });
    expect(state.voluntaryExitPosition).toBeNull();
  });

  it("deriveSecondsAfterGoal is null before the Daily Goal is completed (never a fabricated 0)", () => {
    expect(deriveSecondsAfterGoal(INITIAL_SESSION_TELEMETRY_STATE, new Date())).toBeNull();
  });

  it("deriveSecondsAfterGoal computes wall-clock seconds from the trusted completion timestamp", () => {
    const completedAt = new Date("2026-02-01T12:00:00.000Z");
    const asOf = new Date("2026-02-01T12:05:30.000Z");
    const state = applyDailyGoalCompletion(INITIAL_SESSION_TELEMETRY_STATE, completedAt);

    expect(deriveSecondsAfterGoal(state, asOf)).toBe(330);
  });

  it("is pure: does not mutate its input state", () => {
    const frozen = Object.freeze({ ...INITIAL_SESSION_TELEMETRY_STATE });
    expect(() =>
      applyCommittedAnswerToSessionTelemetry(frozen, {
        selectionReason: "repair_target",
        isRepairRetry: true,
        dailyGoalCompleteBeforeThisAnswer: false,
      }),
    ).not.toThrow();
  });
});
