import { describe, expect, it } from "vitest";
import { createEmptyCard, fsrs, Rating, State } from "ts-fsrs";
import type { Card, Grade } from "ts-fsrs";

import { FSRS_CONFIG } from "@/lib/learning/config";
import {
  advanceFsrs,
  fsrsCardToUpdate,
  progressToFsrsCard,
  type FsrsStateValue,
  type UserCardProgressFsrsRow,
} from "@/lib/learning/fsrs";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const NEW_ROW: UserCardProgressFsrsRow = {
  fsrs_due_at: null,
  fsrs_stability: null,
  fsrs_difficulty: null,
  fsrs_elapsed_days: 0,
  fsrs_scheduled_days: 0,
  fsrs_reps: 0,
  fsrs_lapses: 0,
  fsrs_learning_steps: 0,
  fsrs_state: null,
  fsrs_last_review_at: null,
};

// Dates are deliberately before NOW (2026-01-01): fsrs_last_review_at must
// never be after the `now` a test advances with, or ts-fsrs's next_state
// rejects the resulting negative elapsed-days delta_t.
const INITIALIZED_ROW: UserCardProgressFsrsRow = {
  fsrs_due_at: new Date("2025-12-28T12:00:00.000Z"),
  fsrs_stability: 8.2956,
  fsrs_difficulty: 5.113,
  fsrs_elapsed_days: 3,
  fsrs_scheduled_days: 10,
  fsrs_reps: 2,
  fsrs_lapses: 1,
  fsrs_learning_steps: 0,
  fsrs_state: 2, // State.Review
  fsrs_last_review_at: new Date("2025-12-18T09:30:00.000Z"),
};

describe("progressToFsrsCard", () => {
  it("maps a brand-new (never-reviewed) row to ts-fsrs's own empty-card shape", () => {
    const card = progressToFsrsCard(NEW_ROW, NOW);
    const expected = createEmptyCard(NOW);

    expect(card).toEqual(expected);
    expect(card.state).toBe(State.New);
    expect(card.last_review).toBeUndefined();
  });

  it("does not fabricate history for a new card -- reps/lapses/learning_steps stay 0", () => {
    const card = progressToFsrsCard(NEW_ROW, NOW);
    expect(card.reps).toBe(0);
    expect(card.lapses).toBe(0);
    expect(card.learning_steps).toBe(0);
  });

  it("maps every DB FSRS field into the expected Card field for an initialized row", () => {
    const card = progressToFsrsCard(INITIALIZED_ROW, NOW);

    expect(card.due).toBe(INITIALIZED_ROW.fsrs_due_at);
    expect(card.stability).toBe(INITIALIZED_ROW.fsrs_stability);
    expect(card.difficulty).toBe(INITIALIZED_ROW.fsrs_difficulty);
    expect(card.elapsed_days).toBe(INITIALIZED_ROW.fsrs_elapsed_days);
    expect(card.scheduled_days).toBe(INITIALIZED_ROW.fsrs_scheduled_days);
    expect(card.reps).toBe(INITIALIZED_ROW.fsrs_reps);
    expect(card.lapses).toBe(INITIALIZED_ROW.fsrs_lapses);
    expect(card.learning_steps).toBe(INITIALIZED_ROW.fsrs_learning_steps);
    expect(card.state).toBe(INITIALIZED_ROW.fsrs_state);
    expect(card.last_review).toBe(INITIALIZED_ROW.fsrs_last_review_at);
  });

  it("round-trips learning_steps for a nonzero value", () => {
    const row: UserCardProgressFsrsRow = { ...INITIALIZED_ROW, fsrs_learning_steps: 1 };
    expect(progressToFsrsCard(row, NOW).learning_steps).toBe(1);
  });

  it.each([0, 1, 2, 3] as const)("round-trips fsrs_state=%i", (stateValue) => {
    const row: UserCardProgressFsrsRow = { ...INITIALIZED_ROW, fsrs_state: stateValue };
    expect(progressToFsrsCard(row, NOW).state).toBe(stateValue);
  });

  it("round-trips due/last_review timestamps exactly", () => {
    const card = progressToFsrsCard(INITIALIZED_ROW, NOW);
    expect(card.due.getTime()).toBe(INITIALIZED_ROW.fsrs_due_at!.getTime());
    expect(card.last_review?.getTime()).toBe(INITIALIZED_ROW.fsrs_last_review_at!.getTime());
  });

  it.each([
    ["fsrs_due_at", { fsrs_due_at: null }],
    ["fsrs_stability", { fsrs_stability: null }],
    ["fsrs_difficulty", { fsrs_difficulty: null }],
    ["fsrs_last_review_at", { fsrs_last_review_at: null }],
  ] as const)(
    "throws if fsrs_state is non-null but %s is unexpectedly null (inconsistent row)",
    (fieldName, override) => {
      const corruptRow: UserCardProgressFsrsRow = { ...INITIALIZED_ROW, ...override };
      expect(() => progressToFsrsCard(corruptRow, NOW)).toThrow(new RegExp(fieldName));
    },
  );

  describe("partially-corrupted uninitialized (fsrs_state === null) row", () => {
    it.each([
      ["fsrs_due_at", { fsrs_due_at: new Date("2026-06-01T00:00:00.000Z") }],
      ["fsrs_stability", { fsrs_stability: 1.5 }],
      ["fsrs_difficulty", { fsrs_difficulty: 3.2 }],
      ["fsrs_last_review_at", { fsrs_last_review_at: new Date("2025-12-01T00:00:00.000Z") }],
    ] as const)(
      "throws if fsrs_state is null but %s is unexpectedly populated",
      (fieldName, override) => {
        const corruptRow: UserCardProgressFsrsRow = { ...NEW_ROW, ...override };
        expect(() => progressToFsrsCard(corruptRow, NOW)).toThrow(new RegExp(fieldName));
      },
    );

    it("does not discard the partial state or fabricate a clean empty card (throws, no fallback value)", () => {
      const corruptRow: UserCardProgressFsrsRow = { ...NEW_ROW, fsrs_stability: 1.5 };
      expect(() => progressToFsrsCard(corruptRow, NOW)).toThrow();
    });

    it("does NOT require the legitimate default counters to be exactly 0 (not a schema-backed invariant)", () => {
      // fsrs_reps/lapses/learning_steps/elapsed_days/scheduled_days are NOT NULL
      // with their own independent default of 0 -- their nullability isn't tied
      // to fsrs_state, so a nonzero counter alongside fsrs_state === null must
      // not throw (only the four genuinely-nullable fields are checked).
      const row: UserCardProgressFsrsRow = {
        ...NEW_ROW,
        fsrs_reps: 2,
        fsrs_lapses: 1,
        fsrs_learning_steps: 1,
        fsrs_elapsed_days: 5,
        fsrs_scheduled_days: 7,
      };
      expect(() => progressToFsrsCard(row, NOW)).not.toThrow();
      expect(progressToFsrsCard(row, NOW)).toEqual(createEmptyCard(NOW));
    });
  });
});

