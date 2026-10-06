import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyCard, type Card } from "ts-fsrs";

import { chooseNextCard } from "@/lib/learning-engine/scheduler/next-card";
import { computeDueWeight } from "@/lib/learning-engine/fsrs/priority";
import { deriveRetrievability } from "@/lib/learning-engine/fsrs/adapter";
import type { RepairObligation } from "@/lib/learning-engine/repair-scheduler";
import type { DeckSchedulerSnapshot, SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 20-24
 * (Phase 6E: the top-level pure chooseNextCard orchestrator).
 */

const NOW = new Date("2026-01-11T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function scriptedRandom(values: readonly number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function activeCard(overrides: Partial<SchedulableCardRow> = {}): SchedulableCardRow {
  return {
    cardId: "card-1",
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
    fsrsCard: createEmptyCard(NOW),
    ...overrides,
  };
}

function reservoirCard(cardId: string): SchedulableCardRow {
  return activeCard({ cardId, poolStatus: null, cardStatus: "NEW", learningStage: null });
}

/** Already admitted to ACTIVE, never presented -- a first-pass batch candidate (no virtual refill needed to reach ACTIVE). */
function neverPresentedActiveCard(cardId: string): SchedulableCardRow {
  return activeCard({ cardId, cardStatus: "NEW", learningStage: null });
}

/** Simulates the real post-commit transition a presented first-pass card would undergo (NEW -> LEARNING/FRESH), for chaining chooseNextCard calls across a simulated multi-draw sequence in a pure unit test. */
function presented(card: SchedulableCardRow): SchedulableCardRow {
  return { ...card, cardStatus: "LEARNING", learningStage: "FRESH" };
}

function repairGovernedCard(cardId: string, obligation: RepairObligation, overrides: Partial<SchedulableCardRow> = {}): SchedulableCardRow {
  return activeCard({ cardId, repairPending: true, repairObligation: obligation, ...overrides });
}

function obligation(cardId: string, wrongPosition: number, hardCapPosition: number): RepairObligation {
  return { cardId, wrongPosition, targetPosition: wrongPosition + 4, hardCapPosition };
}

function spacedConfirmationCard(cardId: string, gatePosition: number): SchedulableCardRow {
  return activeCard({
    cardId,
    cardStatus: "FORGOTTEN",
    learningStage: null,
    relearningPhase: "SPACED_CONFIRMATION_PENDING",
    correctCooldownUntilPosition: gatePosition,
  });
}

function outsideCard(
  overrides: Partial<SchedulableCardRow> = {},
  fsrsOverrides: Partial<Card> = {},
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
      ...createEmptyCard(NOW),
      stability: 10,
      difficulty: 5,
      scheduled_days: 10,
      state: 2,
      last_review: new Date(NOW.getTime() - 10 * DAY_MS), // progress 1.0 -> FSRS_DUE
      ...fsrsOverrides,
    },
    ...overrides,
  };
}

/** Binary-searches `stability` (at a fixed 10-day elapsed window) so the resulting card's real deriveRetrievability lands at/below a target R -- the same technique used in learning-engine-scheduler-interrupts.test.ts, so Critical Due tests exercise the real FSRS computation rather than a stubbed R. */
function criticallyDueCard(cardId: string, targetR = 0.3): SchedulableCardRow {
  let lo = 0.01;
  let hi = 50;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    const probe: Card = {
      ...createEmptyCard(NOW),
      stability: mid,
      difficulty: 5,
      scheduled_days: 10,
      state: 2,
      last_review: new Date(NOW.getTime() - 10 * DAY_MS),
    };
    const r = deriveRetrievability(probe, NOW);
    if (r > targetR) {
      hi = mid; // too much stability -> R too high -> shrink stability
    } else {
      lo = mid;
    }
  }
  return outsideCard({ cardId }, { stability: lo });
}

function nearDueCard(cardId: string): SchedulableCardRow {
  return outsideCard({ cardId }, { last_review: new Date(NOW.getTime() - 8 * DAY_MS) }); // progress 0.8 -> NEAR_DUE
}

function dueCards(count: number, prefix = "due"): SchedulableCardRow[] {
  return Array.from({ length: count }, (_, i) => outsideCard({ cardId: `${prefix}-${i}` }));
}

function snapshot(params: {
  cards: readonly SchedulableCardRow[];
  schedulerPosition?: number;
  schedulerRevision?: number;
  lastCriticalDuePosition?: number | null;
  desiredRetention?: number;
  dailyGoalCompleted?: boolean;
  policyVersion?: string;
  now?: Date;
  firstPassQueue?: readonly string[] | null;
  hasAchievedFullMastery?: boolean;
  masteredCount?: number;
  postMasteryShuffleBag?: readonly string[] | null;
}): DeckSchedulerSnapshot {
  return {
    userId: "user-1",
    deckId: "deck-1",
    now: params.now ?? NOW,
    deckState: {
      desiredRetention: params.desiredRetention ?? 0.9,
      policyVersion: params.policyVersion ?? "learning-engine-v1.0",
      hasAchievedFullMastery: params.hasAchievedFullMastery ?? false,
      masteredCount: params.masteredCount ?? 0,
      schedulerPosition: params.schedulerPosition ?? 0,
      lastCriticalDuePosition: params.lastCriticalDuePosition ?? null,
      schedulerRevision: params.schedulerRevision ?? 1,
      firstPassQueue: params.firstPassQueue ?? null,
      postMasteryShuffleBag: params.postMasteryShuffleBag ?? null,
    },
    dailyGoal: { enemiesDefeatedToday: 0, completed: params.dailyGoalCompleted ?? false },
    cards: params.cards,
  };
}

// =============================================================================
// GLOBAL INTERRUPTS
// =============================================================================

