import { describe, expect, it } from "vitest";

import {
  mapRawSchedulerSnapshot,
  SnapshotValidationError,
  type RawSchedulerSnapshot,
  type RawSchedulerSnapshotCard,
} from "@/lib/learning-engine/runtime/snapshot-mapper";

/**
 * Unit tests for the Runtime Cutover RC-B pure snapshot mapper. No DB
 * access -- every scenario is a hand-constructed raw RPC shape, matching
 * what supabase/migrations/
 * 20261009000000_learning_engine_v1_runtime_cutover_rc_b_selection_claim.sql's
 * get_learning_engine_v1_scheduler_snapshot() actually returns.
 */

function baseCard(overrides: Partial<RawSchedulerSnapshotCard>): RawSchedulerSnapshotCard {
  return {
    cardId: "card-1",
    cardStatus: "NEW",
    learningStage: null,
    poolStatus: null,
    relearningPhase: null,
    hasEverBeenMastered: false,
    repairPending: false,
    repairWrongPosition: null,
    repairTargetPosition: null,
    repairHardCapPosition: null,
    correctCooldownUntilPosition: null,
    activeDrawsSinceEligible: 0,
    fsrsReviewCorrectCount: 0,
    fsrsReviewCorrectStreak: 0,
    fsrsDueAt: null,
    fsrsStability: null,
    fsrsDifficulty: null,
    fsrsElapsedDays: 0,
    fsrsScheduledDays: 0,
    fsrsReps: 0,
    fsrsLapses: 0,
    fsrsLearningSteps: 0,
    fsrsState: null,
    fsrsLastReviewAt: null,
    ...overrides,
  };
}

function baseRaw(cards: readonly RawSchedulerSnapshotCard[]): RawSchedulerSnapshot {
  return {
    userId: "user-1",
    deckId: "deck-1",
    now: "2026-03-01T00:00:00.000Z",
    deckState: {
      desiredRetention: 0.9,
      policyVersion: "learning-engine-v1.0",
      hasAchievedFullMastery: false,
      masteredCount: 0,
      schedulerPosition: 10,
      lastCriticalDuePosition: null,
      schedulerRevision: 2,
      firstPassQueue: null,
      postMasteryShuffleBag: null,
    },
    dailyGoal: { enemiesDefeatedToday: 1, completed: false },
    cards,
    openClaim: null,
  };
}

