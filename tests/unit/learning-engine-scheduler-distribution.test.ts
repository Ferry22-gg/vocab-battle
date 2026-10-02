import { describe, expect, it } from "vitest";

import { createSeededRandom, makeActiveCard, makeCriticallyDueCard, makeDueCards, makeNearDueCard, SchedulerSimulation } from "../helpers/learning-engine-simulation";
import { chooseNextCard } from "@/lib/learning-engine/scheduler/next-card";
import type { DeckSchedulerSnapshot } from "@/lib/learning-engine/scheduler/snapshot";

/**
 * Phase 6F: FIXED-SNAPSHOT distribution tests (Phase 6F brief section 4B).
 *
 * Unlike tests/unit/learning-engine-scheduler-simulation.test.ts (which
 * mutates state via the real commit layer across many draws), every test
 * here calls chooseNextCard() repeatedly against the SAME immutable
 * snapshot with a continuing seeded RandomSource stream -- never mutating
 * Due/Active/Near-Due state between draws, so the nominal source weights
 * stay fixed and directly comparable to the empirical draw frequencies.
 *
 * ---------------------------------------------------------------------
 * Sample size and tolerance (documented, per the brief's explicit ask)
 * ---------------------------------------------------------------------
 * N = 5,000 draws per regime. For a Bernoulli-like proportion with true
 * probability p and n=5,000, the standard deviation of the empirical
 * proportion is sqrt(p(1-p)/n) -- at most ~0.0071 (at p=0.5) and as low as
 * ~0.0014 (at p=0.02, the smallest nominal weight anywhere in the spec's
 * tables). A tolerance of 0.04 absolute is therefore >5 standard
 * deviations even at the worst (largest-variance) case, making a spurious
 * failure astronomically unlikely, while still easily catching a
 * materially broken distribution (e.g. a source silently getting double
 * or zero its nominal share).
 */

const SAMPLE_SIZE = 5000;
const TOLERANCE = 0.04;

function buildDistributionSnapshot(params: { dueCount: number; dailyGoalCompleted: boolean }): DeckSchedulerSnapshot {
  const sim = new SchedulerSimulation({
    cards: [
      ...Array.from({ length: 30 }, (_, i) => makeActiveCard(`active-${i}`, { learningStage: "LEARNING_1" })),
      ...makeDueCards(params.dueCount),
      ...Array.from({ length: 10 }, (_, i) => makeNearDueCard(`near-${i}`)),
    ],
    random: createSeededRandom(1), // unused for snapshot construction itself
    dailyGoal: { enemiesDefeatedToday: 0, completed: params.dailyGoalCompleted },
  });
  return sim.snapshot();
}

function sampleSourceDistribution(snapshot: DeckSchedulerSnapshot, seed: number, n: number): { active: number; due: number; near: number } {
  const random = createSeededRandom(seed);
  const counts = { active: 0, due: 0, near: 0 };
  for (let i = 0; i < n; i += 1) {
    const decision = chooseNextCard(snapshot, random);
    if (decision.source === "ACTIVE") {
      counts.active += 1;
    } else if (decision.source === "FSRS_DUE") {
      counts.due += 1;
    } else if (decision.source === "NEAR_DUE") {
      counts.near += 1;
    }
  }
  return { active: counts.active / n, due: counts.due / n, near: counts.near / n };
}

function expectCloseToWeights(empirical: { active: number; due: number; near: number }, nominal: { active: number; due: number; near: number }): void {
  expect(empirical.active).toBeGreaterThanOrEqual(nominal.active - TOLERANCE);
  expect(empirical.active).toBeLessThanOrEqual(nominal.active + TOLERANCE);
  expect(empirical.due).toBeGreaterThanOrEqual(nominal.due - TOLERANCE);
  expect(empirical.due).toBeLessThanOrEqual(nominal.due + TOLERANCE);
  expect(empirical.near).toBeGreaterThanOrEqual(nominal.near - TOLERANCE);
  expect(empirical.near).toBeLessThanOrEqual(nominal.near + TOLERANCE);
}