describe("global interrupts (section 6 of the brief)", () => {
  it("1. Repair hard cap short-circuits everything, even with Due/Near-Due candidates present", () => {
    const repair = repairGovernedCard("repair-1", obligation("repair-1", 10, 17));
    const s = snapshot({ cards: [repair, ...dueCards(3), nearDueCard("near-1")], schedulerPosition: 17 });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.cardId).toBe("repair-1");
    expect(decision.source).toBe("ACTIVE");
    expect(decision.selectionReason).toBe("repair_hard_cap");
    expect(decision.trace.retrievability).toBeNull();
    expect(decision.trace.emergencyFallbackApplied).toBe(false);
  });

  it("2. Critical Due short-circuits ordinary source selection", () => {
    const critical = criticallyDueCard("critical", 0.2);
    const ordinary = activeCard({ cardId: "ordinary" });
    const s = snapshot({ cards: [critical, ordinary], schedulerPosition: 100 });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.cardId).toBe("critical");
    expect(decision.source).toBe("FSRS_DUE");
    expect(decision.selectionReason).toBe("critical_due_interrupt");
    expect(decision.trace.retrievability).not.toBeNull();
    expect(decision.trace.cardPriorityWeight).toBeCloseTo(computeDueWeight(decision.trace.retrievability!, 0.9));
  });

  it("3. Repair hard cap beats Critical Due when both are eligible", () => {
    const repair = repairGovernedCard("repair-1", obligation("repair-1", 10, 17));
    const critical = criticallyDueCard("critical", 0.2);
    const s = snapshot({ cards: [repair, critical], schedulerPosition: 17 });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.selectionReason).toBe("repair_hard_cap");
    expect(decision.cardId).toBe("repair-1");
  });

  it("4. a short-circuiting Repair hard cap consumes no RNG at all when there is no tie to break", () => {
    const repair = repairGovernedCard("repair-1", obligation("repair-1", 10, 17));
    const s = snapshot({ cards: [repair, ...dueCards(5), nearDueCard("near-1")], schedulerPosition: 17 });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.selectionReason).toBe("repair_hard_cap");
    expect(decision.trace.randomDraws).toEqual([]);
  });
});

// =============================================================================
// ACTIVE REFILL
// =============================================================================

describe("virtual Active refill (section 4 of the brief)", () => {
  it("5. a brand-new deck admits 6, Fresh = 6, ACTIVE becomes non-empty, and a newly admitted card can be selected", () => {
    const reservoir = Array.from({ length: 20 }, (_, i) => reservoirCard(`new-${i}`));
    const s = snapshot({ cards: reservoir });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.admittedCardIds).toHaveLength(6);
    expect(decision.source).toBe("ACTIVE");
    expect(decision.cardId).not.toBeNull();
    expect(decision.admittedCardIds).toContain(decision.cardId);
  });

  it("6. refill does not mutate the original snapshot", () => {
    const reservoir = Array.from({ length: 20 }, (_, i) => reservoirCard(`new-${i}`));
    const s = snapshot({ cards: reservoir });
    const before = JSON.parse(JSON.stringify(s));
    chooseNextCard(s, scriptedRandom([0.5]));
    expect(JSON.parse(JSON.stringify(s))).toEqual(before);
    expect(s.cards.every((c) => c.poolStatus === null && c.cardStatus === "NEW")).toBe(true);
  });

  it("7a. refill never exceeds the Fresh limit (6) on a brand-new deck", () => {
    const reservoir = Array.from({ length: 30 }, (_, i) => reservoirCard(`new-${i}`));
    const s = snapshot({ cards: reservoir });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.admittedCardIds.length).toBeLessThanOrEqual(6);
    expect(decision.admittedCardIds).toHaveLength(6);
  });

  it("7b. refill never exceeds the Active target (20), even when Fresh capacity remains", () => {
    const existingActive = Array.from({ length: 18 }, (_, i) => activeCard({ cardId: `l1-${i}`, learningStage: "LEARNING_1" }));
    const reservoir = Array.from({ length: 10 }, (_, i) => reservoirCard(`new-${i}`));
    const s = snapshot({ cards: [...existingActive, ...reservoir] });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.admittedCardIds).toHaveLength(2); // 20 - 18 existing Active
  });

  it("8. an admitted NEW card is treated as effective FRESH and selectable, without the original snapshot ever showing it as LEARNING", () => {
    const reservoir = [reservoirCard("only-new")];
    const s = snapshot({ cards: reservoir });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.cardId).toBe("only-new");
    expect(decision.selectionReason).toBe("active_weighted_selection");
    expect(decision.trace.cardPriorityWeight).toBeCloseTo(1.0); // FRESH base weight, 0 aging draws
    expect(s.cards[0].cardStatus).toBe("NEW"); // original untouched
  });
});

// =============================================================================
// SOURCE POLICY
// =============================================================================

describe("source policy nominal weights (section 10 of the brief, reusing Phase 6B exactly)", () => {
  const anchor = activeCard({ cardId: "anchor" });

  it("9. Due 0, pre-goal -> Active Focus (0.90/0.00/0.10)", () => {
    const s = snapshot({ cards: [anchor] });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.trace.sourceWeightsRaw).toEqual({ active: 0.9, due: 0.0, near: 0.1, randomMastered: 0 });
    expect(decision.trace.schedulerMode).toBe("pre_goal_active_focus");
  });

  it("10. Due 1-9, pre-goal -> Balanced (0.70/0.25/0.05)", () => {
    const s = snapshot({ cards: [anchor, ...dueCards(3)] });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.trace.sourceWeightsRaw).toEqual({ active: 0.7, due: 0.25, near: 0.05, randomMastered: 0 });
    expect(decision.trace.schedulerMode).toBe("pre_goal_balanced");
  });

  it("11. Due 10+, pre-goal -> Review Pressure (0.50/0.48/0.02)", () => {
    const s = snapshot({ cards: [anchor, ...dueCards(12)] });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.trace.sourceWeightsRaw).toEqual({ active: 0.5, due: 0.48, near: 0.02, randomMastered: 0 });
    expect(decision.trace.schedulerMode).toBe("pre_goal_review_pressure");
  });

  it("12. Due 0, post-goal -> Active Focus (0.80/0.00/0.20)", () => {
    const s = snapshot({ cards: [anchor], dailyGoalCompleted: true });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.trace.sourceWeightsRaw).toEqual({ active: 0.8, due: 0.0, near: 0.2, randomMastered: 0 });
    expect(decision.trace.schedulerMode).toBe("post_goal_active_focus");
  });

  it("13. Due 1-9, post-goal -> Balanced (0.75/0.15/0.10)", () => {
    const s = snapshot({ cards: [anchor, ...dueCards(3)], dailyGoalCompleted: true });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.trace.sourceWeightsRaw).toEqual({ active: 0.75, due: 0.15, near: 0.1, randomMastered: 0 });
    expect(decision.trace.schedulerMode).toBe("post_goal_balanced");
  });

  it("14. Due 10+, post-goal -> Review Pressure, unchanged (0.50/0.48/0.02)", () => {
    const s = snapshot({ cards: [anchor, ...dueCards(12)], dailyGoalCompleted: true });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.trace.sourceWeightsRaw).toEqual({ active: 0.5, due: 0.48, near: 0.02, randomMastered: 0 });
    expect(decision.trace.schedulerMode).toBe("post_goal_review_pressure");
  });
});