describe("fsrsCardToUpdate", () => {
  const card: Card = {
    due: new Date("2026-03-01T00:00:00.000Z"),
    stability: 9.5,
    difficulty: 4.2,
    elapsed_days: 5,
    scheduled_days: 12,
    reps: 3,
    lapses: 1,
    learning_steps: 0,
    state: State.Review,
    last_review: new Date("2026-02-17T00:00:00.000Z"),
  };

  it("maps every Card field into the expected DB column", () => {
    const update = fsrsCardToUpdate(card);
    expect(update).toEqual({
      fsrs_due_at: card.due,
      fsrs_stability: card.stability,
      fsrs_difficulty: card.difficulty,
      fsrs_elapsed_days: card.elapsed_days,
      fsrs_scheduled_days: card.scheduled_days,
      fsrs_reps: card.reps,
      fsrs_lapses: card.lapses,
      fsrs_learning_steps: card.learning_steps,
      fsrs_state: card.state,
      fsrs_last_review_at: card.last_review,
    });
  });

  it.each([State.New, State.Learning, State.Review, State.Relearning])(
    "round-trips state=%i",
    (state) => {
      const update = fsrsCardToUpdate({ ...card, state });
      expect(update.fsrs_state).toBe(state as FsrsStateValue);
    },
  );

  it("throws if last_review is missing (violates the post-advance guarantee)", () => {
    const cardWithoutReview: Card = { ...card, last_review: undefined };
    expect(() => fsrsCardToUpdate(cardWithoutReview)).toThrow(/last_review/);
  });
});

