import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { computeClaimTimeActiveDrawCounterUpdates } = await import("@/lib/learning-engine/runtime/active-draw-counters");
import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";
import { createEmptyCard } from "ts-fsrs";

/**
 * Unit tests for the RC-B corrective pure helper
 * computeClaimTimeActiveDrawCounterUpdates (lib/learning-engine/runtime/
 * active-draw-counters.ts) -- the TypeScript-owned policy half of the
 * claim-time active_draws_since_eligible fix. The DB's own structural
 * contract (membership/non-negative/stale-before validation, atomicity,
 * fast-path/abandonment idempotency) is covered by supabase/tests/
 * 019_learning_engine_v1_runtime_cutover_rc_b_test.sql's Section F.
 */

const FSRS_CARD = createEmptyCard(new Date("2026-01-01T00:00:00.000Z"));

function card(overrides: Partial<SchedulableCardRow> & { cardId: string }): SchedulableCardRow {
  return {
    cardStatus: "LEARNING",
    learningStage: "FRESH",
    poolStatus: "ACTIVE",
    relearningPhase: null,
    hasEverBeenMastered: false,
    repairPending: false,
    fsrsReviewCorrectCount: 0,
    fsrsReviewCorrectStreak: 0,
    correctCooldownUntilPosition: null,
    activeDrawsSinceEligible: 0,
    repairObligation: null,
    fsrsCard: FSRS_CARD,
    ...overrides,
  };
}

