import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyCard } from "ts-fsrs";

import { chooseNearDueCard, selectNearDueCandidates } from "@/lib/learning-engine/scheduler/near-due-selection";
import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 18
 * (Phase 6C: NEAR_DUE source candidate selection).
 */

const LAST_REVIEW = new Date("2026-01-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULED_DAYS = 10; // fixed interval; `now` is varied per test to control progress precisely

function outsideCard(overrides: Partial<SchedulableCardRow> = {}): SchedulableCardRow {
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
      scheduled_days: SCHEDULED_DAYS,
      state: 2,
    },
    ...overrides,
  };
}

function atProgress(progress: number): Date {
  return new Date(LAST_REVIEW.getTime() + progress * SCHEDULED_DAYS * DAY_MS);
}

function scriptedRandom(values: readonly number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("selectNearDueCandidates (eligibility, section 16.1 boundaries applied to Near-Due)", () => {
  it("17. a card with 0.75 <= progress < 1.0 is included", () => {
    expect(selectNearDueCandidates([outsideCard()], atProgress(0.8))).toHaveLength(1);
    expect(selectNearDueCandidates([outsideCard()], atProgress(0.75))).toHaveLength(1); // exact lower boundary
  });

  it("18. 0.7499 progress is excluded", () => {
    expect(selectNearDueCandidates([outsideCard()], atProgress(0.7499))).toHaveLength(0);
  });

  it("19. 1.0 progress is excluded (it's FSRS_DUE, not Near-Due)", () => {
    expect(selectNearDueCandidates([outsideCard()], atProgress(1.0))).toHaveLength(0);
  });

  it("21. a card artificially marked repair/relearning-governed is excluded even if otherwise Near-Due", () => {
    const governed = outsideCard({ repairPending: true });
    expect(selectNearDueCandidates([governed], atProgress(0.8))).toHaveLength(0);
  });

  it("an ACTIVE-pool card is never a Near-Due candidate", () => {
    const active = outsideCard({ poolStatus: "ACTIVE", cardStatus: "LEARNING", learningStage: "FRESH" });
    expect(selectNearDueCandidates([active], atProgress(0.8))).toHaveLength(0);
  });
});

describe("chooseNearDueCard weighting (section 18, reusing Phase 5's computeNearDueWeight unchanged)", () => {
  it("20. a later (higher-progress) Near-Due card gets a higher weight", () => {
    const early = chooseNearDueCard([outsideCard({ cardId: "early" })], atProgress(0.76), () => 0.5);
    const late = chooseNearDueCard([outsideCard({ cardId: "late" })], atProgress(0.95), () => 0.5);
    expect(late!.weight).toBeGreaterThan(early!.weight);
  });

  it("matches the exact spec weight at 0.75 (1.00) and 0.95 (1.40)", () => {
    const at75 = chooseNearDueCard([outsideCard()], atProgress(0.75), () => 0.5);
    const at95 = chooseNearDueCard([outsideCard()], atProgress(0.95), () => 0.5);
    expect(at75!.weight).toBeCloseTo(1.0);
    expect(at95!.weight).toBeCloseTo(1.4);
  });

  it("22. zero eligible candidates returns null, never throws", () => {
    expect(chooseNearDueCard([], new Date(), () => 0.5)).toBeNull();
    expect(chooseNearDueCard([outsideCard()], atProgress(1.0), () => 0.5)).toBeNull(); // FSRS_DUE, not a Near-Due candidate
  });

  it("23. seeded deterministic selection", () => {
    const cards = [outsideCard({ cardId: "a" }), outsideCard({ cardId: "b" })];
    const run = () => chooseNearDueCard(cards, atProgress(0.8), scriptedRandom([0.42]));
    expect(run()).toEqual(run());
  });

  it("intervalProgress is exposed on the result for future trace construction", () => {
    const result = chooseNearDueCard([outsideCard()], atProgress(0.8), () => 0.5);
    expect(result?.intervalProgress).toBeCloseTo(0.8);
  });
});

describe("determinism: no Math.random is ever called by this module", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("chooseNearDueCard never touches Math.random", () => {
    const spy = vi.spyOn(Math, "random");
    chooseNearDueCard([outsideCard({ cardId: "a" }), outsideCard({ cardId: "b" })], atProgress(0.8), scriptedRandom([0.3]));
    expect(spy).not.toHaveBeenCalled();
  });
});
