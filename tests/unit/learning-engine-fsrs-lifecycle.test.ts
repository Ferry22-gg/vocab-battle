import { describe, expect, it } from "vitest";
import { createEmptyCard, Rating } from "ts-fsrs";
import type { Card } from "ts-fsrs";

import {
  resolveLongTermWrong,
  resolveNearDueCorrect,
  resolveNearDueWrong,
  resolveQualifyingFsrsCorrect,
  resolveRandomMasteredCorrect,
  resolveRandomMasteredWrong,
  type ResolveFsrsAnswerInput,
} from "@/lib/learning-engine/fsrs/lifecycle";
import { progressToFsrsCard, type UserCardProgressFsrsUpdate } from "@/lib/learning-engine/fsrs/adapter";
import { createRepairObligation } from "@/lib/learning-engine/repair-scheduler";
import { applyRelearningRepairCorrect, applySpacedCorrect } from "@/lib/learning-engine/transitions";
import { INITIAL_CARD_STATE, type LearningEngineCardState } from "@/lib/learning-engine/state";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 15,
 * 16.2, 16.3, 34.3 (Phase 5: FSRS lifecycle integration and mastery-
 * counter orchestration).
 */

const NOW = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-01-05T00:00:00.000Z");
const LATER_STILL = new Date("2026-01-12T00:00:00.000Z");

function outsideCard(overrides: Partial<LearningEngineCardState> = {}): LearningEngineCardState {
  return { ...INITIAL_CARD_STATE, cardStatus: "ACQUIRED", poolStatus: "OUTSIDE", ...overrides };
}

function learnedCard(overrides: Partial<LearningEngineCardState> = {}): LearningEngineCardState {
  return { ...INITIAL_CARD_STATE, cardStatus: "LEARNED", poolStatus: "OUTSIDE", hasEverBeenMastered: true, ...overrides };
}

function nextFsrsCard(update: UserCardProgressFsrsUpdate, now: Date): Card {
  return progressToFsrsCard(update, now);
}

const freshCard: Card = createEmptyCard(NOW);

describe("resolveQualifyingFsrsCorrect (section 15.1-15.2)", () => {
  it("11. increments count and streak", () => {
    const result = resolveQualifyingFsrsCorrect({ card: freshCard, cardState: outsideCard(), now: NOW, desiredRetention: 0.9 });
    expect(result.cardState.fsrsReviewCorrectCount).toBe(1);
    expect(result.cardState.fsrsReviewCorrectStreak).toBe(1);
    expect(result.cardState.cardStatus).toBe("ACQUIRED");
  });

  it("12. count=3, streak=1 -> not Mastered", () => {
    const result = resolveQualifyingFsrsCorrect({
      card: freshCard,
      cardState: outsideCard({ fsrsReviewCorrectCount: 2, fsrsReviewCorrectStreak: 0 }),
      now: NOW,
      desiredRetention: 0.9,
    });
    expect(result.cardState.fsrsReviewCorrectCount).toBe(3);
    expect(result.cardState.fsrsReviewCorrectStreak).toBe(1);
    expect(result.cardState.cardStatus).toBe("ACQUIRED");
  });

  it("13. count=2, streak=2 -> not Mastered", () => {
    const result = resolveQualifyingFsrsCorrect({
      card: freshCard,
      cardState: outsideCard({ fsrsReviewCorrectCount: 1, fsrsReviewCorrectStreak: 1 }),
      now: NOW,
      desiredRetention: 0.9,
    });
    expect(result.cardState.fsrsReviewCorrectCount).toBe(2);
    expect(result.cardState.fsrsReviewCorrectStreak).toBe(2);
    expect(result.cardState.cardStatus).toBe("ACQUIRED");
  });

  it("14. count=3, streak=2 -> Mastered", () => {
    const result = resolveQualifyingFsrsCorrect({
      card: freshCard,
      cardState: outsideCard({ fsrsReviewCorrectCount: 2, fsrsReviewCorrectStreak: 1 }),
      now: NOW,
      desiredRetention: 0.9,
    });
    expect(result.cardState.fsrsReviewCorrectCount).toBe(3);
    expect(result.cardState.fsrsReviewCorrectStreak).toBe(2);
    expect(result.cardState.cardStatus).toBe("LEARNED");
    expect(result.cardState.hasEverBeenMastered).toBe(true);
  });

  it("the fsrs update is a real ts-fsrs advance, not a stub -- due date moves into the future and state leaves New", () => {
    const result = resolveQualifyingFsrsCorrect({ card: freshCard, cardState: outsideCard(), now: NOW, desiredRetention: 0.9 });
    expect(result.fsrsUpdate.fsrs_due_at.getTime()).toBeGreaterThan(NOW.getTime());
    expect(result.fsrsUpdate.fsrs_state).not.toBe(0); // 0 = State.New
  });

  it("throws if called on a card not ACQUIRED/LEARNED+OUTSIDE (e.g. a within-day Active card)", () => {
    expect(() =>
      resolveQualifyingFsrsCorrect({ card: freshCard, cardState: INITIAL_CARD_STATE, now: NOW, desiredRetention: 0.9 }),
    ).toThrow(/requires cardStatus ACQUIRED or LEARNED/);
  });
});