describe("advanceFsrs", () => {
  it("can advance a brand-new card successfully with no thrown error", () => {
    const card = progressToFsrsCard(NEW_ROW, NOW);
    expect(() => advanceFsrs(card, NOW, Rating.Good)).not.toThrow();
  });

  it("does not mutate its input card", () => {
    const card = progressToFsrsCard(INITIALIZED_ROW, NOW);
    const snapshot = structuredClone(card);

    advanceFsrs(card, NOW, Rating.Good);

    expect(card).toEqual(snapshot);
  });

  describe.each([
    ["Again", Rating.Again],
    ["Hard", Rating.Hard],
    ["Good", Rating.Good],
    ["Easy", Rating.Easy],
  ] as const)("grade %s on a brand-new card", (_name, grade) => {
    const card = progressToFsrsCard(NEW_ROW, NOW);
    const update = advanceFsrs(card, NOW, grade);

    it("produces a valid next state within the four known FSRS states", () => {
      expect([0, 1, 2, 3]).toContain(update.fsrs_state);
    });

    it("produces finite, non-negative stability/difficulty/elapsed/scheduled/reps/lapses/learning_steps", () => {
      expect(Number.isFinite(update.fsrs_stability)).toBe(true);
      expect(update.fsrs_stability).toBeGreaterThan(0);
      expect(Number.isFinite(update.fsrs_difficulty)).toBe(true);
      expect(update.fsrs_elapsed_days).toBeGreaterThanOrEqual(0);
      expect(update.fsrs_scheduled_days).toBeGreaterThanOrEqual(0);
      expect(update.fsrs_reps).toBeGreaterThanOrEqual(0);
      expect(update.fsrs_lapses).toBeGreaterThanOrEqual(0);
      expect(update.fsrs_learning_steps).toBeGreaterThanOrEqual(0);
    });

    it("is a first review: reps becomes 1, lapses stays 0 (no fake prior history)", () => {
      expect(update.fsrs_reps).toBe(1);
      expect(update.fsrs_lapses).toBe(0);
    });

    it("sets fsrs_due_at strictly after fsrs_last_review_at", () => {
      expect(update.fsrs_due_at.getTime()).toBeGreaterThan(update.fsrs_last_review_at.getTime());
    });

    it("sets fsrs_last_review_at to the supplied `now`", () => {
      expect(update.fsrs_last_review_at.getTime()).toBe(NOW.getTime());
    });
  });

  it("Easy on a brand-new card reaches Review state directly (ts-fsrs 5.4.2 short-term behavior)", () => {
    const card = progressToFsrsCard(NEW_ROW, NOW);
    const update = advanceFsrs(card, NOW, Rating.Easy);
    expect(update.fsrs_state).toBe(State.Review);
  });

  it("Again/Hard/Good on a brand-new card land in Learning state (ts-fsrs 5.4.2 short-term behavior)", () => {
    const card = progressToFsrsCard(NEW_ROW, NOW);
    for (const grade of [Rating.Again, Rating.Hard, Rating.Good] as const) {
      expect(advanceFsrs(card, NOW, grade).fsrs_state).toBe(State.Learning);
    }
  });

  it("a lapse on a mature Review-state card increments lapses and moves to Relearning", () => {
    // Build a mature card by repeatedly advancing with Good until it reaches Review
    // state -- each round-trips the previous update straight back through
    // progressToFsrsCard, since UserCardProgressFsrsUpdate is structurally a
    // (fully non-null) UserCardProgressFsrsRow.
    let card: Card = progressToFsrsCard(NEW_ROW, NOW);
    let now = NOW;
    for (let i = 0; i < 3; i++) {
      const update = advanceFsrs(card, now, Rating.Good);
      now = update.fsrs_due_at;
      card = progressToFsrsCard(update, now);
    }
    expect(card.state).toBe(State.Review);
    const lapsesBefore = card.lapses;

    const afterLapse = advanceFsrs(card, now, Rating.Again);

    expect(afterLapse.fsrs_state).toBe(State.Relearning);
    expect(afterLapse.fsrs_lapses).toBe(lapsesBefore + 1);
  });

  it("rejects Rating.Manual even when the type boundary is bypassed (defense-in-depth)", () => {
    const card = progressToFsrsCard(NEW_ROW, NOW);
    expect(() => advanceFsrs(card, NOW, Rating.Manual as unknown as Grade)).toThrow(/Manual/);
  });

  it("uses the approved FSRS_CONFIG (matches a reference scheduler built from the same config)", () => {
    const referenceScheduler = fsrs(FSRS_CONFIG);
    const card = progressToFsrsCard(INITIALIZED_ROW, NOW);

    const { card: referenceNext } = referenceScheduler.next(card, NOW, Rating.Good);
    const update = advanceFsrs(card, NOW, Rating.Good);

    expect(update.fsrs_stability).toBe(referenceNext.stability);
    expect(update.fsrs_difficulty).toBe(referenceNext.difficulty);
    expect(update.fsrs_state).toBe(referenceNext.state);
  });
});