describe("computeClaimTimeActiveDrawCounterUpdates", () => {
  it("returns no updates when the decision's source is not ACTIVE", () => {
    const cards = [card({ cardId: "a" }), card({ cardId: "b" })];
    for (const source of ["FSRS_DUE", "NEAR_DUE", "RANDOM_MASTERED", null] as const) {
      const updates = computeClaimTimeActiveDrawCounterUpdates({
        cards,
        admittedCardIds: [],
        schedulerPosition: 0,
        source,
        selectedCardId: "a",
      });
      expect(updates).toEqual([]);
    }
  });

  it("returns no updates when no card was selected (no_card_all_unavailable)", () => {
    const updates = computeClaimTimeActiveDrawCounterUpdates({
      cards: [card({ cardId: "a" })],
      admittedCardIds: [],
      schedulerPosition: 0,
      source: null,
      selectedCardId: null,
    });
    expect(updates).toEqual([]);
  });

  it("the selected ordinary candidate resets to 0; every other eligible ordinary candidate ages by 1", () => {
    const cards = [
      card({ cardId: "selected", activeDrawsSinceEligible: 5 }),
      card({ cardId: "other", activeDrawsSinceEligible: 10 }),
    ];

    const updates = computeClaimTimeActiveDrawCounterUpdates({
      cards,
      admittedCardIds: [],
      schedulerPosition: 0,
      source: "ACTIVE",
      selectedCardId: "selected",
    });

    expect(updates).toEqual(
      expect.arrayContaining([
        { cardId: "selected", before: 5, after: 0 },
        { cardId: "other", before: 10, after: 11 },
      ]),
    );
    expect(updates).toHaveLength(2);
  });

  it("a card on Correct cooldown is excluded entirely -- frozen, never included in the update list", () => {
    const cards = [
      card({ cardId: "selected", activeDrawsSinceEligible: 5 }),
      card({ cardId: "cooling-down", activeDrawsSinceEligible: 3, correctCooldownUntilPosition: 100 }),
    ];

    const updates = computeClaimTimeActiveDrawCounterUpdates({
      cards,
      admittedCardIds: [],
      schedulerPosition: 0,
      source: "ACTIVE",
      selectedCardId: "selected",
    });

    expect(updates.find((u) => u.cardId === "cooling-down")).toBeUndefined();
  });

  it("a repair/relearning-governed card is excluded entirely -- frozen, never included in the update list", () => {
    const cards = [
      card({ cardId: "selected", activeDrawsSinceEligible: 5 }),
      card({
        cardId: "forgotten",
        cardStatus: "FORGOTTEN",
        learningStage: null,
        relearningPhase: "REPAIR_PENDING",
        repairPending: true,
        activeDrawsSinceEligible: 7,
        repairObligation: { cardId: "forgotten", wrongPosition: 0, targetPosition: 4, hardCapPosition: 6 },
      }),
    ];

    const updates = computeClaimTimeActiveDrawCounterUpdates({
      cards,
      admittedCardIds: [],
      schedulerPosition: 0,
      source: "ACTIVE",
      selectedCardId: "selected",
    });

    expect(updates.find((u) => u.cardId === "forgotten")).toBeUndefined();
  });

  it("the selected card resets to 0 even when it is a repair_target/repair_hard_cap/spaced_confirmation presentation (not itself an ordinary candidate) -- every OTHER ordinary candidate still ages", () => {
    const cards = [
      card({
        cardId: "repair-card",
        cardStatus: "FORGOTTEN",
        learningStage: null,
        relearningPhase: "REPAIR_PENDING",
        repairPending: true,
        activeDrawsSinceEligible: 7,
        repairObligation: { cardId: "repair-card", wrongPosition: 0, targetPosition: 4, hardCapPosition: 6 },
      }),
      card({ cardId: "ordinary", activeDrawsSinceEligible: 2 }),
    ];

    // source is "ACTIVE" for repair_hard_cap/repair_target just as it is
    // for ordinary weighted selection (interrupts.ts's
    // GlobalRepairHardCapInterrupt, next-card.ts's internal ordering) --
    // this function has no opinion on selectionReason, only on source.
    const updates = computeClaimTimeActiveDrawCounterUpdates({
      cards,
      admittedCardIds: [],
      schedulerPosition: 10,
      source: "ACTIVE",
      selectedCardId: "repair-card",
    });

    // The repair card itself is not an ordinary candidate, so it never
    // appears in the output at all (there is nothing to reset for it) --
    // only the other, genuinely ordinary candidate ages by 1.
    expect(updates).toEqual([{ cardId: "ordinary", before: 2, after: 3 }]);
  });

  it("a newly virtually-admitted NEW card is included as an ordinary (FRESH-weighted) candidate, exactly matching the post-refill view chooseNextCard() itself saw", () => {
    const cards = [
      card({ cardId: "selected", activeDrawsSinceEligible: 5 }),
      card({ cardId: "freshly-admitted", cardStatus: "NEW", learningStage: null, poolStatus: null, activeDrawsSinceEligible: 0 }),
    ];

    const updates = computeClaimTimeActiveDrawCounterUpdates({
      cards,
      admittedCardIds: ["freshly-admitted"],
      schedulerPosition: 0,
      source: "ACTIVE",
      selectedCardId: "selected",
    });

    expect(updates).toEqual(
      expect.arrayContaining([
        { cardId: "selected", before: 5, after: 0 },
        { cardId: "freshly-admitted", before: 0, after: 1 },
      ]),
    );
  });

  it("returns an empty array when the ACTIVE source fired but zero ordinary candidates currently exist (e.g. a lone card presently in relearning)", () => {
    const cards = [
      card({
        cardId: "repair-card",
        cardStatus: "FORGOTTEN",
        learningStage: null,
        relearningPhase: "REPAIR_PENDING",
        repairPending: true,
        activeDrawsSinceEligible: 7,
        repairObligation: { cardId: "repair-card", wrongPosition: 0, targetPosition: 4, hardCapPosition: 6 },
      }),
    ];

    const updates = computeClaimTimeActiveDrawCounterUpdates({
      cards,
      admittedCardIds: [],
      schedulerPosition: 10,
      source: "ACTIVE",
      selectedCardId: "repair-card",
    });

    expect(updates).toEqual([]);
  });
});
