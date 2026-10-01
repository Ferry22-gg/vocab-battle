import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyCard } from "ts-fsrs";

import { chooseDueCard, selectDueCandidates } from "@/lib/learning-engine/scheduler/due-selection";
import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 17
 * (Phase 6C: FSRS_DUE source candidate selection).
 */

const LAST_REVIEW = new Date("2026-01-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function outsideCard(
  overrides: Partial<SchedulableCardRow> = {},
  fsrsOverrides: Partial<SchedulableCardRow["fsrsCard"]> = {},
): SchedulableCardRow {
  return {
    cardId: "card-1",
    cardStatus: "ACQUIRED",
    learningStage: null,
    poolStatus: "OUTSIDE",
    relearningPhase: null,
    hasEverBeenMastered: false,
    repairPending: false,
    fsrsReviewCorrectCount: 1,
    fsrsReviewCorrectStreak: 1,
    correctCooldownUntilPosition: null,
    activeDrawsSinceEligible: 0,
    repairObligation: null,
    fsrsCard: {
      ...createEmptyCard(LAST_REVIEW),
      last_review: LAST_REVIEW,
      stability: 10,
      difficulty: 5,
      scheduled_days: 10,
      state: 2,
      ...fsrsOverrides,
    },
    ...overrides,
  };
}

function scriptedRandom(values: readonly number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("selectDueCandidates (eligibility, section 17)", () => {
  it("10. only FSRS_DUE cards are included", () => {
    const due = outsideCard({ cardId: "due" }); // 10 days scheduled, evaluated exactly at due
    const now = new Date(LAST_REVIEW.getTime() + 10 * DAY_MS);
    expect(selectDueCandidates([due], now)).toHaveLength(1);
  });

  it("11. a Near-Due card (progress in [0.75, 1.0)) is excluded from FSRS_DUE", () => {
    const nearDue = outsideCard({ cardId: "near" });
    const now = new Date(LAST_REVIEW.getTime() + 8 * DAY_MS); // progress 0.8
    expect(selectDueCandidates([nearDue], now)).toHaveLength(0);
  });

  it("a STRONG_OUTSIDE card (progress < 0.75) is excluded", () => {
    const strongOutside = outsideCard({ cardId: "strong" });
    const now = new Date(LAST_REVIEW.getTime() + 2 * DAY_MS); // progress 0.2
    expect(selectDueCandidates([strongOutside], now)).toHaveLength(0);
  });

  it("14. a card artificially marked repair/relearning-governed is excluded even if otherwise FSRS_DUE (defense-in-depth: not reachable in a well-formed engine state, since repair_pending/relearning_phase never coexist with poolStatus OUTSIDE under Phase 2's own invariants)", () => {
    const governed = outsideCard({ cardId: "governed", repairPending: true });
    const now = new Date(LAST_REVIEW.getTime() + 10 * DAY_MS);
    expect(selectDueCandidates([governed], now)).toHaveLength(0);
  });

  it("an ACTIVE-pool card is never a Due candidate, even with matching FSRS timing", () => {
    const active = outsideCard({ cardId: "active", poolStatus: "ACTIVE", cardStatus: "LEARNING", learningStage: "FRESH" });
    const now = new Date(LAST_REVIEW.getTime() + 10 * DAY_MS);
    expect(selectDueCandidates([active], now)).toHaveLength(0);
  });
});

describe("chooseDueCard weighting (section 17, reusing Phase 5's computeDueWeight unchanged)", () => {
  it("12. lower R gives a higher weight", () => {
    const now = new Date(LAST_REVIEW.getTime() + 10 * DAY_MS);
    // Lower stability decays faster, so at the same elapsed time R is lower.
    const lowStability = outsideCard({ cardId: "low-r" }, { stability: 2 });
    const highStability = outsideCard({ cardId: "high-r" }, { stability: 50 });

    const lowRResult = chooseDueCard([lowStability], now, 0.9, () => 0.5);
    const highRResult = chooseDueCard([highStability], now, 0.9, () => 0.5);

    expect(lowRResult!.retrievability).toBeLessThan(highRResult!.retrievability);
    expect(lowRResult!.weight).toBeGreaterThan(highRResult!.weight);
  });

  it("13. desiredRetention affects the Due weight correctly (higher r_d -> higher weight for the same R)", () => {
    const now = new Date(LAST_REVIEW.getTime() + 10 * DAY_MS);
    const card = outsideCard();

    const atDefaultRetention = chooseDueCard([card], now, 0.9, () => 0.5);
    const atHigherRetention = chooseDueCard([card], now, 0.92, () => 0.5);

    expect(atDefaultRetention!.retrievability).toBe(atHigherRetention!.retrievability); // same card, same R
    expect(atHigherRetention!.weight).toBeGreaterThan(atDefaultRetention!.weight); // (1 - 0.92) < (1 - 0.90) -> larger ratio
  });

  it("15. zero eligible candidates returns null, never throws", () => {
    expect(chooseDueCard([], new Date(), 0.9, () => 0.5)).toBeNull();
    const nearDue = outsideCard();
    const now = new Date(LAST_REVIEW.getTime() + 8 * DAY_MS);
    expect(chooseDueCard([nearDue], now, 0.9, () => 0.5)).toBeNull();
  });

  it("16. seeded deterministic selection", () => {
    const now = new Date(LAST_REVIEW.getTime() + 10 * DAY_MS);
    const cards = [outsideCard({ cardId: "a" }, { stability: 5 }), outsideCard({ cardId: "b" }, { stability: 20 })];
    const run = () => chooseDueCard(cards, now, 0.9, scriptedRandom([0.42]));
    expect(run()).toEqual(run());
  });

  it("candidateCount reflects only the FSRS_DUE eligible subset, excluding mixed Near-Due/Strong-Outside siblings at the same `now`", () => {
    const now = new Date(LAST_REVIEW.getTime() + 10 * DAY_MS);
    const due = outsideCard({ cardId: "due" }, { scheduled_days: 10 }); // progress 1.0
    const nearDue = outsideCard({ cardId: "near" }, { scheduled_days: 13 }); // progress ~0.77
    const strongOutside = outsideCard({ cardId: "strong" }, { scheduled_days: 20 }); // progress 0.5
    const result = chooseDueCard([due, nearDue, strongOutside], now, 0.9, () => 0.5);
    expect(result?.cardId).toBe("due");
    expect(result?.candidateCount).toBe(1);
  });
});

describe("determinism: no Math.random is ever called by this module", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("chooseDueCard never touches Math.random", () => {
    const spy = vi.spyOn(Math, "random");
    const now = new Date(LAST_REVIEW.getTime() + 10 * DAY_MS);
    chooseDueCard([outsideCard({ cardId: "a" }), outsideCard({ cardId: "b" }, { stability: 30 })], now, 0.9, scriptedRandom([0.3]));
    expect(spy).not.toHaveBeenCalled();
  });
});