describe("15. full sequence: Correct, Correct, Wrong, Correct, Correct -> count=4, streak=2, Mastered=true", () => {
  it("reproduces the Phase 2 acceptance scenario through the real FSRS-integrated orchestration", () => {
    let cardState = outsideCard();
    let card = freshCard;

    const r1 = resolveQualifyingFsrsCorrect({ card, cardState, now: NOW, desiredRetention: 0.9 });
    cardState = r1.cardState;
    card = nextFsrsCard(r1.fsrsUpdate, LATER);
    expect([cardState.fsrsReviewCorrectCount, cardState.fsrsReviewCorrectStreak]).toEqual([1, 1]);

    const r2 = resolveQualifyingFsrsCorrect({ card, cardState, now: LATER, desiredRetention: 0.9 });
    cardState = r2.cardState;
    card = nextFsrsCard(r2.fsrsUpdate, LATER_STILL);
    expect([cardState.fsrsReviewCorrectCount, cardState.fsrsReviewCorrectStreak]).toEqual([2, 2]);

    // Wrong: FSRS receives Again; lifecycle moves to FORGOTTEN/ACTIVE/REPAIR_PENDING.
    const r3 = resolveLongTermWrong({ card, cardState, now: LATER_STILL, desiredRetention: 0.9 });
    cardState = r3.cardState;
    expect(cardState.cardStatus).toBe("FORGOTTEN");
    expect([cardState.fsrsReviewCorrectCount, cardState.fsrsReviewCorrectStreak]).toEqual([2, 0]);

    // Relearning detour (Phase 2/4 -- no FSRS involvement, per section 13's
    // repair mechanics being position-governed, not FSRS-governed). The
    // FSRS card itself does not advance again until the next qualifying
    // review below.
    cardState = applyRelearningRepairCorrect(cardState);
    cardState = applySpacedCorrect(cardState);
    expect(cardState.cardStatus).toBe("ACQUIRED"); // never-before-mastered -> must re-earn
    card = nextFsrsCard(r3.fsrsUpdate, new Date("2026-01-20T00:00:00.000Z"));

    const r4 = resolveQualifyingFsrsCorrect({ card, cardState, now: new Date("2026-01-20T00:00:00.000Z"), desiredRetention: 0.9 });
    cardState = r4.cardState;
    card = nextFsrsCard(r4.fsrsUpdate, new Date("2026-01-28T00:00:00.000Z"));
    expect([cardState.fsrsReviewCorrectCount, cardState.fsrsReviewCorrectStreak]).toEqual([3, 1]);
    expect(cardState.cardStatus).toBe("ACQUIRED");

    const r5 = resolveQualifyingFsrsCorrect({ card, cardState, now: new Date("2026-01-28T00:00:00.000Z"), desiredRetention: 0.9 });
    cardState = r5.cardState;
    expect(cardState.fsrsReviewCorrectCount).toBe(4);
    expect(cardState.fsrsReviewCorrectStreak).toBe(2);
    expect(cardState.cardStatus).toBe("LEARNED");
    expect(cardState.hasEverBeenMastered).toBe(true);
  });
});