// =============================================================================
// RENORMALIZATION
// =============================================================================

describe("empty-source renormalization (section 11 of the brief, reusing Phase 6B exactly)", () => {
  it("15. empty NEAR is removed and ACTIVE renormalizes to 1.00 (Due 0 tier, no Near-Due candidates)", () => {
    const s = snapshot({ cards: [activeCard()] });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.trace.sourceWeightsNormalized).toEqual({ active: 1, due: 0, near: 0, randomMastered: 0 });
    expect(decision.source).toBe("ACTIVE");
  });

  it("16. an empty DUE source is never selected (Due 0 tier normalizes DUE's weight to exactly 0)", () => {
    const s = snapshot({ cards: [activeCard()] });
    const decision = chooseNextCard(s, scriptedRandom([0.99]));
    expect(decision.trace.sourceWeightsNormalized.due).toBe(0);
    expect(decision.source).not.toBe("FSRS_DUE");
  });

  it("17. ACTIVE with only a target-reached Repair candidate remains non-empty", () => {
    const repair = repairGovernedCard("repair-1", obligation("repair-1", 10, 20)); // target reached at 14, hard cap at 20 (not reached)
    const s = snapshot({ cards: [repair], schedulerPosition: 14 });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.trace.candidateCounts.active).toBe(1);
    expect(decision.trace.sourceWeightsNormalized.active).toBeGreaterThan(0);
    expect(decision.cardId).toBe("repair-1");
    expect(decision.selectionReason).toBe("repair_target");
  });

  it("18. ACTIVE with only a due Spaced Confirmation candidate remains non-empty", () => {
    const spaced = spacedConfirmationCard("spaced-1", 10);
    const s = snapshot({ cards: [spaced], schedulerPosition: 14 });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.trace.candidateCounts.active).toBe(1);
    expect(decision.cardId).toBe("spaced-1");
    expect(decision.selectionReason).toBe("spaced_confirmation");
  });

  it("19. a source with zero candidates is never sampled, across many RNG seeds, when it is the only available source", () => {
    const s = snapshot({ cards: [activeCard()] }); // ACTIVE is the only available source
    for (let seed = 1; seed <= 20; seed += 1) {
      const decision = chooseNextCard(s, lcg(seed));
      expect(decision.source).toBe("ACTIVE");
    }
  });
});

// =============================================================================
// SOURCE INTERNAL SELECTION
// =============================================================================

describe("ACTIVE internal ordering is preserved end-to-end (section 13 of the brief)", () => {
  it("20. starvation > repair target > spaced confirmation > ordinary Active", () => {
    const starved = activeCard({ cardId: "starved", activeDrawsSinceEligible: 40 });
    const repairTarget = repairGovernedCard("repair", obligation("repair", 10, 20));
    const spaced = spacedConfirmationCard("spaced", 10);
    const ordinary = activeCard({ cardId: "ordinary", learningStage: "LEARNING_1" });

    const all = [starved, repairTarget, spaced, ordinary];
    expect(chooseNextCard(snapshot({ cards: all, schedulerPosition: 14 }), scriptedRandom([0.5])).selectionReason).toBe("active_starvation");
    expect(
      chooseNextCard(snapshot({ cards: all.filter((c) => c.cardId !== "starved"), schedulerPosition: 14 }), scriptedRandom([0.5])).selectionReason,
    ).toBe("repair_target");
    expect(
      chooseNextCard(
        snapshot({ cards: all.filter((c) => c.cardId !== "starved" && c.cardId !== "repair"), schedulerPosition: 14 }),
        scriptedRandom([0.5]),
      ).selectionReason,
    ).toBe("spaced_confirmation");
    expect(chooseNextCard(snapshot({ cards: [ordinary], schedulerPosition: 14 }), scriptedRandom([0.5])).selectionReason).toBe(
      "active_weighted_selection",
    );
  });
});

describe("DUE/NEAR_DUE paths delegate to Phase 6C selectors unchanged", () => {
  it("21. the DUE path uses chooseDueCard's own weighting (lower R wins more often; verified via exact weight share)", () => {
    const low = outsideCard({ cardId: "low-r" }, { stability: 2 });
    const high = outsideCard({ cardId: "high-r" }, { stability: 50 });
    const s = snapshot({ cards: [low, high] }); // no ACTIVE, no NEAR_DUE candidates -> DUE is the only source
    const decision = chooseNextCard(s, scriptedRandom([0.01]));
    expect(decision.source).toBe("FSRS_DUE");
    expect(decision.selectionReason).toBe("due_weighted_selection");
    expect(decision.trace.retrievability).not.toBeNull();
  });

  it("22. the NEAR_DUE path uses chooseNearDueCard's own weighting", () => {
    const near = nearDueCard("near-1");
    const s = snapshot({ cards: [near] }); // no ACTIVE, no FSRS_DUE candidates -> NEAR_DUE is the only source
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.source).toBe("NEAR_DUE");
    expect(decision.selectionReason).toBe("near_due_weighted_selection");
    expect(decision.cardId).toBe("near-1");
    expect(decision.trace.intervalProgress).toBeCloseTo(0.8);
  });
});

