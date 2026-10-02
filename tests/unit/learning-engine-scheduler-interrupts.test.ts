import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyCard, type Card } from "ts-fsrs";

import {
  findCriticalDueInterrupt,
  findGlobalInterrupt,
  findRepairHardCapInterrupt,
  isCriticalDue,
} from "@/lib/learning-engine/scheduler/interrupts";
import { computeDueWeight } from "@/lib/learning-engine/fsrs/priority";
import { deriveRetrievability } from "@/lib/learning-engine/fsrs/adapter";
import type { RepairObligation } from "@/lib/learning-engine/repair-scheduler";
import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 22.1
 * (repair hard cap), 22.2 (Critical Due), 23/24 (interrupt priority) --
 * Phase 6D: the GLOBAL interrupt layer.
 */

const NOW = new Date("2026-01-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function scriptedRandom(values: readonly number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

/** Deterministic LCG for broad/varied coverage without Math.random. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function baseCard(overrides: Partial<SchedulableCardRow> = {}): SchedulableCardRow {
  return {
    cardId: "card-1",
    cardStatus: "LEARNING",
    learningStage: "LEARNING_1",
    poolStatus: "ACTIVE",
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

function repairCard(cardId: string, obligation: RepairObligation): SchedulableCardRow {
  return baseCard({ cardId, repairPending: true, repairObligation: obligation });
}

function obligation(cardId: string, wrongPosition: number, hardCapPosition: number): RepairObligation {
  return { cardId, wrongPosition, targetPosition: wrongPosition + 4, hardCapPosition };
}

/**
 * Builds an OUTSIDE/FSRS_DUE card whose retrievability (as actually
 * computed by lib/learning-engine/fsrs/adapter.ts's deriveRetrievability,
 * the same function this engine uses everywhere else -- never a hardcoded
 * stand-in) sits on a requested side of a target R via binary search over
 * elapsed days, at a fixed stability. `scheduled_days` is kept at 1 so the
 * card is always classified FSRS_DUE at `now` regardless of which side of
 * the search we land on (elapsed is always many days, since stability is
 * large enough that R only approaches low values after a long wait).
 */
function outsideCardAtRetrievability(cardId: string, targetR: number, wantAtOrBelow: boolean): SchedulableCardRow {
  const stability = 50;
  let lo = 0;
  let hi = 3650;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    const probeCard: Card = {
      ...createEmptyCard(NOW),
      stability,
      difficulty: 5,
      scheduled_days: 1,
      state: 2,
      last_review: new Date(NOW.getTime() - mid * DAY_MS),
    };
    const r = deriveRetrievability(probeCard, NOW);
    if (r > targetR) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  // `hi` converges to the smallest elapsed (days) at/below targetR;
  // `lo` converges to the largest elapsed (days) strictly above targetR.
  const elapsedDays = wantAtOrBelow ? hi : lo;
  const fsrsCard: Card = {
    ...createEmptyCard(NOW),
    stability,
    difficulty: 5,
    scheduled_days: 1,
    state: 2,
    last_review: new Date(NOW.getTime() - elapsedDays * DAY_MS),
  };
  return baseCard({
    cardId,
    cardStatus: "ACQUIRED",
    learningStage: null,
    poolStatus: "OUTSIDE",
    repairObligation: null,
    fsrsCard,
  });
}

// =============================================================================
// REPAIR HARD CAP (section 22.1)
// =============================================================================

describe("findRepairHardCapInterrupt (section 22.1)", () => {
  it("1. a hard-cap-reached repair produces a global interrupt", () => {
    const o = obligation("r1", 10, 17);
    const cards = [repairCard("r1", o)];
    const result = findRepairHardCapInterrupt(cards, 17, scriptedRandom([0.5]));
    expect(result).toEqual({ cardId: "r1", source: "ACTIVE", reason: "repair_hard_cap" });
  });

  it("3. oldest Wrong wins among multiple hard-cap-reached repairs", () => {
    const cards = [
      repairCard("late", obligation("late", 20, 27)),
      repairCard("oldest", obligation("oldest", 10, 17)),
      repairCard("mid", obligation("mid", 15, 22)),
    ];
    const result = findRepairHardCapInterrupt(cards, 27, scriptedRandom([0.5]));
    expect(result?.cardId).toBe("oldest");
  });

  it("4. an exact hard-cap tie (identical wrongPosition) uses the injected RNG", () => {
    const cards = [repairCard("a", obligation("a", 10, 17)), repairCard("b", obligation("b", 10, 17))];
    const low = findRepairHardCapInterrupt(cards, 17, scriptedRandom([0])); // index 0 -> "a"
    const high = findRepairHardCapInterrupt(cards, 17, scriptedRandom([0.99])); // index 1 -> "b"
    expect(low?.cardId).toBe("a");
    expect(high?.cardId).toBe("b");
  });

  it("5. a target-reached-but-not-hard-cap repair does NOT produce a global interrupt", () => {
    const o = obligation("r1", 10, 17); // target reached at 14, hard cap at 17
    const cards = [repairCard("r1", o)];
    expect(findRepairHardCapInterrupt(cards, 14, scriptedRandom([0.5]))).toBeNull();
    expect(findRepairHardCapInterrupt(cards, 16, scriptedRandom([0.5]))).toBeNull();
  });

  it("returns null when no repair obligations exist at all", () => {
    expect(findRepairHardCapInterrupt([baseCard()], 100, scriptedRandom([0.5]))).toBeNull();
  });
});

// =============================================================================
// CRITICAL DUE (section 22.2)
// =============================================================================

describe("isCriticalDue (section 22.2/7's exact policy boundary: R <= 0.60)", () => {
  it("R = 0.599999 -> true (strictly below the threshold)", () => {
    expect(isCriticalDue(0.599999)).toBe(true);
  });

  it("R = 0.600000 -> true (the threshold is inclusive -- '<=', not '<')", () => {
    expect(isCriticalDue(0.6)).toBe(true);
  });

  it("R = 0.600001 -> false (strictly above the threshold)", () => {
    expect(isCriticalDue(0.600001)).toBe(false);
  });
});

describe("findCriticalDueInterrupt (section 22.2)", () => {
  it("6. a card with R at or below the 0.60 threshold qualifies", () => {
    const card = outsideCardAtRetrievability("at-threshold", 0.6, true);
    const actualR = deriveRetrievability(card.fsrsCard, NOW);
    expect(actualR).toBeLessThanOrEqual(0.6);

    const result = findCriticalDueInterrupt({
      cards: [card],
      now: NOW,
      desiredRetention: 0.9,
      schedulerPosition: 100,
      lastCriticalDuePosition: null,
      random: scriptedRandom([0.5]),
    });
    expect(result).not.toBeNull();
    expect(result?.cardId).toBe("at-threshold");
  });

  it("7. a card with R strictly above the 0.60 threshold does not qualify", () => {
    const card = outsideCardAtRetrievability("above-threshold", 0.6, false);
    const actualR = deriveRetrievability(card.fsrsCard, NOW);
    expect(actualR).toBeGreaterThan(0.6);

    const result = findCriticalDueInterrupt({
      cards: [card],
      now: NOW,
      desiredRetention: 0.9,
      schedulerPosition: 100,
      lastCriticalDuePosition: null,
      random: scriptedRandom([0.5]),
    });
    expect(result).toBeNull();
  });

  it("8. persisted position P+4 blocks the Critical interrupt (still within the last 5 completed questions)", () => {
    const card = outsideCardAtRetrievability("critical", 0.3, true);
    const P = 10;
    const result = findCriticalDueInterrupt({
      cards: [card],
      now: NOW,
      desiredRetention: 0.9,
      schedulerPosition: P + 4,
      lastCriticalDuePosition: P,
      random: scriptedRandom([0.5]),
    });
    expect(result).toBeNull();
  });

  it("9. persisted position P+5 allows the next Critical interrupt", () => {
    const card = outsideCardAtRetrievability("critical", 0.3, true);
    const P = 10;
    const result = findCriticalDueInterrupt({
      cards: [card],
      now: NOW,
      desiredRetention: 0.9,
      schedulerPosition: P + 5,
      lastCriticalDuePosition: P,
      random: scriptedRandom([0.5]),
    });
    expect(result?.cardId).toBe("critical");
  });

  it("10. Critical candidate selection uses the normal Due weighting formula, not an invented one", () => {
    const lowR = outsideCardAtRetrievability("low-r", 0.1, true); // lower R, higher weight
    const higherR = outsideCardAtRetrievability("higher-r", 0.55, true); // still critical, but higher R, lower weight
    const desiredRetention = 0.9;

    const rLow = deriveRetrievability(lowR.fsrsCard, NOW);
    const rHigh = deriveRetrievability(higherR.fsrsCard, NOW);
    const weightLow = computeDueWeight(rLow, desiredRetention);
    const weightHigh = computeDueWeight(rHigh, desiredRetention);
    const total = weightLow + weightHigh;
    const lowShare = weightLow / total;

    const justUnder = findCriticalDueInterrupt({
      cards: [lowR, higherR],
      now: NOW,
      desiredRetention,
      schedulerPosition: 100,
      lastCriticalDuePosition: null,
      random: scriptedRandom([lowShare - 0.001]),
    });
    const justOver = findCriticalDueInterrupt({
      cards: [lowR, higherR],
      now: NOW,
      desiredRetention,
      schedulerPosition: 100,
      lastCriticalDuePosition: null,
      random: scriptedRandom([lowShare + 0.001]),
    });
    expect(justUnder?.cardId).toBe("low-r");
    expect(justOver?.cardId).toBe("higher-r");
  });

  it("11. no Critical candidate in the deck -> null", () => {
    const notCritical = outsideCardAtRetrievability("not-critical", 0.6, false);
    const result = findCriticalDueInterrupt({
      cards: [notCritical],
      now: NOW,
      desiredRetention: 0.9,
      schedulerPosition: 100,
      lastCriticalDuePosition: null,
      random: scriptedRandom([0.5]),
    });
    expect(result).toBeNull();
  });

  it("12. a recently-presented Critical Due -> null, even with an eligible candidate", () => {
    const card = outsideCardAtRetrievability("critical", 0.2, true);
    const result = findCriticalDueInterrupt({
      cards: [card],
      now: NOW,
      desiredRetention: 0.9,
      schedulerPosition: 14,
      lastCriticalDuePosition: 10, // 14 - 10 = 4 <= 4 -> still recent
      random: scriptedRandom([0.5]),
    });
    expect(result).toBeNull();
  });
});

// =============================================================================
// GLOBAL VS INTERNAL / PRIORITY (sections 24, 25 of the Phase 6D brief)
// =============================================================================

describe("findGlobalInterrupt (sections 23/24: Repair hard cap > Critical Due > ordinary selection)", () => {
  it("2. Repair hard cap wins over Critical Due when both are simultaneously eligible", () => {
    const repair = repairCard("repair-card", obligation("repair-card", 10, 17));
    const critical = outsideCardAtRetrievability("critical-card", 0.2, true);

    const result = findGlobalInterrupt({
      cards: [repair, critical],
      schedulerPosition: 17,
      now: NOW,
      desiredRetention: 0.9,
      lastCriticalDuePosition: null,
      random: scriptedRandom([0.5]),
    });

    expect(result).toEqual({ cardId: "repair-card", source: "ACTIVE", reason: "repair_hard_cap" });
  });

  it("24. Repair hard cap bypasses everything else -- Critical Due is never even evaluated when a hard cap has fired", () => {
    // A recently-presented Critical Due window would normally return null
    // anyway, but this proves the short-circuit: a hard-cap repair wins
    // even though the only Critical candidate present would ALSO qualify.
    const repair = repairCard("repair-card", obligation("repair-card", 10, 17));
    const critical = outsideCardAtRetrievability("critical-card", 0.1, true);
    const result = findGlobalInterrupt({
      cards: [repair, critical],
      schedulerPosition: 17,
      now: NOW,
      desiredRetention: 0.9,
      lastCriticalDuePosition: null,
      random: scriptedRandom([0.5]),
    });
    expect(result?.reason).toBe("repair_hard_cap");
  });

  it("25. Critical Due fires when no Repair hard cap exists", () => {
    const critical = outsideCardAtRetrievability("critical-card", 0.2, true);
    const result = findGlobalInterrupt({
      cards: [critical],
      schedulerPosition: 100,
      now: NOW,
      desiredRetention: 0.9,
      lastCriticalDuePosition: null,
      random: scriptedRandom([0.5]),
    });
    expect(result).toMatchObject({ cardId: "critical-card", source: "FSRS_DUE", reason: "critical_due_interrupt" });
  });

  it("26. a target-reached-but-not-hard-cap repair does not block Critical Due globally (it waits for an ACTIVE source slot instead)", () => {
    const targetOnly = repairCard("target-only", obligation("target-only", 10, 17)); // target reached at 14, hard cap 17
    const critical = outsideCardAtRetrievability("critical-card", 0.2, true);
    const result = findGlobalInterrupt({
      cards: [targetOnly, critical],
      schedulerPosition: 14, // target reached, hard cap not reached
      now: NOW,
      desiredRetention: 0.9,
      lastCriticalDuePosition: null,
      random: scriptedRandom([0.5]),
    });
    expect(result).toMatchObject({ cardId: "critical-card", source: "FSRS_DUE", reason: "critical_due_interrupt" });
  });

  it("neither interrupt fires -> null", () => {
    const ordinary = baseCard({ cardId: "ordinary" });
    const result = findGlobalInterrupt({
      cards: [ordinary],
      schedulerPosition: 100,
      now: NOW,
      desiredRetention: 0.9,
      lastCriticalDuePosition: null,
      random: scriptedRandom([0.5]),
    });
    expect(result).toBeNull();
  });
});

// =============================================================================
// DETERMINISM (section 14 of the Phase 6D brief)
// =============================================================================

describe("determinism", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("27. identical state + RNG sequence -> identical global interrupt result", () => {
    const cards = [
      repairCard("a", obligation("a", 10, 17)),
      repairCard("b", obligation("b", 10, 17)),
      outsideCardAtRetrievability("critical", 0.2, true),
    ];
    const run = () =>
      findGlobalInterrupt({
        cards,
        schedulerPosition: 17,
        now: NOW,
        desiredRetention: 0.9,
        lastCriticalDuePosition: null,
        random: lcg(99),
      });
    expect(run()).toEqual(run());
  });

  it("29. Math.random is never called directly when an injected RandomSource is supplied", () => {
    const spy = vi.spyOn(Math, "random");
    const cards = [repairCard("a", obligation("a", 10, 17)), outsideCardAtRetrievability("critical", 0.2, true)];
    findGlobalInterrupt({
      cards,
      schedulerPosition: 17,
      now: NOW,
      desiredRetention: 0.9,
      lastCriticalDuePosition: null,
      random: scriptedRandom([0.3]),
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