describe("mapRawSchedulerSnapshot", () => {
  it("maps deck state, Daily Goal, and an empty card set", () => {
    const snapshot = mapRawSchedulerSnapshot(baseRaw([]));
    expect(snapshot.userId).toBe("user-1");
    expect(snapshot.deckId).toBe("deck-1");
    expect(snapshot.now).toEqual(new Date("2026-03-01T00:00:00.000Z"));
    expect(snapshot.deckState.schedulerPosition).toBe(10);
    expect(snapshot.deckState.schedulerRevision).toBe(2);
    expect(snapshot.dailyGoal).toEqual({ enemiesDefeatedToday: 1, completed: false });
    expect(snapshot.cards).toEqual([]);
  });

  it("defaults the Daily Goal when the RPC returns null (no daily_user_stats row yet today)", () => {
    const raw = baseRaw([]);
    const snapshot = mapRawSchedulerSnapshot({ ...raw, dailyGoal: null });
    expect(snapshot.dailyGoal).toEqual({ enemiesDefeatedToday: 0, completed: false });
  });

  it("normalizes an empty first-pass queue / shuffle bag to null", () => {
    const raw = baseRaw([]);
    const snapshot = mapRawSchedulerSnapshot({
      ...raw,
      deckState: { ...raw.deckState!, firstPassQueue: [], postMasteryShuffleBag: [] },
    });
    expect(snapshot.deckState.firstPassQueue).toBeNull();
    expect(snapshot.deckState.postMasteryShuffleBag).toBeNull();
  });

  it("maps a plain NEW card", () => {
    const snapshot = mapRawSchedulerSnapshot(baseRaw([baseCard({})]));
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards[0].cardStatus).toBe("NEW");
    expect(snapshot.cards[0].repairObligation).toBeNull();
  });

  it("maps a LEARNING card with a valid learningStage", () => {
    const raw = baseRaw([baseCard({ cardStatus: "LEARNING", learningStage: "LEARNING_1", poolStatus: "ACTIVE" })]);
    const snapshot = mapRawSchedulerSnapshot(raw);
    expect(snapshot.cards[0].learningStage).toBe("LEARNING_1");
  });

  it("rejects a LEARNING card with a null learningStage", () => {
    const raw = baseRaw([baseCard({ cardStatus: "LEARNING", learningStage: null })]);
    expect(() => mapRawSchedulerSnapshot(raw)).toThrow(SnapshotValidationError);
  });

  it("maps a complete within-day repair obligation (LEARNING + repairPending)", () => {
    const raw = baseRaw([
      baseCard({
        cardStatus: "LEARNING",
        learningStage: "FRESH",
        poolStatus: "ACTIVE",
        repairPending: true,
        repairWrongPosition: 5,
        repairTargetPosition: 9,
        repairHardCapPosition: 12,
      }),
    ]);
    const snapshot = mapRawSchedulerSnapshot(raw);
    expect(snapshot.cards[0].repairObligation).toEqual({
      cardId: "card-1",
      wrongPosition: 5,
      targetPosition: 9,
      hardCapPosition: 12,
    });
  });

  it("rejects repairPending=true with an incomplete repair position triple", () => {
    const raw = baseRaw([
      baseCard({
        cardStatus: "LEARNING",
        learningStage: "FRESH",
        poolStatus: "ACTIVE",
        repairPending: true,
        repairWrongPosition: 5,
        repairTargetPosition: null,
        repairHardCapPosition: 12,
      }),
    ]);
    expect(() => mapRawSchedulerSnapshot(raw)).toThrow(SnapshotValidationError);
  });

  it("rejects repairPending=false with non-null repair positions", () => {
    const raw = baseRaw([
      baseCard({
        cardStatus: "LEARNING",
        learningStage: "FRESH",
        poolStatus: "ACTIVE",
        repairPending: false,
        repairWrongPosition: 5,
        repairTargetPosition: 9,
        repairHardCapPosition: 12,
      }),
    ]);
    expect(() => mapRawSchedulerSnapshot(raw)).toThrow(SnapshotValidationError);
  });

  it("maps a complete FORGOTTEN + REPAIR_PENDING relearning state", () => {
    const raw = baseRaw([
      baseCard({
        cardStatus: "FORGOTTEN",
        poolStatus: "ACTIVE",
        relearningPhase: "REPAIR_PENDING",
        hasEverBeenMastered: true,
        repairPending: true,
        repairWrongPosition: 100,
        repairTargetPosition: 104,
        repairHardCapPosition: 107,
      }),
    ]);
    const snapshot = mapRawSchedulerSnapshot(raw);
    expect(snapshot.cards[0].repairObligation).not.toBeNull();
    expect(snapshot.cards[0].relearningPhase).toBe("REPAIR_PENDING");
  });

  it("maps a complete FORGOTTEN + SPACED_CONFIRMATION_PENDING relearning state", () => {
    const raw = baseRaw([
      baseCard({
        cardStatus: "FORGOTTEN",
        poolStatus: "ACTIVE",
        relearningPhase: "SPACED_CONFIRMATION_PENDING",
        hasEverBeenMastered: true,
        repairPending: false,
        correctCooldownUntilPosition: 120,
      }),
    ]);
    const snapshot = mapRawSchedulerSnapshot(raw);
    expect(snapshot.cards[0].repairObligation).toBeNull();
    expect(snapshot.cards[0].correctCooldownUntilPosition).toBe(120);
  });

  it("rejects a FORGOTTEN card with no relearningPhase at all", () => {
    const raw = baseRaw([baseCard({ cardStatus: "FORGOTTEN", poolStatus: "ACTIVE", relearningPhase: null })]);
    expect(() => mapRawSchedulerSnapshot(raw)).toThrow(SnapshotValidationError);
  });

  it("rejects FORGOTTEN + REPAIR_PENDING with repairPending=false (partial relearning state)", () => {
    const raw = baseRaw([
      baseCard({
        cardStatus: "FORGOTTEN",
        poolStatus: "ACTIVE",
        relearningPhase: "REPAIR_PENDING",
        repairPending: false,
      }),
    ]);
    expect(() => mapRawSchedulerSnapshot(raw)).toThrow(SnapshotValidationError);
  });

  it("rejects FORGOTTEN + SPACED_CONFIRMATION_PENDING with repairPending=true (obligation not yet cleared)", () => {
    const raw = baseRaw([
      baseCard({
        cardStatus: "FORGOTTEN",
        poolStatus: "ACTIVE",
        relearningPhase: "SPACED_CONFIRMATION_PENDING",
        repairPending: true,
        repairWrongPosition: 1,
        repairTargetPosition: 5,
        repairHardCapPosition: 8,
        correctCooldownUntilPosition: 20,
      }),
    ]);
    expect(() => mapRawSchedulerSnapshot(raw)).toThrow(SnapshotValidationError);
  });

  it("rejects FORGOTTEN + SPACED_CONFIRMATION_PENDING with no correctCooldownUntilPosition (missing the gate)", () => {
    const raw = baseRaw([
      baseCard({
        cardStatus: "FORGOTTEN",
        poolStatus: "ACTIVE",
        relearningPhase: "SPACED_CONFIRMATION_PENDING",
        repairPending: false,
        correctCooldownUntilPosition: null,
      }),
    ]);
    expect(() => mapRawSchedulerSnapshot(raw)).toThrow(SnapshotValidationError);
  });

  it("maps ACQUIRED with poolStatus OUTSIDE", () => {
    const raw = baseRaw([baseCard({ cardStatus: "ACQUIRED", poolStatus: "OUTSIDE" })]);
    expect(() => mapRawSchedulerSnapshot(raw)).not.toThrow();
  });

  it("rejects ACQUIRED with poolStatus other than OUTSIDE", () => {
    const raw = baseRaw([baseCard({ cardStatus: "ACQUIRED", poolStatus: "ACTIVE" })]);
    expect(() => mapRawSchedulerSnapshot(raw)).toThrow(SnapshotValidationError);
  });

  it("rejects LEARNED with poolStatus other than OUTSIDE", () => {
    const raw = baseRaw([baseCard({ cardStatus: "LEARNED", poolStatus: null, hasEverBeenMastered: true })]);
    expect(() => mapRawSchedulerSnapshot(raw)).toThrow(SnapshotValidationError);
  });

  it("delegates FSRS mapping to the existing adapter (a fully-populated FSRS row maps to a non-empty Card)", () => {
    const raw = baseRaw([
      baseCard({
        cardStatus: "ACQUIRED",
        poolStatus: "OUTSIDE",
        fsrsState: 2,
        fsrsDueAt: "2026-04-01T00:00:00.000Z",
        fsrsStability: 5.2,
        fsrsDifficulty: 4.1,
        fsrsLastReviewAt: "2026-03-01T00:00:00.000Z",
      }),
    ]);
    const snapshot = mapRawSchedulerSnapshot(raw);
    expect(snapshot.cards[0].fsrsCard.stability).toBeCloseTo(5.2, 5);
    expect(snapshot.cards[0].fsrsCard.state).toBe(2);
  });

  it("throws (via the FSRS adapter) for a partially-populated uninitialized FSRS row, never silently repairing it", () => {
    const raw = baseRaw([
      baseCard({
        fsrsState: null,
        fsrsStability: 5.2, // unexpectedly populated alongside a null fsrsState
      }),
    ]);
    expect(() => mapRawSchedulerSnapshot(raw)).toThrow();
  });

  it("throws a plain Error (not SnapshotValidationError) when deckState is null", () => {
    const raw = { ...baseRaw([]), deckState: null };
    expect(() => mapRawSchedulerSnapshot(raw)).toThrow(/deckState is null/);
  });
});