// =============================================================================
// LARGE BACKLOG
// =============================================================================

describe("large Due backlog never suppresses ACTIVE (sections 23/24 of the brief)", () => {
  it("23. Due >= 10 preserves the exact nominal 0.50/0.48/0.02 split before renormalization", () => {
    const s = snapshot({ cards: [activeCard(), ...dueCards(15)] });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.trace.sourceWeightsRaw).toEqual({ active: 0.5, due: 0.48, near: 0.02, randomMastered: 0 });
  });

  it("24. no legacy 'review all Due first' behavior -- ACTIVE keeps a substantial, nonzero share even under a large Due backlog", () => {
    const s = snapshot({ cards: [activeCard(), ...dueCards(50)] });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.trace.sourceWeightsNormalized.active).toBeGreaterThan(0.4);
  });
});

// =============================================================================
// EMERGENCY FALLBACK
// =============================================================================

describe("emergency cooldown relaxation (sections 14-15 of the brief)", () => {
  it("25. all normal sources unavailable due only to ordinary Active cooldown: relaxation selects the closest-to-eligible card", () => {
    const soon = activeCard({ cardId: "soon", correctCooldownUntilPosition: 12 });
    const later = activeCard({ cardId: "later", correctCooldownUntilPosition: 20 });
    const s = snapshot({ cards: [soon, later], schedulerPosition: 10 });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.trace.candidateCounts.active).toBe(0); // no ordinary/starvation/repair/spaced candidate exists
    expect(decision.selectionReason).toBe("emergency_cooldown_relaxation");
    expect(decision.source).toBe("ACTIVE");
    expect(decision.cardId).toBe("soon");
    expect(decision.trace.emergencyFallbackApplied).toBe(true);
  });

  it("26. an exact tie in correctCooldownUntilPosition uses the injected RNG", () => {
    const a = activeCard({ cardId: "a", correctCooldownUntilPosition: 20 });
    const b = activeCard({ cardId: "b", correctCooldownUntilPosition: 20 });
    const s = snapshot({ cards: [a, b], schedulerPosition: 10 });
    const low = chooseNextCard(s, scriptedRandom([0])); // index 0 -> "a"
    const high = chooseNextCard(s, scriptedRandom([0.99])); // index 1 -> "b"
    expect(low.cardId).toBe("a");
    expect(high.cardId).toBe("b");
  });

  it("27. a repair-governed card is never relaxed into the ORDINARY (cooldown) emergency fallback -- it is rescued only by the distinct Repair liveness fallback instead", () => {
    // wrongPosition 10 -> target 14, hard cap 17; at position 11 neither is reached yet, so this
    // card contributes nothing through the repair_target channel either -- the only question is
    // whether the ORDINARY cooldown-relaxation branch incorrectly relaxes it anyway (it must not;
    // see the Repair liveness fallback block below for what DOES happen to this exact scenario
    // post-RC-F-audit-fix).
    const governed = repairGovernedCard("governed", obligation("governed", 10, 17), { correctCooldownUntilPosition: 20 });
    const s = snapshot({ cards: [governed], schedulerPosition: 11 });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.selectionReason).not.toBe("emergency_cooldown_relaxation");
    expect(decision.selectionReason).toBe("emergency_repair_relaxation");
    expect(decision.cardId).toBe("governed");
  });

  it("28. a SPACED_CONFIRMATION_PENDING card whose gate has not opened is never relaxed into the ORDINARY (cooldown) emergency fallback -- it is rescued only by the distinct Repair liveness fallback instead", () => {
    const spaced = spacedConfirmationCard("spaced-1", 50); // gate position far in the future
    const s = snapshot({ cards: [spaced], schedulerPosition: 10 });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.selectionReason).not.toBe("emergency_cooldown_relaxation");
    expect(decision.selectionReason).toBe("emergency_repair_relaxation");
    expect(decision.cardId).toBe("spaced-1");
  });

  it("29. a within-day repair before its minimum gap is never relaxed by the ORDINARY cooldown fallback, even though it is the only card in the deck -- the Repair liveness fallback (not the ordinary one) is what rescues it", () => {
    const pending = repairGovernedCard("pending", obligation("pending", 10, 17)); // target 14, hard cap 17, neither reached
    const s = snapshot({ cards: [pending], schedulerPosition: 11 });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.selectionReason).not.toBe("emergency_cooldown_relaxation");
    expect(decision.selectionReason).toBe("emergency_repair_relaxation");
    expect(decision.cardId).toBe("pending");
  });

  it("30. no safe candidate at all -> no_card_all_unavailable, never throws", () => {
    const s = snapshot({ cards: [] });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.cardId).toBeNull();
    expect(decision.source).toBeNull();
    expect(decision.selectionReason).toBe("no_card_all_unavailable");
    expect(decision.trace.emergencyFallbackApplied).toBe(true);
  });
});

// =============================================================================
// REPAIR LIVENESS FALLBACK (approved RC-F small-deck audit follow-up)
// =============================================================================

