import { describe, expect, it, vi } from "vitest";
import { createEmptyCard } from "ts-fsrs";

import { selectDueSpacedConfirmationCard, selectSpacedConfirmationCandidates } from "@/lib/learning-engine/scheduler/spaced-confirmation-selection";
import { selectOrdinaryActiveCandidates } from "@/lib/learning-engine/scheduler/active-selection";
import { applyLongTermWrong, applyRelearningRepairCorrect } from "@/lib/learning-engine/transitions";
import { resolveRelearningRepairCorrect } from "@/lib/learning-engine/repair-scheduler";
import { INITIAL_CARD_STATE } from "@/lib/learning-engine/state";
import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 13
 * (Phase 6C: spaced-confirmation candidate representation).
 */

const NOW = new Date("2026-01-01T00:00:00.000Z");

function toRow(cardId: string, overrides: Partial<SchedulableCardRow>): SchedulableCardRow {
  return {
    cardId,
    cardStatus: "ACQUIRED",
    learningStage: null,
    poolStatus: "OUTSIDE",
    relearningPhase: null,
    hasEverBeenMastered: false,
    repairPending: false,
    fsrsReviewCorrectCount: 0,
    fsrsReviewCorrectStreak: 0,
    correctCooldownUntilPosition: null,
    activeDrawsSinceEligible: 0,
    repairObligation: null,
    fsrsCard: createEmptyCard(NOW),
    ...overrides,
  };
}

/** Builds a real SPACED_CONFIRMATION_PENDING card via the actual Phase 2/4 lifecycle, not a hand-constructed shortcut. */
function spacedConfirmationPendingCardAt(wrongPosition: number) {
  const acquired = { ...INITIAL_CARD_STATE, cardStatus: "ACQUIRED" as const, poolStatus: "OUTSIDE" as const };
  const forgotten = applyLongTermWrong(acquired);
  const repaired = applyRelearningRepairCorrect(forgotten);
  const gatePosition = resolveRelearningRepairCorrect(forgotten, wrongPosition).nextCorrectCooldownUntilPosition;
  return { cardState: repaired, gatePosition };
}

describe("selectSpacedConfirmationCandidates (section 13, Phase 4's isSpacedConfirmationDue)", () => {
  it("24. pending but still inside the 5-card gap -> not eligible", () => {
    const N = 100;
    const { cardState, gatePosition } = spacedConfirmationPendingCardAt(N);
    const row = toRow("card-1", { ...cardState, poolStatus: "ACTIVE", cardStatus: "FORGOTTEN", correctCooldownUntilPosition: gatePosition });

    for (let p = N + 1; p <= N + 5; p += 1) {
      expect(selectSpacedConfirmationCandidates([row], p)).toHaveLength(0);
    }
  });

  it("25. due after the gap -> exposed as a spaced-confirmation candidate", () => {
    const N = 100;
    const { cardState, gatePosition } = spacedConfirmationPendingCardAt(N);
    const row = toRow("card-1", { ...cardState, poolStatus: "ACTIVE", cardStatus: "FORGOTTEN", correctCooldownUntilPosition: gatePosition });

    const candidates = selectSpacedConfirmationCandidates([row], N + 6);
    expect(candidates).toEqual([{ cardId: "card-1", correctCooldownUntilPosition: gatePosition }]);
  });

  it("a REPAIR_PENDING (not yet SPACED_CONFIRMATION_PENDING) card is never a spaced-confirmation candidate", () => {
    const repairPending = toRow("card-1", {
      poolStatus: "ACTIVE",
      cardStatus: "FORGOTTEN",
      relearningPhase: "REPAIR_PENDING",
      correctCooldownUntilPosition: null,
    });
    expect(selectSpacedConfirmationCandidates([repairPending], 1000)).toHaveLength(0);
  });

  it("an ordinary (non-relearning) card is never a spaced-confirmation candidate", () => {
    const ordinary = toRow("card-1", { poolStatus: "OUTSIDE", cardStatus: "ACQUIRED" });
    expect(selectSpacedConfirmationCandidates([ordinary], 1000)).toHaveLength(0);
  });

  it("26. a spaced-confirmation-due card is not included in ordinary Active weighting -- the two channels never overlap", () => {
    const N = 100;
    const { cardState, gatePosition } = spacedConfirmationPendingCardAt(N);
    const row = toRow("card-1", { ...cardState, poolStatus: "ACTIVE", cardStatus: "FORGOTTEN", correctCooldownUntilPosition: gatePosition });

    expect(selectSpacedConfirmationCandidates([row], N + 6)).toHaveLength(1);
    expect(selectOrdinaryActiveCandidates([row], N + 6)).toHaveLength(0);
  });

  it("exposes every simultaneously-due candidate (not just the eventual winner)", () => {
    const first = spacedConfirmationPendingCardAt(100);
    const second = spacedConfirmationPendingCardAt(105);
    const rowA = toRow("a", { ...first.cardState, poolStatus: "ACTIVE", cardStatus: "FORGOTTEN", correctCooldownUntilPosition: first.gatePosition });
    const rowB = toRow("b", { ...second.cardState, poolStatus: "ACTIVE", cardStatus: "FORGOTTEN", correctCooldownUntilPosition: second.gatePosition });

    // Both due by position 112 (100+6=106 and 105+6=111).
    const candidates = selectSpacedConfirmationCandidates([rowA, rowB], 112);
    expect(candidates.map((c) => c.cardId).sort()).toEqual(["a", "b"]);
  });
});

