import { describe, expect, it } from "vitest";

import { serializeSelectionTrace } from "@/lib/learning-engine/telemetry/selection-trace";
import type { SelectionTrace } from "@/lib/learning-engine/scheduler/next-card";

/**
 * Unit tests for lib/learning-engine/telemetry/selection-trace.ts (Phase 8,
 * remaining scope after the Phase 8 schema review).
 *
 * Covers this phase's brief section 29 ("Unit tests -- serializer"): one
 * representative scenario per distinct `SelectionReason`/source shape, plus
 * the no-card decision. Each scenario builds a hand-constructed
 * `SelectionTrace` matching next-card.ts's own documented nullability
 * rules for that reason (SelectionTrace's doc comments on
 * cardPriorityWeight/retrievability/intervalProgress), then asserts the
 * serializer loses no information and invents nothing beyond what was in
 * the trace.
 */

const CONTEXT = {
  traceId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  deckId: "33333333-3333-3333-3333-333333333333",
  sessionId: "44444444-4444-4444-4444-444444444444",
  selectedAt: new Date("2026-02-01T12:00:00.000Z"),
};

const BASE_WEIGHTS = { active: 0, due: 0, near: 0, randomMastered: 0 };
const BASE_CANDIDATES = { active: 0, due: 0, near: 0, randomMastered: 0 };

function baseTrace(overrides: Partial<SelectionTrace>): SelectionTrace {
  return {
    cardId: "card-1",
    source: "ACTIVE",
    selectionReason: "active_weighted_selection",
    schedulerMode: "pre_goal_balanced",
    schedulerPosition: 100,
    schedulerRevision: 3,
    dueCount: 2,
    dailyGoalCompleteBefore: false,
    sourceWeightsRaw: BASE_WEIGHTS,
    sourceWeightsNormalized: BASE_WEIGHTS,
    candidateCounts: BASE_CANDIDATES,
    cardPriorityWeight: null,
    retrievability: null,
    intervalProgress: null,
    admittedCardIds: [],
    policyVersion: "learning-engine-v1.0",
    emergencyFallbackApplied: false,
    firstPassQueueBefore: null,
    firstPassQueueAfter: null,
    postMasteryShuffleBagBefore: null,
    postMasteryShuffleBagAfter: null,
    randomDraws: [],
    ...overrides,
  };
}