describe("Repair liveness fallback (approved RC-F small-deck audit follow-up)", () => {
  it("40. 1-card deck: Repair-governed, target not yet reached, no other candidate -> rescued by the fallback, never no_card_all_unavailable, never ordinary cooldown relaxation", () => {
    const pending = repairGovernedCard("pending", obligation("pending", 10, 17)); // target 14, hard cap 17, neither reached at position 11
    const s = snapshot({ cards: [pending], schedulerPosition: 11 });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.cardId).toBe("pending");
    expect(decision.source).toBe("ACTIVE");
    expect(decision.selectionReason).toBe("emergency_repair_relaxation");
    expect(decision.trace.emergencyFallbackApplied).toBe(true);
  });

  it("41. a SPACED_CONFIRMATION_PENDING card (the relearning shape, no repairObligation) is rescued the same way once it is the only live candidate", () => {
    const spaced = spacedConfirmationCard("spaced-1", 50); // gate far in the future
    const s = snapshot({ cards: [spaced], schedulerPosition: 10 });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.cardId).toBe("spaced-1");
    expect(decision.selectionReason).toBe("emergency_repair_relaxation");
  });

  it("A. 2-card deck: both cards become Repair-governed before either can normally return -> fallback selects the soonest target", () => {
    const a = repairGovernedCard("a", obligation("a", 10, 17)); // target 14
    const b = repairGovernedCard("b", obligation("b", 12, 19)); // target 16
    const s = snapshot({ cards: [a, b], schedulerPosition: 13 });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.cardId).toBe("a"); // soonest target (14 < 16)
    expect(decision.selectionReason).toBe("emergency_repair_relaxation");
  });

  it("B. 5-card deck: all five currently selectable cards become Repair-governed and no target is ready -> fallback selects the soonest among all five", () => {
    const cards = ["a", "b", "c", "d", "e"].map((id, i) => repairGovernedCard(id, obligation(id, 10 + i, 20 + i)));
    // targets: a=14, b=15, c=16, d=17, e=18 -- none reached at position 13
    const s = snapshot({ cards, schedulerPosition: 13 });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.cardId).toBe("a");
    expect(decision.selectionReason).toBe("emergency_repair_relaxation");
  });

  it("C. control: the fallback never activates while any normal selectable candidate exists (ordinary Active, ordinary-cooldown-relaxable, or target-reached repair)", () => {
    const ordinary = activeCard({ cardId: "ordinary" });
    const governed = repairGovernedCard("governed", obligation("governed", 10, 17));
    const s = snapshot({ cards: [ordinary, governed], schedulerPosition: 11 });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.cardId).toBe("ordinary");
    expect(decision.selectionReason).not.toBe("emergency_repair_relaxation");

    // Also: when an ordinary-cooldown-relaxable card exists alongside a
    // governed one, the EXISTING ordinary fallback wins -- this fallback
    // is strictly last-resort, never a competing/earlier check.
    const cooling = activeCard({ cardId: "cooling", correctCooldownUntilPosition: 30 });
    const alsoGoverned = repairGovernedCard("governed-2", obligation("governed-2", 10, 17));
    const s2 = snapshot({ cards: [cooling, alsoGoverned], schedulerPosition: 11 });
    const decision2 = chooseNextCard(s2, scriptedRandom([0.5]));
    expect(decision2.cardId).toBe("cooling");
    expect(decision2.selectionReason).toBe("emergency_cooldown_relaxation");
  });

  it("D. control: once a Repair target is legitimately reached, normal repair_target selection wins -- never emergency_repair_relaxation", () => {
    const pending = repairGovernedCard("pending", obligation("pending", 10, 17)); // target 14
    const s = snapshot({ cards: [pending], schedulerPosition: 14 }); // target reached exactly
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.cardId).toBe("pending");
    expect(decision.selectionReason).toBe("repair_target");
  });

  it("E. tie-break: two Repair-governed cards with the identical soonest target use the injected RNG, same convention as every other selector", () => {
    const a = repairGovernedCard("a", obligation("a", 10, 17)); // target 14
    const b = repairGovernedCard("b", obligation("b", 10, 18)); // also wrongPosition 10 -> target 14, different hard cap
    const s = snapshot({ cards: [a, b], schedulerPosition: 11 });
    const low = chooseNextCard(s, scriptedRandom([0])); // index 0 -> "a"
    const high = chooseNextCard(s, scriptedRandom([0.99])); // index 1 -> "b"
    expect(low.cardId).toBe("a");
    expect(high.cardId).toBe("b");
    expect(low.selectionReason).toBe("emergency_repair_relaxation");
    expect(high.selectionReason).toBe("emergency_repair_relaxation");
  });

  it("fixed-point regression: re-evaluating the identical frozen 1-card state no longer repeats no_card_all_unavailable", () => {
    const pending = repairGovernedCard("pending", obligation("pending", 10, 17));
    const s = snapshot({ cards: [pending], schedulerPosition: 11 });
    const first = chooseNextCard(s, scriptedRandom([0.5]));
    const second = chooseNextCard(s, scriptedRandom([0.5])); // identical snapshot, as if nothing could be answered before -- but now something CAN be
    expect(first.selectionReason).toBe("emergency_repair_relaxation");
    expect(second.selectionReason).toBe("emergency_repair_relaxation");
    expect(first.cardId).toBe("pending");
    expect(second.cardId).toBe("pending");
  });
});

// =============================================================================
// REPAIR LIVENESS FALLBACK -- POST-MASTERY EXTENSION (approved RC-F
// small-deck audit follow-up, Post-Mastery classification C fix)
// =============================================================================