describe("selectDueSpacedConfirmationCard (resolved priority rule: smallest correctCooldownUntilPosition first, RNG tie-break only on exact ties)", () => {
  function spacedRow(cardId: string, wrongPosition: number): { row: SchedulableCardRow; gatePosition: number } {
    const { cardState, gatePosition } = spacedConfirmationPendingCardAt(wrongPosition);
    const row = toRow(cardId, { ...cardState, poolStatus: "ACTIVE", cardStatus: "FORGOTTEN", correctCooldownUntilPosition: gatePosition });
    return { row, gatePosition };
  }

  it("picks the single due candidate when there is only one", () => {
    const { row } = spacedRow("a", 100);
    const result = selectDueSpacedConfirmationCard([row], 106, () => 0.5);
    expect(result?.cardId).toBe("a");
  });

  it("the candidate whose gate opened EARLIEST (smallest correctCooldownUntilPosition) wins over a later one", () => {
    const earlier = spacedRow("earlier", 100); // gate at 106
    const later = spacedRow("later", 103); // gate at 109
    const currentPosition = 110; // both due by now

    const result = selectDueSpacedConfirmationCard([earlier.row, later.row], currentPosition, () => 0.99);
    expect(result?.cardId).toBe("earlier");
    expect(earlier.gatePosition).toBeLessThan(later.gatePosition);
  });

  it("order of the input array does not affect the outcome -- priority alone decides", () => {
    const earlier = spacedRow("earlier", 100);
    const later = spacedRow("later", 103);
    const currentPosition = 110;

    const result = selectDueSpacedConfirmationCard([later.row, earlier.row], currentPosition, () => 0.01);
    expect(result?.cardId).toBe("earlier");
  });

  it("injected RNG tie-break fires only for an EXACT tie in correctCooldownUntilPosition", () => {
    const tiedA = spacedRow("a", 100); // gate at 106
    const tiedB = spacedRow("b", 100); // gate at 106 -- identical wrongPosition -> identical gate
    const currentPosition = 106;

    const winnerLow = selectDueSpacedConfirmationCard([tiedA.row, tiedB.row], currentPosition, () => 0); // index 0 -> "a"
    const winnerHigh = selectDueSpacedConfirmationCard([tiedA.row, tiedB.row], currentPosition, () => 0.99); // index 1 -> "b"
    expect(winnerLow?.cardId).toBe("a");
    expect(winnerHigh?.cardId).toBe("b");
  });

  it("returns null for a genuinely empty candidate set, never throws", () => {
    expect(selectDueSpacedConfirmationCard([], 1000, () => 0.5)).toBeNull();
    const notYetDue = spacedRow("a", 100).row;
    expect(selectDueSpacedConfirmationCard([notYetDue], 104, () => 0.5)).toBeNull(); // still inside the gap
  });

  it("is deterministic/reproducible: identical candidates + identical RNG give identical results", () => {
    const earlier = spacedRow("earlier", 100);
    const later = spacedRow("later", 103);
    const run = () => selectDueSpacedConfirmationCard([earlier.row, later.row], 110, () => 0.42);
    expect(run()).toEqual(run());
  });

  it("never calls Math.random directly", () => {
    const spy = vi.spyOn(Math, "random");
    const earlier = spacedRow("earlier", 100);
    const later = spacedRow("later", 103);
    selectDueSpacedConfirmationCard([earlier.row, later.row], 110, () => 0.3);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