describe("serializeSelectionTrace", () => {
  it("preserves identity/session trusted context exactly", () => {
    const payload = serializeSelectionTrace({ trace: baseTrace({}), context: CONTEXT });
    expect(payload.id).toBe(CONTEXT.traceId);
    expect(payload.userId).toBe(CONTEXT.userId);
    expect(payload.deckId).toBe(CONTEXT.deckId);
    expect(payload.sessionId).toBe(CONTEXT.sessionId);
    expect(payload.occurredAt).toBe(CONTEXT.selectedAt);
  });

  it("1. ordinary Active weighted selection: cardPriorityWeight populated, retrievability/intervalProgress null", () => {
    const trace = baseTrace({
      source: "ACTIVE",
      selectionReason: "active_weighted_selection",
      schedulerMode: "pre_goal_balanced",
      cardPriorityWeight: 1.2,
      sourceWeightsRaw: { active: 0.7, due: 0.25, near: 0.05, randomMastered: 0 },
      sourceWeightsNormalized: { active: 0.7, due: 0.25, near: 0.05, randomMastered: 0 },
      candidateCounts: { active: 5, due: 1, near: 0, randomMastered: 0 },
    });
    const payload = serializeSelectionTrace({ trace, context: CONTEXT });

    expect(payload.source).toBe("ACTIVE");
    expect(payload.selectionReason).toBe("active_weighted_selection");
    expect(payload.cardPriorityWeight).toBe(1.2);
    expect(payload.retrievability).toBeNull();
    expect(payload.intervalProgress).toBeNull();
    expect(payload.sourceWeightActiveRaw).toBe(0.7);
    expect(payload.sourceWeightActiveNormalized).toBe(0.7);
    expect(payload.candidateCountActive).toBe(5);
  });

  it("2. due_weighted_selection: retrievability populated, intervalProgress null", () => {
    const trace = baseTrace({
      source: "FSRS_DUE",
      selectionReason: "due_weighted_selection",
      schedulerMode: "pre_goal_review_pressure",
      cardPriorityWeight: 2.1,
      retrievability: 0.55,
      sourceWeightsNormalized: { active: 0.5, due: 0.48, near: 0.02, randomMastered: 0 },
      sourceWeightsRaw: { active: 0.5, due: 0.48, near: 0.02, randomMastered: 0 },
      candidateCounts: { active: 10, due: 8, near: 1, randomMastered: 0 },
    });
    const payload = serializeSelectionTrace({ trace, context: CONTEXT });

    expect(payload.source).toBe("FSRS_DUE");
    expect(payload.retrievability).toBe(0.55);
    expect(payload.intervalProgress).toBeNull();
    expect(payload.candidateCountDue).toBe(8);
  });

  it("3. near_due_weighted_selection: intervalProgress populated, retrievability null", () => {
    const trace = baseTrace({
      source: "NEAR_DUE",
      selectionReason: "near_due_weighted_selection",
      cardPriorityWeight: 1.3,
      intervalProgress: 0.9,
    });
    const payload = serializeSelectionTrace({ trace, context: CONTEXT });

    expect(payload.source).toBe("NEAR_DUE");
    expect(payload.intervalProgress).toBe(0.9);
    expect(payload.retrievability).toBeNull();
  });

  it("4. critical_due_interrupt: retrievability populated (due-style priority), card forced", () => {
    const trace = baseTrace({
      source: "FSRS_DUE",
      selectionReason: "critical_due_interrupt",
      cardPriorityWeight: 3.0,
      retrievability: 0.4,
    });
    const payload = serializeSelectionTrace({ trace, context: CONTEXT });

    expect(payload.selectionReason).toBe("critical_due_interrupt");
    expect(payload.retrievability).toBe(0.4);
    expect(payload.cardPriorityWeight).toBe(3.0);
  });

  it("5. repair_hard_cap: deterministic-priority reason, cardPriorityWeight/retrievability/intervalProgress all null", () => {
    const trace = baseTrace({
      source: "ACTIVE",
      selectionReason: "repair_hard_cap",
      cardPriorityWeight: null,
      retrievability: null,
      intervalProgress: null,
    });
    const payload = serializeSelectionTrace({ trace, context: CONTEXT });

    expect(payload.selectionReason).toBe("repair_hard_cap");
    expect(payload.cardPriorityWeight).toBeNull();
    expect(payload.retrievability).toBeNull();
    expect(payload.intervalProgress).toBeNull();
  });

  it("6. active_first_pass: firstPassQueueBefore/After preserved in exact serving order", () => {
    const trace = baseTrace({
      source: "ACTIVE",
      selectionReason: "active_first_pass",
      firstPassQueueBefore: ["card-a", "card-b", "card-c"],
      firstPassQueueAfter: ["card-b", "card-c"],
    });
    const payload = serializeSelectionTrace({ trace, context: CONTEXT });

    expect(payload.firstPassQueueBefore).toEqual(["card-a", "card-b", "card-c"]);
    expect(payload.firstPassQueueAfter).toEqual(["card-b", "card-c"]);
  });

  it("7. active_starvation: deterministic-priority reason, no weighted-draw fields", () => {
    const trace = baseTrace({
      source: "ACTIVE",
      selectionReason: "active_starvation",
      cardPriorityWeight: null,
    });
    const payload = serializeSelectionTrace({ trace, context: CONTEXT });

    expect(payload.selectionReason).toBe("active_starvation");
    expect(payload.cardPriorityWeight).toBeNull();
  });

  it("8. repair_target: deterministic-priority reason", () => {
    const trace = baseTrace({
      source: "ACTIVE",
      selectionReason: "repair_target",
      cardPriorityWeight: null,
    });
    const payload = serializeSelectionTrace({ trace, context: CONTEXT });

    expect(payload.selectionReason).toBe("repair_target");
    expect(payload.cardPriorityWeight).toBeNull();
  });

  it("9. spaced_confirmation: deterministic-priority reason", () => {
    const trace = baseTrace({
      source: "ACTIVE",
      selectionReason: "spaced_confirmation",
      cardPriorityWeight: null,
    });
    const payload = serializeSelectionTrace({ trace, context: CONTEXT });

    expect(payload.selectionReason).toBe("spaced_confirmation");
    expect(payload.cardPriorityWeight).toBeNull();
  });

  it("10. random_mastered_shuffle_bag: shuffle-bag before/after preserved, no priority weight (deterministic consume, not a weighted pick)", () => {
    const trace = baseTrace({
      source: "RANDOM_MASTERED",
      selectionReason: "random_mastered_shuffle_bag",
      schedulerMode: "post_mastery_pre_goal_balanced",
      cardPriorityWeight: null,
      sourceWeightsNormalized: { active: 0, due: 0.4, near: 0.15, randomMastered: 0.45 },
      sourceWeightsRaw: { active: 0, due: 0.4, near: 0.15, randomMastered: 0.45 },
      postMasteryShuffleBagBefore: ["card-x", "card-y"],
      postMasteryShuffleBagAfter: ["card-y"],
    });
    const payload = serializeSelectionTrace({ trace, context: CONTEXT });

    expect(payload.source).toBe("RANDOM_MASTERED");
    expect(payload.cardPriorityWeight).toBeNull();
    expect(payload.postMasteryShuffleBagBefore).toEqual(["card-x", "card-y"]);
    expect(payload.postMasteryShuffleBagAfter).toEqual(["card-y"]);
    expect(payload.sourceWeightRandomMasteredNormalized).toBe(0.45);
  });

  it("11. emergency_cooldown_relaxation: emergencyFallbackApplied true, preserved distinctly from ordinary Active selection", () => {
    const trace = baseTrace({
      source: "ACTIVE",
      selectionReason: "emergency_cooldown_relaxation",
      emergencyFallbackApplied: true,
      cardPriorityWeight: null,
    });
    const payload = serializeSelectionTrace({ trace, context: CONTEXT });

    expect(payload.selectionReason).toBe("emergency_cooldown_relaxation");
    expect(payload.emergencyFallbackApplied).toBe(true);
  });

  it("12. no_card_all_unavailable: cardId and source both null", () => {
    const trace = baseTrace({
      cardId: null,
      source: null,
      selectionReason: "no_card_all_unavailable",
      emergencyFallbackApplied: true,
    });
    const payload = serializeSelectionTrace({ trace, context: CONTEXT });

    expect(payload.cardId).toBeNull();
    expect(payload.source).toBeNull();
    expect(payload.selectionReason).toBe("no_card_all_unavailable");
  });

  it("preserves randomDraws in exact consumption order, including an empty array for a deterministic decision", () => {
    const withDraws = serializeSelectionTrace({
      trace: baseTrace({ randomDraws: [0.1, 0.52, 0.999] }),
      context: CONTEXT,
    });
    expect(withDraws.randomDraws).toEqual([0.1, 0.52, 0.999]);

    const withoutDraws = serializeSelectionTrace({
      trace: baseTrace({ selectionReason: "repair_hard_cap", randomDraws: [] }),
      context: CONTEXT,
    });
    expect(withoutDraws.randomDraws).toEqual([]);
  });

  it("preserves admittedCardIds (including empty) and policyVersion exactly", () => {
    const withAdmissions = serializeSelectionTrace({
      trace: baseTrace({ admittedCardIds: ["new-1", "new-2"] }),
      context: CONTEXT,
    });
    expect(withAdmissions.admittedCardIds).toEqual(["new-1", "new-2"]);

    const withoutAdmissions = serializeSelectionTrace({ trace: baseTrace({}), context: CONTEXT });
    expect(withoutAdmissions.admittedCardIds).toEqual([]);
    expect(withoutAdmissions.policyVersion).toBe("learning-engine-v1.0");
  });

  it("builds a canonical tracePayload that round-trips through JSON with no information loss", () => {
    const trace = baseTrace({
      source: "RANDOM_MASTERED",
      selectionReason: "random_mastered_shuffle_bag",
      randomDraws: [0.3, 0.7],
      admittedCardIds: ["new-1"],
      postMasteryShuffleBagBefore: ["card-x"],
      postMasteryShuffleBagAfter: [],
    });
    const payload = serializeSelectionTrace({ trace, context: CONTEXT });

    const roundTripped = JSON.parse(JSON.stringify(payload.tracePayload)) as Record<string, unknown>;
    expect(roundTripped.traceId).toBe(CONTEXT.traceId);
    expect(roundTripped.selectedAt).toBe(CONTEXT.selectedAt.toISOString());
    expect(roundTripped.randomDraws).toEqual([0.3, 0.7]);
    expect(roundTripped.admittedCardIds).toEqual(["new-1"]);
    expect(roundTripped.postMasteryShuffleBagBefore).toEqual(["card-x"]);
    expect(roundTripped.postMasteryShuffleBagAfter).toEqual([]);
    expect(roundTripped.sourceWeightsRaw).toEqual(trace.sourceWeightsRaw);
    expect(roundTripped.sourceWeightsNormalized).toEqual(trace.sourceWeightsNormalized);
  });

  it("is pure: does not mutate the input trace or context", () => {
    const trace = baseTrace({ admittedCardIds: ["new-1"], randomDraws: [0.5] });
    const frozenTrace = Object.freeze({ ...trace });
    const frozenContext = Object.freeze({ ...CONTEXT });

    expect(() => serializeSelectionTrace({ trace: frozenTrace, context: frozenContext })).not.toThrow();
  });
});