describe("source policy distribution (Phase 6F brief section 10): empirical draw frequencies match nominal weights", () => {
  it("pre-goal, Due 0 -> Active Focus (0.90/0.00/0.10)", () => {
    const snapshot = buildDistributionSnapshot({ dueCount: 0, dailyGoalCompleted: false });
    const empirical = sampleSourceDistribution(snapshot, 11, SAMPLE_SIZE);
    expectCloseToWeights(empirical, { active: 0.9, due: 0.0, near: 0.1 });
  });

  it("pre-goal, Due 1-9 -> Balanced (0.70/0.25/0.05)", () => {
    const snapshot = buildDistributionSnapshot({ dueCount: 5, dailyGoalCompleted: false });
    const empirical = sampleSourceDistribution(snapshot, 12, SAMPLE_SIZE);
    expectCloseToWeights(empirical, { active: 0.7, due: 0.25, near: 0.05 });
  });

  it("pre-goal, Due 10+ -> Review Pressure (0.50/0.48/0.02)", () => {
    const snapshot = buildDistributionSnapshot({ dueCount: 15, dailyGoalCompleted: false });
    const empirical = sampleSourceDistribution(snapshot, 13, SAMPLE_SIZE);
    expectCloseToWeights(empirical, { active: 0.5, due: 0.48, near: 0.02 });
  });

  it("post-goal, Due 0 -> Active Focus (0.80/0.00/0.20)", () => {
    const snapshot = buildDistributionSnapshot({ dueCount: 0, dailyGoalCompleted: true });
    const empirical = sampleSourceDistribution(snapshot, 14, SAMPLE_SIZE);
    expectCloseToWeights(empirical, { active: 0.8, due: 0.0, near: 0.2 });
  });

  it("post-goal, Due 1-9 -> Balanced (0.75/0.15/0.10)", () => {
    const snapshot = buildDistributionSnapshot({ dueCount: 5, dailyGoalCompleted: true });
    const empirical = sampleSourceDistribution(snapshot, 15, SAMPLE_SIZE);
    expectCloseToWeights(empirical, { active: 0.75, due: 0.15, near: 0.1 });
  });

  it("post-goal, Due 10+ -> Review Pressure, unchanged (0.50/0.48/0.02)", () => {
    const snapshot = buildDistributionSnapshot({ dueCount: 15, dailyGoalCompleted: true });
    const empirical = sampleSourceDistribution(snapshot, 16, SAMPLE_SIZE);
    expectCloseToWeights(empirical, { active: 0.5, due: 0.48, near: 0.02 });
  });
});

describe("large Due backlog (Phase 6F brief section 11)", () => {
  it("hundreds of Due cards never trigger 'review all Due first' -- the nominal Review Pressure split (0.50/0.48/0.02) holds, Active appears materially, Near-Due remains possible", () => {
    const snapshot = buildDistributionSnapshot({ dueCount: 500, dailyGoalCompleted: false });
    const empirical = sampleSourceDistribution(snapshot, 21, SAMPLE_SIZE);
    expectCloseToWeights(empirical, { active: 0.5, due: 0.48, near: 0.02 });
    expect(empirical.active).toBeGreaterThan(0.3); // ACTIVE still appears materially, not crowded out
    expect(empirical.near).toBeGreaterThan(0); // NEAR_DUE remains reachable
  });

  it("Critical Due safety still operates above the normal source mix even with a huge Due backlog", () => {
    const sim = new SchedulerSimulation({
      cards: [
        ...Array.from({ length: 10 }, (_, i) => makeActiveCard(`active-${i}`, { learningStage: "LEARNING_1" })),
        ...makeDueCards(300),
        makeCriticallyDueCard("critical-1", 0.1),
      ],
      random: createSeededRandom(22),
    });
    let sawCritical = false;
    for (let i = 0; i < 30 && !sawCritical; i += 1) {
      const decision = sim.step(true);
      if (decision.selectionReason === "critical_due_interrupt") {
        sawCritical = true;
      }
    }
    expect(sawCritical).toBe(true);
  });
});