describe("resolveLongTermWrong (sections 16.3, 34.3)", () => {
  it("16. preserves count and resets streak", () => {
    const result = resolveLongTermWrong({
      card: freshCard,
      cardState: outsideCard({ fsrsReviewCorrectCount: 5, fsrsReviewCorrectStreak: 3 }),
      now: NOW,
      desiredRetention: 0.9,
    });
    expect(result.cardState.fsrsReviewCorrectCount).toBe(5);
    expect(result.cardState.fsrsReviewCorrectStreak).toBe(0);
  });

  it("17. enters FORGOTTEN / ACTIVE / REPAIR_PENDING", () => {
    const result = resolveLongTermWrong({ card: freshCard, cardState: outsideCard(), now: NOW, desiredRetention: 0.9 });
    expect(result.cardState.cardStatus).toBe("FORGOTTEN");
    expect(result.cardState.poolStatus).toBe("ACTIVE");
    expect(result.cardState.relearningPhase).toBe("REPAIR_PENDING");
  });

  it("sends Again to FSRS", () => {
    const result = resolveLongTermWrong({ card: freshCard, cardState: outsideCard(), now: NOW, desiredRetention: 0.9 });
    expect(result.grade).toBe(Rating.Again);
  });

  it("20. has_ever_been_mastered remains true after a lapse on a previously-mastered card", () => {
    const result = resolveLongTermWrong({
      card: freshCard,
      cardState: learnedCard({ fsrsReviewCorrectCount: 6, fsrsReviewCorrectStreak: 4 }),
      now: NOW,
      desiredRetention: 0.9,
    });
    expect(result.cardState.cardStatus).toBe("FORGOTTEN");
    expect(result.cardState.hasEverBeenMastered).toBe(true);
    expect(result.cardState.fsrsReviewCorrectCount).toBe(6); // preserved
  });

  it("throws if called on a card not ACQUIRED/LEARNED+OUTSIDE", () => {
    expect(() => resolveLongTermWrong({ card: freshCard, cardState: INITIAL_CARD_STATE, now: NOW, desiredRetention: 0.9 })).toThrow(
      /requires cardStatus ACQUIRED or LEARNED/,
    );
  });

  it("worked composition with Phase 4: the caller completes the implied repair obligation with createRepairObligation, using its own position/RNG context (not this module's job)", () => {
    const result = resolveLongTermWrong({ card: freshCard, cardState: outsideCard(), now: NOW, desiredRetention: 0.9 });
    expect(result.cardState.relearningPhase).toBe("REPAIR_PENDING");

    const wrongPosition = 42;
    const obligation = createRepairObligation({ cardId: "card-x", wrongPosition, random: () => 0.1 });
    expect(obligation.targetPosition).toBeGreaterThanOrEqual(wrongPosition + 4);
    expect(obligation.hardCapPosition).toBe(wrongPosition + 7);
  });
});

describe("resolveNearDueWrong (section 16.3) -- same function as resolveLongTermWrong", () => {
  it("19. enters Relearning and preserves cumulative count, identically to a qualifying FSRS_DUE Wrong", () => {
    const input: ResolveFsrsAnswerInput = {
      card: freshCard,
      cardState: outsideCard({ fsrsReviewCorrectCount: 3, fsrsReviewCorrectStreak: 2 }),
      now: NOW,
      desiredRetention: 0.9,
    };
    const nearDueResult = resolveNearDueWrong(input);
    const longTermResult = resolveLongTermWrong(input);
    expect(nearDueResult.cardState).toEqual(longTermResult.cardState);
  });

  it("is literally the same function reference -- no second Relearning implementation exists", () => {
    expect(resolveNearDueWrong).toBe(resolveLongTermWrong);
  });
});