describe("Repair liveness fallback, Post-Mastery mode (approved RC-F audit follow-up)", () => {
  function lapsedMasteredCard(cardId: string, obligation: RepairObligation): SchedulableCardRow {
    return repairGovernedCard(cardId, obligation, {
      cardStatus: "FORGOTTEN",
      learningStage: null,
      relearningPhase: "REPAIR_PENDING",
      hasEverBeenMastered: true,
    });
  }

  it("A. 1-card fully-mastered deck: the card lapses into relearning, Repair gate not reached, no other candidate -> rescued via emergency_repair_relaxation, not no_card_all_unavailable", () => {
    const lapsed = lapsedMasteredCard("lapsed", obligation("lapsed", 10, 17)); // target 14, hard cap 17, neither reached at position 11
    const s = snapshot({ cards: [lapsed], schedulerPosition: 11, hasAchievedFullMastery: true });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.trace.schedulerMode.startsWith("post_mastery_")).toBe(true);
    expect(decision.cardId).toBe("lapsed");
    expect(decision.source).toBe("ACTIVE");
    expect(decision.selectionReason).toBe("emergency_repair_relaxation");
    expect(decision.trace.emergencyFallbackApplied).toBe(true);
  });

  it("B. fixed-point regression: re-evaluating the identical frozen Post-Mastery Repair-only snapshot no longer remains permanently stuck", () => {
    const lapsed = lapsedMasteredCard("lapsed", obligation("lapsed", 10, 17));
    const s = snapshot({ cards: [lapsed], schedulerPosition: 11, hasAchievedFullMastery: true });
    const first = chooseNextCard(s, scriptedRandom([0.5]));
    const second = chooseNextCard(s, scriptedRandom([0.5])); // identical snapshot
    expect(first.selectionReason).toBe("emergency_repair_relaxation");
    expect(second.selectionReason).toBe("emergency_repair_relaxation");
    expect(first.cardId).toBe("lapsed");
    expect(second.cardId).toBe("lapsed");
  });

  it("C. multiple Repair-governed lapsed/mastered cards, no target ready -> fallback selects the soonest normal target", () => {
    const a = lapsedMasteredCard("a", obligation("a", 10, 17)); // target 14
    const b = lapsedMasteredCard("b", obligation("b", 12, 19)); // target 16
    const s = snapshot({ cards: [a, b], schedulerPosition: 13, hasAchievedFullMastery: true });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.cardId).toBe("a"); // soonest target (14 < 16)
    expect(decision.selectionReason).toBe("emergency_repair_relaxation");
  });

  it("D. control: a normal Due candidate alongside a not-yet-due Repair-governed lapsed card -> ordinary Post-Mastery selection wins, the liveness fallback never fires", () => {
    const due = outsideCard({ cardId: "due", cardStatus: "LEARNED", hasEverBeenMastered: true });
    const lapsed = lapsedMasteredCard("lapsed", obligation("lapsed", 10, 17));
    const s = snapshot({ cards: [due, lapsed], schedulerPosition: 11, hasAchievedFullMastery: true });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.trace.schedulerMode.startsWith("post_mastery_")).toBe(true);
    expect(decision.cardId).toBe("due");
    expect(decision.selectionReason).not.toBe("emergency_repair_relaxation");
  });

  it("E. control: once a Repair target is legitimately reached in Post-Mastery mode, normal repair_target selection wins -- never emergency_repair_relaxation", () => {
    const lapsed = lapsedMasteredCard("lapsed", obligation("lapsed", 10, 17)); // target 14
    const s = snapshot({ cards: [lapsed], schedulerPosition: 14, hasAchievedFullMastery: true }); // target reached exactly
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.cardId).toBe("lapsed");
    expect(decision.selectionReason).toBe("repair_target");
  });

  it("F. empty Post-Mastery deck: truly no candidate anywhere -> normal no_card_all_unavailable, never fabricates a Repair candidate", () => {
    const s = snapshot({ cards: [], hasAchievedFullMastery: true });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.cardId).toBeNull();
    expect(decision.source).toBeNull();
    expect(decision.selectionReason).toBe("no_card_all_unavailable");
    expect(decision.trace.emergencyFallbackApplied).toBe(true);
  });
});

// =============================================================================
// TRACE
// =============================================================================

describe("SelectionTrace completeness and correctness (section 18 of the brief)", () => {
  it("31. trace.selectionReason/source/cardId always match the top-level decision fields", () => {
    const scenarios = [
      snapshot({ cards: [activeCard()] }),
      snapshot({ cards: [repairGovernedCard("r", obligation("r", 10, 17))], schedulerPosition: 17 }),
      snapshot({ cards: [] }),
    ];
    for (const s of scenarios) {
      const decision = chooseNextCard(s, scriptedRandom([0.5]));
      expect(decision.trace.cardId).toBe(decision.cardId);
      expect(decision.trace.source).toBe(decision.source);
      expect(decision.trace.selectionReason).toBe(decision.selectionReason);
    }
  });

  it("32. normalized weights always sum to 1 (or to 0 only in the all-unavailable emergency case)", () => {
    const withActive = chooseNextCard(snapshot({ cards: [activeCard(), ...dueCards(3)] }), scriptedRandom([0.5]));
    const sum = withActive.trace.sourceWeightsNormalized.active + withActive.trace.sourceWeightsNormalized.due + withActive.trace.sourceWeightsNormalized.near;
    expect(sum).toBeCloseTo(1);

    const allUnavailable = chooseNextCard(snapshot({ cards: [] }), scriptedRandom([0.5]));
    expect(allUnavailable.trace.sourceWeightsNormalized).toEqual({ active: 0, due: 0, near: 0, randomMastered: 0 });
  });

  it("33. trace.candidateCounts.active reflects the virtually refilled projection, not the pre-refill snapshot", () => {
    const reservoir = Array.from({ length: 6 }, (_, i) => reservoirCard(`new-${i}`));
    const decision = chooseNextCard(snapshot({ cards: reservoir }), scriptedRandom([0.5]));
    expect(decision.trace.candidateCounts.active).toBe(6); // all 6 admitted cards are ordinary (effective FRESH) candidates
  });

  it("34. trace includes schedulerPosition/schedulerRevision/policyVersion", () => {
    const s = snapshot({ cards: [activeCard()], schedulerPosition: 42, schedulerRevision: 7, policyVersion: "learning-engine-v1.0" });
    const decision = chooseNextCard(s, scriptedRandom([0.5]));
    expect(decision.schedulerPosition).toBe(42);
    expect(decision.schedulerRevision).toBe(7);
    expect(decision.trace.schedulerPosition).toBe(42);
    expect(decision.trace.schedulerRevision).toBe(7);
    expect(decision.trace.policyVersion).toBe("learning-engine-v1.0");
  });

  it("35. emergencyFallbackApplied is true only for the three emergency outcomes, false otherwise", () => {
    const ordinary = chooseNextCard(snapshot({ cards: [activeCard()] }), scriptedRandom([0.5]));
    expect(ordinary.trace.emergencyFallbackApplied).toBe(false);

    const interrupt = chooseNextCard(
      snapshot({ cards: [repairGovernedCard("r", obligation("r", 10, 17))], schedulerPosition: 17 }),
      scriptedRandom([0.5]),
    );
    expect(interrupt.trace.emergencyFallbackApplied).toBe(false);

    const emergency = chooseNextCard(snapshot({ cards: [activeCard({ correctCooldownUntilPosition: 20 })], schedulerPosition: 10 }), scriptedRandom([0.5]));
    expect(emergency.trace.emergencyFallbackApplied).toBe(true);
    expect(emergency.selectionReason).toBe("emergency_cooldown_relaxation");

    const repairLiveness = chooseNextCard(
      snapshot({ cards: [repairGovernedCard("pending", obligation("pending", 10, 17))], schedulerPosition: 11 }),
      scriptedRandom([0.5]),
    );
    expect(repairLiveness.trace.emergencyFallbackApplied).toBe(true);
    expect(repairLiveness.selectionReason).toBe("emergency_repair_relaxation");

    const noCard = chooseNextCard(snapshot({ cards: [] }), scriptedRandom([0.5]));
    expect(noCard.trace.emergencyFallbackApplied).toBe(true);
  });

  it("36. trace.randomDraws exactly matches the sequence the injected RandomSource actually produced", () => {
    const s = snapshot({ cards: [activeCard(), ...dueCards(3), nearDueCard("near-1")] });
    const seed = 777;
    const decision = chooseNextCard(s, lcg(seed));

    const replay = lcg(seed);
    const expectedDraws = decision.trace.randomDraws.map(() => replay());
    expect(decision.trace.randomDraws).toEqual(expectedDraws);
  });
});