describe("empty-source renormalization across combinations (Phase 6F brief section 12)", () => {
  function activeOnlyCards() {
    return [makeActiveCard("a", { learningStage: "LEARNING_1" }), makeActiveCard("b", { learningStage: "LEARNING_2" })];
  }

  it("ACTIVE only -> every draw selects ACTIVE, normalized weights are {1,0,0}", () => {
    const sim = new SchedulerSimulation({ cards: activeOnlyCards(), random: createSeededRandom(31) });
    const snapshot = sim.snapshot();
    const random = createSeededRandom(32);
    for (let i = 0; i < 50; i += 1) {
      const decision = chooseNextCard(snapshot, random);
      expect(decision.source).toBe("ACTIVE");
      expect(decision.trace.sourceWeightsNormalized).toEqual({ active: 1, due: 0, near: 0 });
    }
  });

  it("DUE only -> every draw selects FSRS_DUE, normalized weights are {0,1,0}", () => {
    const sim = new SchedulerSimulation({ cards: makeDueCards(5), random: createSeededRandom(33) });
    const snapshot = sim.snapshot();
    const random = createSeededRandom(34);
    for (let i = 0; i < 50; i += 1) {
      const decision = chooseNextCard(snapshot, random);
      expect(decision.source).toBe("FSRS_DUE");
      expect(decision.trace.sourceWeightsNormalized).toEqual({ active: 0, due: 1, near: 0 });
    }
  });

  it("NEAR only -> every draw selects NEAR_DUE, normalized weights are {0,0,1}", () => {
    const sim = new SchedulerSimulation({ cards: [makeNearDueCard("near-1"), makeNearDueCard("near-2")], random: createSeededRandom(35) });
    const snapshot = sim.snapshot();
    const random = createSeededRandom(36);
    for (let i = 0; i < 50; i += 1) {
      const decision = chooseNextCard(snapshot, random);
      expect(decision.source).toBe("NEAR_DUE");
      expect(decision.trace.sourceWeightsNormalized).toEqual({ active: 0, due: 0, near: 1 });
    }
  });

  it("ACTIVE + DUE -> only these two ever selected, normalized weights sum to 1 excluding NEAR", () => {
    const sim = new SchedulerSimulation({ cards: [...activeOnlyCards(), ...makeDueCards(3)], random: createSeededRandom(37) });
    const snapshot = sim.snapshot();
    const random = createSeededRandom(38);
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const decision = chooseNextCard(snapshot, random);
      expect(decision.source).not.toBe("NEAR_DUE");
      seen.add(decision.source!);
      expect(decision.trace.sourceWeightsNormalized.near).toBe(0);
      expect(decision.trace.sourceWeightsNormalized.active + decision.trace.sourceWeightsNormalized.due).toBeCloseTo(1);
    }
    expect(seen).toEqual(new Set(["ACTIVE", "FSRS_DUE"]));
  });

  it("ACTIVE + NEAR -> only these two ever selected", () => {
    const sim = new SchedulerSimulation({ cards: [...activeOnlyCards(), makeNearDueCard("near-1")], random: createSeededRandom(39) });
    const snapshot = sim.snapshot();
    const random = createSeededRandom(40);
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const decision = chooseNextCard(snapshot, random);
      expect(decision.source).not.toBe("FSRS_DUE");
      seen.add(decision.source!);
      expect(decision.trace.sourceWeightsNormalized.due).toBe(0);
    }
    expect(seen).toEqual(new Set(["ACTIVE", "NEAR_DUE"]));
  });

  it("DUE + NEAR -> only these two ever selected", () => {
    const sim = new SchedulerSimulation({ cards: [...makeDueCards(3), makeNearDueCard("near-1")], random: createSeededRandom(41) });
    const snapshot = sim.snapshot();
    const random = createSeededRandom(42);
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const decision = chooseNextCard(snapshot, random);
      expect(decision.source).not.toBe("ACTIVE");
      seen.add(decision.source!);
      expect(decision.trace.sourceWeightsNormalized.active).toBe(0);
    }
    expect(seen).toEqual(new Set(["FSRS_DUE", "NEAR_DUE"]));
  });

  it("ordinary Active empty but a target-reached Repair exists -> ACTIVE still counts as available", () => {
    const sim = new SchedulerSimulation({
      cards: [{ ...makeActiveCard("repair-1", { learningStage: "LEARNING_1" }), repairPending: true, repairObligation: { cardId: "repair-1", wrongPosition: 0, targetPosition: 1, hardCapPosition: 100 } }],
      random: createSeededRandom(43),
      schedulerPosition: 1,
    });
    const decision = sim.step(true);
    expect(decision.source).toBe("ACTIVE");
    expect(decision.selectionReason).toBe("repair_target");
    expect(decision.trace.sourceWeightsNormalized.active).toBeGreaterThan(0);
  });

  it("ordinary Active empty but a due Spaced Confirmation exists -> ACTIVE still counts as available", () => {
    const sim = new SchedulerSimulation({
      cards: [{ ...makeActiveCard("spaced-1"), cardStatus: "FORGOTTEN", learningStage: null, relearningPhase: "SPACED_CONFIRMATION_PENDING", correctCooldownUntilPosition: 0 }],
      random: createSeededRandom(45),
      schedulerPosition: 5,
    });
    const decision = sim.step(true);
    expect(decision.source).toBe("ACTIVE");
    expect(decision.selectionReason).toBe("spaced_confirmation");
    expect(decision.trace.sourceWeightsNormalized.active).toBeGreaterThan(0);
  });
});