describe("resolveNearDueCorrect (section 16.2)", () => {
  it("18. does not increment mastery count or streak", () => {
    const cardState = outsideCard({ fsrsReviewCorrectCount: 2, fsrsReviewCorrectStreak: 1 });
    const result = resolveNearDueCorrect({ card: freshCard, cardState, now: NOW, desiredRetention: 0.9 });
    expect(result.cardState.fsrsReviewCorrectCount).toBe(2);
    expect(result.cardState.fsrsReviewCorrectStreak).toBe(1);
  });

  it("an ACQUIRED card is never promoted to LEARNED by a Near-Due success, even with threshold-meeting counters", () => {
    const cardState = outsideCard({ fsrsReviewCorrectCount: 3, fsrsReviewCorrectStreak: 2 }); // already at the Mastery threshold
    const result = resolveNearDueCorrect({ card: freshCard, cardState, now: NOW, desiredRetention: 0.9 });
    expect(result.cardState.cardStatus).toBe("ACQUIRED"); // not promoted -- counters didn't change, and promotion only happens inside applyQualifyingFsrsCorrect, never called here
  });

  it("an already-LEARNED card stays LEARNED", () => {
    const cardState = learnedCard({ fsrsReviewCorrectCount: 5, fsrsReviewCorrectStreak: 3 });
    const result = resolveNearDueCorrect({ card: freshCard, cardState, now: NOW, desiredRetention: 0.9 });
    expect(result.cardState.cardStatus).toBe("LEARNED");
  });

  it("cardState is returned byte-for-byte unchanged (no lifecycle transition at all, only FSRS timing updates)", () => {
    const cardState = outsideCard({ fsrsReviewCorrectCount: 1, fsrsReviewCorrectStreak: 1 });
    const result = resolveNearDueCorrect({ card: freshCard, cardState, now: NOW, desiredRetention: 0.9 });
    expect(result.cardState).toEqual(cardState);
    expect(result.cardState).toBe(cardState); // same reference -- not even a shallow copy was needed
  });

  it("FSRS schedule genuinely still updates (the review is not a no-op, only the lifecycle counters are untouched)", () => {
    const result = resolveNearDueCorrect({ card: freshCard, cardState: outsideCard(), now: NOW, desiredRetention: 0.9 });
    expect(result.fsrsUpdate.fsrs_due_at.getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe("21. existing FSRS history compatibility (historical Hard/Easy-era D/S is not reset)", () => {
  it("a card with historical stability/difficulty from the legacy Hard/Easy-inference era advances FROM those values, not from a reset baseline", () => {
    // Simulates a row whose fsrs_stability/fsrs_difficulty were produced
    // under the legacy Hard/Easy estimator (lib/learning/rating.ts) before
    // this phase existed -- values a pure binary-only history would be
    // very unlikely to produce on its own, standing in for "real"
    // historical data.
    const legacyRow = {
      fsrs_due_at: new Date("2025-12-20T00:00:00.000Z"),
      fsrs_stability: 47.3291,
      fsrs_difficulty: 2.1105,
      fsrs_elapsed_days: 12,
      fsrs_scheduled_days: 30,
      fsrs_reps: 8,
      fsrs_lapses: 1,
      fsrs_learning_steps: 0,
      fsrs_state: 2 as const, // State.Review
      fsrs_last_review_at: new Date("2025-12-20T00:00:00.000Z"),
    };

    const card = progressToFsrsCard(legacyRow, NOW);
    // The Card ts-fsrs will actually advance from carries the exact
    // historical values forward -- nothing in this phase's new code
    // path resets them.
    expect(card.stability).toBe(47.3291);
    expect(card.difficulty).toBe(2.1105);
    expect(card.reps).toBe(8);
    expect(card.lapses).toBe(1);

    const cardState = outsideCard({ fsrsReviewCorrectCount: 1, fsrsReviewCorrectStreak: 1 });
    const result = resolveQualifyingFsrsCorrect({ card, cardState, now: NOW, desiredRetention: 0.9 });

    // The resulting stability is a real FSRS computation derived FROM
    // 47.3291 (ts-fsrs increases stability on a Good review from an
    // established card) -- not reset to a fresh-card baseline, and not
    // equal to what a brand-new card would produce for the same grade.
    const freshResult = resolveQualifyingFsrsCorrect({ card: freshCard, cardState, now: NOW, desiredRetention: 0.9 });
    expect(result.fsrsUpdate.fsrs_stability).not.toBe(freshResult.fsrsUpdate.fsrs_stability);
    expect(result.fsrsUpdate.fsrs_reps).toBe(9); // 8 + 1, carried forward
    expect(result.fsrsUpdate.fsrs_lapses).toBe(1); // untouched by a Correct review
  });

  it("binary grading (this phase) and historical Hard/Easy grading (legacy) produce structurally identical row shapes -- no migration/reset is needed for the switch itself", () => {
    const result = resolveQualifyingFsrsCorrect({ card: freshCard, cardState: outsideCard(), now: NOW, desiredRetention: 0.9 });
    expect(result.fsrsUpdate).toMatchObject({
      fsrs_due_at: expect.any(Date),
      fsrs_stability: expect.any(Number),
      fsrs_difficulty: expect.any(Number),
      fsrs_state: expect.any(Number),
    });
  });
});

describe("22. deterministic/pure helpers produce reproducible results", () => {
  it("identical inputs to resolveQualifyingFsrsCorrect produce identical output", () => {
    const run = () =>
      resolveQualifyingFsrsCorrect({
        card: { ...freshCard },
        cardState: outsideCard({ fsrsReviewCorrectCount: 1, fsrsReviewCorrectStreak: 1 }),
        now: NOW,
        desiredRetention: 0.9,
      });
    expect(run()).toEqual(run());
  });

  it("does not mutate its input card or cardState", () => {
    const card = { ...freshCard };
    const cardBefore = { ...card };
    const cardState = outsideCard();
    const cardStateBefore = { ...cardState };

    resolveQualifyingFsrsCorrect({ card, cardState, now: NOW, desiredRetention: 0.9 });

    expect(card).toEqual(cardBefore);
    expect(cardState).toEqual(cardStateBefore);
  });
});

/**
 * Phase 7 (Post-Mastery) brief, reviewed correction (sections 14-15):
 * "RANDOM_MASTERED Correct is NOT a true no-op... treat it as an
 * early/optional FSRS review" and "RANDOM_MASTERED Wrong: reuse the full
 * long-term lapse lifecycle." resolveRandomMasteredCorrect/Wrong are plain
 * aliases for resolveNearDueCorrect/resolveLongTermWrong respectively (no
 * second FSRS implementation) -- these tests prove the aliased behavior
 * end-to-end from the Random Mastered call site's own perspective.
 */
describe("resolveRandomMasteredCorrect (Phase 7 brief section 14)", () => {
  it("is literally the same function reference as resolveNearDueCorrect -- no second FSRS implementation", () => {
    expect(resolveRandomMasteredCorrect).toBe(resolveNearDueCorrect);
  });

  it("7. maps Correct to FSRS Good", () => {
    const result = resolveRandomMasteredCorrect({ card: freshCard, cardState: learnedCard(), now: NOW, desiredRetention: 0.9 });
    expect(result.grade).toBe(Rating.Good);
  });

  it("8-9, 14. the FSRS state changes using the actual elapsed-time event -- not a no-op, and the schedule differs when the review happens later", () => {
    const soon = resolveRandomMasteredCorrect({ card: freshCard, cardState: learnedCard(), now: NOW, desiredRetention: 0.9 });
    const later = resolveRandomMasteredCorrect({ card: freshCard, cardState: learnedCard(), now: LATER, desiredRetention: 0.9 });

    // Not a no-op: the update actually advances stability/due relative to the untouched input card.
    expect(soon.fsrsUpdate.fsrs_stability).not.toBe(freshCard.stability);
    expect(soon.fsrsUpdate.fsrs_due_at.getTime()).not.toBe(freshCard.due.getTime());

    // Uses the ACTUAL elapsed time of the event: reviewing later produces a
    // different schedule than reviewing sooner, given the same input card.
    expect(later.fsrsUpdate.fsrs_due_at.getTime()).not.toBe(soon.fsrsUpdate.fsrs_due_at.getTime());
    expect(nextFsrsCard(soon.fsrsUpdate, NOW).last_review?.getTime()).toBe(NOW.getTime());
    expect(nextFsrsCard(later.fsrsUpdate, LATER).last_review?.getTime()).toBe(LATER.getTime());
  });

  it("10-13, 15. mastery counters and cardStatus are untouched -- never routed through applyQualifyingFsrsCorrect, even at the Mastery threshold", () => {
    const cardState = learnedCard({ fsrsReviewCorrectCount: 3, fsrsReviewCorrectStreak: 2 }); // already at/past the Mastery threshold
    const result = resolveRandomMasteredCorrect({ card: freshCard, cardState, now: NOW, desiredRetention: 0.9 });

    expect(result.cardState.fsrsReviewCorrectCount).toBe(3); // 10. unchanged
    expect(result.cardState.fsrsReviewCorrectStreak).toBe(2); // 11. unchanged
    expect(result.cardState.cardStatus).toBe("LEARNED"); // 12. remains LEARNED (was already)
    expect(result.cardState.hasEverBeenMastered).toBe(true); // 13. remains true
    expect(result.cardState).toEqual(cardState); // 15. byte-for-byte identical cardState -- proves no mastery transition ran
  });

  it("throws if called on a card not ACQUIRED/LEARNED+OUTSIDE (a Random Mastered candidate is always LEARNED+OUTSIDE by construction)", () => {
    expect(() => resolveRandomMasteredCorrect({ card: freshCard, cardState: INITIAL_CARD_STATE, now: NOW, desiredRetention: 0.9 })).toThrow(
      /requires cardStatus ACQUIRED or LEARNED/,
    );
  });
});

describe("resolveRandomMasteredWrong (Phase 7 brief section 15)", () => {
  it("is literally the same function reference as resolveLongTermWrong -- no lighter free-play-specific failure state machine", () => {
    expect(resolveRandomMasteredWrong).toBe(resolveLongTermWrong);
  });

  it("16. maps Wrong to FSRS Again", () => {
    const result = resolveRandomMasteredWrong({ card: freshCard, cardState: learnedCard(), now: NOW, desiredRetention: 0.9 });
    expect(result.grade).toBe(Rating.Again);
  });

  it("17. enters FORGOTTEN / ACTIVE / REPAIR_PENDING, the full long-term lapse", () => {
    const result = resolveRandomMasteredWrong({ card: freshCard, cardState: learnedCard(), now: NOW, desiredRetention: 0.9 });
    expect(result.cardState.cardStatus).toBe("FORGOTTEN");
    expect(result.cardState.poolStatus).toBe("ACTIVE");
    expect(result.cardState.relearningPhase).toBe("REPAIR_PENDING");
  });

  it("18-20. cumulative mastery count preserved, streak reset, has_ever_been_mastered remains true", () => {
    const result = resolveRandomMasteredWrong({
      card: freshCard,
      cardState: learnedCard({ fsrsReviewCorrectCount: 6, fsrsReviewCorrectStreak: 4 }),
      now: NOW,
      desiredRetention: 0.9,
    });
    expect(result.cardState.fsrsReviewCorrectCount).toBe(6); // 18. preserved
    expect(result.cardState.fsrsReviewCorrectStreak).toBe(0); // 19. reset
    expect(result.cardState.hasEverBeenMastered).toBe(true); // 20. never cleared
  });

  it("21-23. the full short-restoration composition: repair obligation created, Repair Correct alone does not restore, later Spaced Correct restores Mastery", () => {
    const wrongResult = resolveRandomMasteredWrong({ card: freshCard, cardState: learnedCard(), now: NOW, desiredRetention: 0.9 });
    expect(wrongResult.cardState.relearningPhase).toBe("REPAIR_PENDING");

    // 21. a repair obligation is created exactly as for any other long-term Wrong.
    const wrongPosition = 50;
    const obligation = createRepairObligation({ cardId: "card-x", wrongPosition, random: () => 0.1 });
    expect(obligation.targetPosition).toBeGreaterThanOrEqual(wrongPosition + 4);
    expect(obligation.hardCapPosition).toBe(wrongPosition + 7);

    // 22. Repair Correct alone does not restore Mastery.
    const afterRepair = applyRelearningRepairCorrect(wrongResult.cardState);
    expect(afterRepair.cardStatus).toBe("FORGOTTEN"); // not restored yet
    expect(afterRepair.relearningPhase).toBe("SPACED_CONFIRMATION_PENDING");

    // 23. a later Spaced Correct restores Mastery (short restoration, since has_ever_been_mastered is true).
    const restored = applySpacedCorrect(afterRepair);
    expect(restored.cardStatus).toBe("LEARNED");
    expect(restored.poolStatus).toBe("OUTSIDE");
    expect(restored.relearningPhase).toBeNull();
    expect(restored.hasEverBeenMastered).toBe(true);
  });
});