// =============================================================================
// DETERMINISM
// =============================================================================

describe("determinism (section 20 of the brief)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("37. identical snapshot + identical RNG sequence -> identical NextCardDecision", () => {
    const s = snapshot({ cards: [activeCard(), ...dueCards(3), nearDueCard("near-1")] });
    const run = () => chooseNextCard(s, lcg(42));
    expect(run()).toEqual(run());
  });

  it("38. the original snapshot remains deeply unchanged after a decision", () => {
    const s = snapshot({ cards: [activeCard(), ...dueCards(3), nearDueCard("near-1"), reservoirCard("new-1")] });
    const before = JSON.parse(JSON.stringify(s));
    chooseNextCard(s, lcg(42));
    expect(JSON.parse(JSON.stringify(s))).toEqual(before);
  });

  it("39. Math.random is never called directly, across refill + interrupt + ordinary + emergency paths", () => {
    const spy = vi.spyOn(Math, "random");
    const scenarios = [
      snapshot({ cards: [reservoirCard("new-1"), ...dueCards(3), nearDueCard("near-1")] }),
      snapshot({ cards: [repairGovernedCard("r", obligation("r", 10, 17))], schedulerPosition: 17 }),
      snapshot({ cards: [activeCard({ correctCooldownUntilPosition: 20 }), activeCard({ cardId: "b", correctCooldownUntilPosition: 20 })], schedulerPosition: 10 }),
      snapshot({ cards: [] }),
    ];
    for (const s of scenarios) {
      chooseNextCard(s, scriptedRandom([0.3, 0.6, 0.1]));
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// FIRST-PASS QUEUE (first-pass clarification review)
// =============================================================================

describe("first-pass queue: lockout semantics", () => {
  it("1-3. six ACTIVE+NEW+never-presented cards snapshot into one randomized queue, and across six selections all six are presented exactly once before any repeats", () => {
    let cards: SchedulableCardRow[] = Array.from({ length: 6 }, (_, i) => neverPresentedActiveCard(`card-${i}`));
    let firstPassQueue: readonly string[] | null = null;
    const presentedIds: string[] = [];

    for (let i = 0; i < 6; i += 1) {
      const s = snapshot({ cards, firstPassQueue });
      const decision = chooseNextCard(s, lcg(100 + i));
      expect(decision.selectionReason).toBe("active_first_pass");
      expect(decision.source).toBe("ACTIVE");
      expect(decision.cardId).not.toBeNull();
      expect(presentedIds).not.toContain(decision.cardId); // no repeat before exhaustion

      presentedIds.push(decision.cardId!);
      cards = cards.map((c) => (c.cardId === decision.cardId ? presented(c) : c));
      firstPassQueue = decision.firstPassQueueAfter;
    }

    expect(new Set(presentedIds).size).toBe(6);
    expect(firstPassQueue).toBeNull(); // exhausted after the 6th
  });

  it("4. once a served card transitions to LEARNING, it cannot re-enter ordinary Active selection while the queue still has remaining members", () => {
    const cards: SchedulableCardRow[] = Array.from({ length: 6 }, (_, i) => neverPresentedActiveCard(`card-${i}`));
    const s1 = snapshot({ cards, firstPassQueue: null });
    const decision1 = chooseNextCard(s1, lcg(7));
    expect(decision1.selectionReason).toBe("active_first_pass");
    const servedId = decision1.cardId!;
    expect(decision1.firstPassQueueAfter).not.toBeNull();
    expect(decision1.firstPassQueueAfter).toHaveLength(5);

    // The served card is now LEARNING/FRESH -- an ordinarily-eligible Active
    // candidate (no cooldown) -- yet the queue still has 5 unserved members.
    const cardsAfter = cards.map((c) => (c.cardId === servedId ? presented(c) : c));
    const s2 = snapshot({ cards: cardsAfter, firstPassQueue: decision1.firstPassQueueAfter });
    const decision2 = chooseNextCard(s2, lcg(8));

    expect(decision2.selectionReason).toBe("active_first_pass");
    expect(decision2.cardId).not.toBe(servedId); // must NOT reappear via any ordinary path
    expect(decision1.firstPassQueueAfter).toContain(decision2.cardId);
  });

  it("5. newly admitted NEW cards during an in-flight first-pass do not join or reorder the existing queue", () => {
    // Only 3 cards in this batch (not 6) so the Fresh limit (6) has
    // headroom left for the late admission below to actually be admitted.
    const cards: SchedulableCardRow[] = Array.from({ length: 3 }, (_, i) => neverPresentedActiveCard(`card-${i}`));
    const decision1 = chooseNextCard(snapshot({ cards, firstPassQueue: null }), lcg(42));
    const queueAfterFirst = decision1.firstPassQueueAfter!;
    expect(queueAfterFirst).toHaveLength(2);

    const cardsAfter = cards.map((c) => (c.cardId === decision1.cardId ? presented(c) : c));
    // A brand-new NEW card is admitted (via the reservoir) WHILE the batch is still in flight.
    const withNewAdmission = [...cardsAfter, reservoirCard("late-admit")];
    const decision2 = chooseNextCard(snapshot({ cards: withNewAdmission, firstPassQueue: queueAfterFirst }), lcg(43));

    expect(decision2.admittedCardIds).toContain("late-admit"); // refill still happens
    expect(decision2.selectionReason).toBe("active_first_pass");
    expect(decision2.cardId).not.toBe("late-admit"); // but it never jumps the queue
    expect(decision2.firstPassQueueAfter).not.toContain("late-admit"); // nor joins it
    // Membership/order of the ORIGINAL remaining queue is otherwise untouched
    // apart from removing the one member actually served this decision.
    expect([decision2.cardId, ...decision2.firstPassQueueAfter!].sort()).toEqual([...queueAfterFirst].sort());
  });

  it("6. a Repair hard-cap interrupt may preempt the queue", () => {
    const queue = ["a", "f", "b", "c", "e"];
    const cards: SchedulableCardRow[] = [
      ...queue.map((id) => presented(neverPresentedActiveCard(id))), // already LEARNING, mid-batch
      repairGovernedCard("repair-1", obligation("repair-1", 10, 17)),
    ];
    const decision = chooseNextCard(snapshot({ cards, firstPassQueue: queue, schedulerPosition: 17 }), scriptedRandom([0.5]));
    expect(decision.selectionReason).toBe("repair_hard_cap");
    expect(decision.cardId).toBe("repair-1");
  });

  it("7. a Critical Due interrupt may preempt the queue", () => {
    const queue = ["a", "f", "b", "c", "e"];
    const cards: SchedulableCardRow[] = [...queue.map((id) => presented(neverPresentedActiveCard(id))), criticallyDueCard("critical", 0.2)];
    const decision = chooseNextCard(snapshot({ cards, firstPassQueue: queue }), scriptedRandom([0.5]));
    expect(decision.selectionReason).toBe("critical_due_interrupt");
    expect(decision.cardId).toBe("critical");
  });

  it("8. the remaining queue resumes intact, unreordered, after a global interrupt preempts it", () => {
    const queue = ["a", "f", "b", "c", "e"];
    const cards: SchedulableCardRow[] = [
      ...queue.map((id) => presented(neverPresentedActiveCard(id))),
      repairGovernedCard("repair-1", obligation("repair-1", 10, 17)),
    ];
    const s = snapshot({ cards, firstPassQueue: queue, schedulerPosition: 17 });

    const interrupted = chooseNextCard(s, scriptedRandom([0.5]));
    expect(interrupted.selectionReason).toBe("repair_hard_cap");
    expect(interrupted.firstPassQueueAfter).toEqual(queue); // completely untouched

    // The NEXT decision, with the repair obligation resolved (removed) and
    // the same unchanged queue fed back in, resumes serving from the front.
    const cardsResolved = cards.filter((c) => c.cardId !== "repair-1");
    const resumed = chooseNextCard(snapshot({ cards: cardsResolved, firstPassQueue: interrupted.firstPassQueueAfter }), scriptedRandom([0.5]));
    expect(resumed.selectionReason).toBe("active_first_pass");
    expect(resumed.cardId).toBe("a"); // original front of the queue, unreordered
    expect(resumed.firstPassQueueAfter).toEqual(["f", "b", "c", "e"]);
  });

  it("9. no other ordinary scheduler path bypasses a non-empty first-pass queue, across many competing candidates and RNG seeds", () => {
    const queue = ["a", "f", "b", "c", "e"];
    const cards: SchedulableCardRow[] = [
      ...queue.map((id) => presented(neverPresentedActiveCard(id))),
      activeCard({ cardId: "starved", activeDrawsSinceEligible: 1000 }),
      repairGovernedCard("target-repair", obligation("target-repair", 10, 100)), // target-reached, far from hard cap
      spacedConfirmationCard("spaced", 0),
      ...dueCards(15),
      nearDueCard("near-1"),
    ];
    const s = snapshot({ cards, firstPassQueue: queue, schedulerPosition: 50, dailyGoalCompleted: true });

    for (let seed = 1; seed <= 15; seed += 1) {
      const decision = chooseNextCard(s, lcg(seed));
      expect(decision.selectionReason).toBe("active_first_pass");
      expect(decision.cardId).toBe("a"); // always the queue's own front, never any competing candidate
    }
  });

  it("10. once the queue is fully exhausted, previously-presented batch members return to ordinary Active selection under normal rules", () => {
    let cards: SchedulableCardRow[] = Array.from({ length: 3 }, (_, i) => neverPresentedActiveCard(`card-${i}`));
    let firstPassQueue: readonly string[] | null = null;

    for (let i = 0; i < 3; i += 1) {
      const decision = chooseNextCard(snapshot({ cards, firstPassQueue }), lcg(200 + i));
      cards = cards.map((c) => (c.cardId === decision.cardId ? presented(c) : c));
      firstPassQueue = decision.firstPassQueueAfter;
    }
    expect(firstPassQueue).toBeNull();

    // Now every card is LEARNING/FRESH with no cooldown and no queue --
    // ordinary weighted Active selection takes back over, and ANY of the
    // three (including the very first one served) can be chosen again.
    const decision = chooseNextCard(snapshot({ cards, firstPassQueue: null }), scriptedRandom([0.5]));
    expect(decision.selectionReason).toBe("active_weighted_selection");
    expect(["card-0", "card-1", "card-2"]).toContain(decision.cardId);
  });
});
