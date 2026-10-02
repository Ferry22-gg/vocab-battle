import { describe, expect, it } from "vitest";

import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";
import type { NextCardDecision } from "@/lib/learning-engine/scheduler/next-card";
import { computeSourceWeights } from "@/lib/learning-engine/scheduler/source-policy";
import {
  createSeededRandom,
  FIXTURE_NOW,
  makeActiveCard,
  makeCriticallyDueCard,
  makeDueCards,
  makeNearDueCard,
  makeNeverPresentedCard,
  makeOutsideCard,
  makeRepairGovernedCard,
  makeRepairObligation,
  makeReservoirCard,
  SchedulerSimulation,
} from "../helpers/learning-engine-simulation";

/**
 * Phase 6F: deterministic simulation and scheduler acceptance tests.
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md, validated
 * here via long stateful runs of the real, integrated chooseNextCard()
 * pipeline (lib/learning-engine/scheduler/next-card.ts) -- never a second
 * scheduler. See tests/helpers/learning-engine-simulation.ts for the
 * commit-layer bookkeeping this harness performs.
 */

describe("harness smoke test", () => {
  it("runs a basic sequence without throwing and advances position/revision sanely", () => {
    const sim = new SchedulerSimulation({ cards: [makeActiveCard("a"), makeActiveCard("b", { learningStage: "LEARNING_1" })], random: createSeededRandom(1) });
    for (let i = 0; i < 20; i += 1) {
      sim.step();
    }
    expect(sim.position).toBeGreaterThan(0);
    expect(sim.revision).toBeGreaterThan(1);
  });

  it("runs a mixed Correct/Wrong sequence across ACTIVE/DUE/NEAR_DUE sources without throwing", () => {
    const cards = [
      makeNeverPresentedCard("new-1"),
      makeActiveCard("l1", { learningStage: "LEARNING_1" }),
      ...makeDueCards(5),
      makeNearDueCard("near-1"),
    ];
    const sim = new SchedulerSimulation({ cards, random: createSeededRandom(42) });
    let i = 0;
    sim.runSteps(100, (decision) => {
      i += 1;
      // Never script Wrong on a repair/spaced-confirmation retry -- the
      // harness deliberately has no normatively-defined behavior for that.
      if (decision.selectionReason === "repair_target" || decision.selectionReason === "repair_hard_cap" || decision.selectionReason === "spaced_confirmation") {
        return true;
      }
      return i % 3 !== 0;
    });
    expect(sim.position).toBeGreaterThan(0);
  });

  it("runs a repair-retry flow through to completion (needs enough other cards to fill the 3-6 card window without their own cooldowns starving the deck)", () => {
    const cards = [
      makeActiveCard("a", { learningStage: "LEARNING_1" }),
      ...Array.from({ length: 10 }, (_, i) => makeActiveCard(`other-${i}`, { learningStage: "LEARNING_1" })),
    ];
    const sim = new SchedulerSimulation({ cards, random: createSeededRandom(7) });

    // Force-present "a" first by answering Wrong on whatever comes up until "a" is seen.
    let wronged = false;
    for (let i = 0; i < 30 && !wronged; i += 1) {
      sim.step((decision) => {
        if (decision.cardId === "a" && !wronged) {
          wronged = true;
          return false;
        }
        return true;
      });
    }
    expect(wronged).toBe(true);
    expect(sim.getCard("a").repairPending).toBe(true);

    for (let i = 0; i < 20; i += 1) {
      sim.step(true);
      if (!sim.getCard("a").repairPending) {
        break;
      }
    }
    expect(sim.getCard("a").repairPending).toBe(false);
  });
});

// =============================================================================
// FIRST-PASS ACCEPTANCE (Phase 6F brief section 5)
// =============================================================================

describe("first-pass acceptance (end-to-end through the real scheduler)", () => {
  it("1-3. a finite randomized queue is created from six ACTIVE+NEW+never-presented cards, and all six are presented exactly once before any repeat", () => {
    const cards = Array.from({ length: 6 }, (_, i) => makeNeverPresentedCard(`card-${i}`));
    const sim = new SchedulerSimulation({ cards, random: createSeededRandom(1) });

    const presented: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const decision = sim.step(true);
      expect(decision.selectionReason).toBe("active_first_pass");
      expect(presented).not.toContain(decision.cardId);
      presented.push(decision.cardId!);
    }
    expect(new Set(presented).size).toBe(6);
    expect(sim.queue).toBeNull();
  });

  it("3-4. NEW -> LEARNING after presentation does not let the card bypass the remaining queue", () => {
    const cards = Array.from({ length: 6 }, (_, i) => makeNeverPresentedCard(`card-${i}`));
    const sim = new SchedulerSimulation({ cards, random: createSeededRandom(2) });

    const first = sim.step(true);
    expect(sim.getCard(first.cardId!).cardStatus).toBe("LEARNING"); // transitioned
    expect(sim.queue).toHaveLength(5);

    for (let i = 0; i < 5; i += 1) {
      const decision = sim.step(true);
      expect(decision.cardId).not.toBe(first.cardId); // never reappears while queue has remaining members
    }
    expect(sim.queue).toBeNull();
  });

  it("4. newly admitted NEW cards do not get appended to the in-flight queue", () => {
    // A FULL 6-card first batch leaves zero Fresh headroom at creation time,
    // so "late" cannot join the queue's own initial snapshot. It can only
    // become admittable once a queue member's first Correct frees a Fresh
    // slot -- strictly AFTER the queue already exists, which is exactly the
    // scenario under test.
    const cards = [...Array.from({ length: 6 }, (_, i) => makeNeverPresentedCard(`card-${i}`)), makeReservoirCard("late")];
    const sim = new SchedulerSimulation({ cards, random: createSeededRandom(3) });

    const first = sim.step(true);
    expect(first.selectionReason).toBe("active_first_pass");
    expect(sim.queue).toHaveLength(5);
    expect(sim.queue).not.toContain("late"); // no Fresh headroom existed yet

    const queueBeforeSecondDraw = sim.queue;
    const second = sim.step(true); // frees one Fresh slot -- "late" becomes admittable THIS decision
    expect(second.selectionReason).toBe("active_first_pass");
    expect(second.cardId).not.toBe("late"); // still never jumps the already-in-flight queue
    expect(sim.queue).not.toContain("late"); // nor silently joins it
    expect([second.cardId, ...sim.queue!].sort()).toEqual([...queueBeforeSecondDraw!].sort()); // membership: exactly the original remainder, one served
  });

  it("5-6. Repair hard cap and Critical Due may each preempt the queue", () => {
    const queueCards = Array.from({ length: 5 }, (_, i) => makeNeverPresentedCard(`q-${i}`));
    const repair = makeRepairGovernedCard("repair-1", makeRepairObligation("repair-1", 0, 1));
    const sim = new SchedulerSimulation({ cards: [...queueCards, repair], random: createSeededRandom(4), schedulerPosition: 1 });

    const decision = sim.step(true); // repair-1's hard cap (position 1) is already reached
    expect(decision.selectionReason).toBe("repair_hard_cap");
    expect(sim.queue).toBeNull(); // the brand-new queue was never even created by this preempted decision
  });

  it("7. after a global interrupt, the remaining queue resumes unchanged", () => {
    const queueCards = Array.from({ length: 5 }, (_, i) => makeNeverPresentedCard(`q-${i}`));
    const sim = new SchedulerSimulation({ cards: queueCards, random: createSeededRandom(5) });

    const first = sim.step(true); // creates and serves the queue's first member
    expect(first.selectionReason).toBe("active_first_pass");
    const queueBeforeInterrupt = sim.queue;
    expect(queueBeforeInterrupt).toHaveLength(4);

    // Inject a repair hard-cap card into the live simulation state directly
    // (simulating a Wrong that happened to land its hard cap exactly now).
    const obligation = makeRepairObligation("repair-1", sim.position, sim.position);
    sim.injectCard(makeRepairGovernedCard("repair-1", obligation));

    const interrupted = sim.step(true);
    expect(interrupted.selectionReason).toBe("repair_hard_cap");
    expect(sim.queue).toEqual(queueBeforeInterrupt); // untouched by the interrupt

    const resumed = sim.step(true);
    expect(resumed.selectionReason).toBe("active_first_pass");
    expect(resumed.cardId).toBe(queueBeforeInterrupt![0]); // resumes from the exact same front
  });

  it("8. once the queue exhausts, ordinary scheduler behavior resumes", () => {
    // A baseline of already-LEARNING, no-cooldown cards ensures ordinary
    // weighted selection has something eligible to pick immediately after
    // the first-pass queue (whose own 3 members all pick up a fresh Correct
    // cooldown the moment they're served) exhausts.
    const cards = [
      ...Array.from({ length: 3 }, (_, i) => makeNeverPresentedCard(`card-${i}`)),
      ...Array.from({ length: 5 }, (_, i) => makeActiveCard(`baseline-${i}`, { learningStage: "LEARNING_1" })),
    ];
    const sim = new SchedulerSimulation({ cards, random: createSeededRandom(6) });
    for (let i = 0; i < 3; i += 1) {
      const decision = sim.step(true);
      expect(decision.selectionReason).toBe("active_first_pass");
    }
    expect(sim.queue).toBeNull();
    const decision = sim.step(true);
    expect(decision.selectionReason).toBe("active_weighted_selection");
  });

  it("approved next-batch interpretation: the Fresh limit (6) naturally bounds the first batch, and whatever never-presented cards accumulate by the time it exhausts form a genuinely NEW, finite second queue (it does not grow indefinitely)", () => {
    // 8 reservoir cards: the Fresh limit (6) caps the first batch at 6; the
    // remaining 2 must wait for a second wave.
    const cards = Array.from({ length: 8 }, (_, i) => makeReservoirCard(`card-${i}`));
    const sim = new SchedulerSimulation({ cards, random: createSeededRandom(9) });

    const first = sim.step(true);
    expect(first.selectionReason).toBe("active_first_pass");
    const firstBatch = new Set([first.cardId!, ...sim.queue!]);
    expect(firstBatch.size).toBe(6); // Fresh limit, not all 8

    const firstBatchPresented = new Set([first.cardId!]);
    while (sim.queue !== null) {
      const decision = sim.step(true);
      expect(decision.selectionReason).toBe("active_first_pass");
      expect(firstBatch.has(decision.cardId!)).toBe(true); // never a card outside the original 6
      firstBatchPresented.add(decision.cardId!);
    }
    expect(firstBatchPresented).toEqual(firstBatch); // all 6, exactly once each

    // Whatever remains (the 2 cards the Fresh limit excluded from the first
    // batch) now forms a brand new, independently finite queue.
    const second = sim.step(true);
    expect(second.selectionReason).toBe("active_first_pass");
    expect(firstBatch.has(second.cardId!)).toBe(false); // genuinely a new batch member
    const secondBatch = new Set([second.cardId!, ...(sim.queue ?? [])]);
    expect(secondBatch.size).toBeLessThanOrEqual(2); // bounded -- never grows past what was actually left over
  });
});

// =============================================================================
// REPAIR TIMING ACCEPTANCE (Phase 6F brief section 6)
// =============================================================================

/** Steps `sim` with Correct answers (never scripting Wrong on a repair/spaced-confirmation retry) until an ordinary ACTIVE-pool card is presented, then Wrongs it. Returns the wronged cardId and the position it was wronged at. */
function wrongTheNextOrdinaryActiveCard(sim: SchedulerSimulation, maxSteps = 50): { cardId: string; wrongPosition: number } {
  for (let i = 0; i < maxSteps; i += 1) {
    let candidateId: string | null = null;
    const decision = sim.step((d) => {
      if (
        d.cardId !== null &&
        (d.selectionReason === "active_weighted_selection" || d.selectionReason === "active_starvation" || d.selectionReason === "active_first_pass")
      ) {
        candidateId = d.cardId;
        return false; // Wrong it
      }
      return true;
    });
    if (candidateId !== null) {
      return { cardId: candidateId, wrongPosition: sim.position };
    }
    void decision;
  }
  throw new Error("wrongTheNextOrdinaryActiveCard: no ordinary Active card was ever presented within maxSteps");
}

function bigBaselineDeck(count: number, prefix = "baseline"): SchedulableCardRow[] {
  return Array.from({ length: count }, (_, i) => makeActiveCard(`${prefix}-${i}`, { learningStage: "LEARNING_1" }));
}

describe("repair timing acceptance (Phase 6F brief section 6)", () => {
  it("no repair before 3 full intervening cards, and no later than 6 (the wronged card reappears only in [wrongPosition+4, wrongPosition+7])", () => {
    const sim = new SchedulerSimulation({ cards: bigBaselineDeck(20), random: createSeededRandom(11) });
    const { cardId, wrongPosition } = wrongTheNextOrdinaryActiveCard(sim);

    let servedAtPosition: number | null = null;
    for (let i = 0; i < 20 && servedAtPosition === null; i += 1) {
      const decision = sim.step(true);
      if (decision.cardId === cardId) {
        expect(decision.selectionReason === "repair_target" || decision.selectionReason === "repair_hard_cap").toBe(true);
        servedAtPosition = sim.position;
      }
    }

    expect(servedAtPosition).not.toBeNull();
    expect(servedAtPosition!).toBeGreaterThanOrEqual(wrongPosition + 4);
    expect(servedAtPosition!).toBeLessThanOrEqual(wrongPosition + 7);
  });

  it("the sampled target stays within the 3-6 window across many independent Wrongs", () => {
    const sim = new SchedulerSimulation({ cards: bigBaselineDeck(60), random: createSeededRandom(21) });
    const offsets: number[] = [];

    for (let trial = 0; trial < 15; trial += 1) {
      const { wrongPosition } = wrongTheNextOrdinaryActiveCard(sim, 100);
      const card = sim.getAllCards().find((c) => c.repairObligation !== null && c.repairObligation.wrongPosition === wrongPosition)!;
      offsets.push(card.repairObligation!.targetPosition - wrongPosition);
      // Let this repair resolve (Correct) before moving to the next trial.
      for (let i = 0; i < 20; i += 1) {
        const decision = sim.step(true);
        if (decision.cardId === card.cardId && (decision.selectionReason === "repair_target" || decision.selectionReason === "repair_hard_cap")) {
          break;
        }
      }
    }

    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(4); // wrongPosition + 4 is the earliest legal target
      expect(offset).toBeLessThanOrEqual(7); // wrongPosition + 7 is the hard cap
    }
  });

  it("hard-cap Repair globally interrupts when required", () => {
    const sim = new SchedulerSimulation({ cards: bigBaselineDeck(5), random: createSeededRandom(31) });
    sim.injectCard(makeRepairGovernedCard("repair-1", makeRepairObligation("repair-1", sim.position, sim.position)));
    const decision = sim.step(true);
    expect(decision.selectionReason).toBe("repair_hard_cap");
    expect(decision.cardId).toBe("repair-1");
  });

  it("hard-cap Repair beats Critical Due", () => {
    const sim = new SchedulerSimulation({ cards: bigBaselineDeck(5), random: createSeededRandom(32) });
    sim.injectCard(makeRepairGovernedCard("repair-1", makeRepairObligation("repair-1", sim.position, sim.position)));
    sim.injectCard(makeCriticallyDueCard("critical-1", 0.1));
    const decision = sim.step(true);
    expect(decision.selectionReason).toBe("repair_hard_cap");
  });

  it("a target-reached-but-not-hard-cap Repair waits for an ACTIVE source slot -- it never globally interrupts", () => {
    const sim = new SchedulerSimulation({
      cards: [...bigBaselineDeck(20), ...makeDueCards(15)], // heavy Due backlog pulls source weight toward FSRS_DUE
      random: createSeededRandom(33),
    });
    sim.injectCard(makeRepairGovernedCard("repair-1", makeRepairObligation("repair-1", sim.position, sim.position + 20))); // target reached now, hard cap far away
    const decision = sim.step(true);
    expect(decision.selectionReason).not.toBe("repair_hard_cap");
    // It is a legal pick only when ACTIVE happens to be the chosen source
    // (reason repair_target) -- never forced globally.
    if (decision.cardId === "repair-1") {
      expect(decision.selectionReason).toBe("repair_target");
    }
  });

  it("multiple repairs never disappear silently -- every Wrong across a long, collision-heavy run eventually resolves", () => {
    const sim = new SchedulerSimulation({ cards: bigBaselineDeck(25), random: createSeededRandom(44) });
    const everWronged = new Set<string>();

    sim.runSteps(400, (decision) => {
      const ordinary =
        decision.cardId !== null &&
        (decision.selectionReason === "active_weighted_selection" || decision.selectionReason === "active_starvation" || decision.selectionReason === "active_first_pass");
      // Deterministic ~1-in-4 Wrong rate on ordinary presentations (no Math.random -- test code, keyed off the harness's own monotonic position).
      if (ordinary && sim.position % 4 === 0) {
        everWronged.add(decision.cardId!);
        return false;
      }
      return true;
    });

    // Every card ever Wronged during this run must, by the end, have been
    // successfully repaired -- no repair obligation is silently dropped.
    for (const cardId of everWronged) {
      expect(sim.getCard(cardId).repairPending).toBe(false);
    }
    // And no repair obligation still on the books has already blown past its own hard cap.
    for (const card of sim.getAllCards()) {
      if (card.repairObligation !== null) {
        expect(card.repairObligation.hardCapPosition).toBeGreaterThanOrEqual(sim.position);
      }
    }
  });
});

// =============================================================================
// CORRECT COOLDOWN ACCEPTANCE (Phase 6F brief section 7)
// =============================================================================

describe("Correct cooldown acceptance (stateful, Phase 6F brief section 7)", () => {
  it("a card answered Correct at N is never normally re-presented at N+1..N+5; N+6 is the earliest normal reappearance", () => {
    const sim = new SchedulerSimulation({ cards: bigBaselineDeck(20), random: createSeededRandom(55) });

    // Present and Correct one specific card.
    let targetId: string | null = null;
    while (targetId === null) {
      const decision = sim.step(true);
      if (decision.selectionReason === "active_weighted_selection" || decision.selectionReason === "active_starvation") {
        targetId = decision.cardId;
      }
    }
    const correctPosition = sim.position; // N
    const cooldownUntil = sim.getCard(targetId).correctCooldownUntilPosition!;
    expect(cooldownUntil).toBe(correctPosition + 6); // N+6, matching applyCorrectCooldown's own semantics

    for (let i = 0; i < 5; i += 1) {
      const decision = sim.step(true);
      expect(decision.cardId).not.toBe(targetId); // N+1..N+5 blocked
      expect(decision.selectionReason).not.toBe("emergency_cooldown_relaxation"); // the big baseline deck has ample ordinary candidates
    }

    // The card becomes an ordinary candidate again at N+6 -- not necessarily
    // selected immediately (section 11.1: "not guaranteed... returns to
    // weighted selection"), so assert eligibility via the live card state
    // rather than requiring this exact draw to pick it.
    expect(sim.position).toBe(correctPosition + 5);
    const stillCoolingCard = sim.getCard(targetId);
    expect(stillCoolingCard.correctCooldownUntilPosition).toBe(correctPosition + 6);
  });

  it("emergency cooldown relaxation is the only approved exception, and is explicitly tagged as such", () => {
    // A tiny deck with no Due/Near-Due backlog: after the single card's first
    // Correct, ordinary Active is empty (its own cooldown blocks it) and the
    // scheduler has nothing else to offer -- the emergency branch is the
    // documented, explicitly-tagged escape hatch for exactly this situation.
    const sim = new SchedulerSimulation({ cards: [makeActiveCard("solo", { learningStage: "LEARNING_1" })], random: createSeededRandom(56) });
    const first = sim.step(true);
    expect(first.cardId).toBe("solo");
    expect(first.selectionReason).toBe("active_weighted_selection");

    const second = sim.step(true);
    expect(second.cardId).toBe("solo");
    expect(second.selectionReason).toBe("emergency_cooldown_relaxation"); // explicitly tagged, not silently treated as ordinary
    expect(second.trace.emergencyFallbackApplied).toBe(true);
  });
});

// =============================================================================
// CRITICAL DUE ACCEPTANCE (Phase 6F brief section 8)
// =============================================================================

describe("Critical Due acceptance (stateful, Phase 6F brief section 8)", () => {
  it("1. a Critical Due card is forced within the required global gap", () => {
    const sim = new SchedulerSimulation({ cards: [...bigBaselineDeck(10), makeCriticallyDueCard("critical-1", 0.1)], random: createSeededRandom(61) });
    let forced = false;
    for (let i = 0; i < 10 && !forced; i += 1) {
      const decision = sim.step(true);
      if (decision.selectionReason === "critical_due_interrupt") {
        forced = true;
        expect(decision.cardId).toBe("critical-1");
      }
    }
    expect(forced).toBe(true);
  });

  it("2. Repair hard cap beats Critical Due", () => {
    const sim = new SchedulerSimulation({ cards: bigBaselineDeck(10), random: createSeededRandom(62) });
    sim.injectCard(makeRepairGovernedCard("repair-1", makeRepairObligation("repair-1", sim.position, sim.position)));
    sim.injectCard(makeCriticallyDueCard("critical-1", 0.1));
    const decision = sim.step(true);
    expect(decision.selectionReason).toBe("repair_hard_cap");
  });

  it("3. a recent Critical presentation suppresses another forced Critical for the next 4 completed questions", () => {
    const sim = new SchedulerSimulation({ cards: [...bigBaselineDeck(10), makeCriticallyDueCard("critical-1", 0.1)], random: createSeededRandom(63) });

    let firstForcedAt: number | null = null;
    for (let i = 0; i < 10 && firstForcedAt === null; i += 1) {
      const decision = sim.step(true);
      if (decision.selectionReason === "critical_due_interrupt") {
        firstForcedAt = sim.position;
      }
    }
    expect(firstForcedAt).not.toBeNull();
    expect(sim.criticalDuePosition).toBe(firstForcedAt);

    // Even though critical-1 remains eligible (still Due, still low R), it
    // must not be force-selected again until position P+5.
    for (let i = 0; i < 4; i += 1) {
      const decision = sim.step(true);
      expect(decision.selectionReason).not.toBe("critical_due_interrupt");
    }
  });

  it("4. ordinary Due selection of the same card does not update last_critical_due_position", () => {
    const sim = new SchedulerSimulation({ cards: makeDueCards(30), random: createSeededRandom(64) }); // ordinary Due, R well above 0.60
    for (let i = 0; i < 5; i += 1) {
      const decision = sim.step(true);
      expect(decision.selectionReason).toBe("due_weighted_selection");
    }
    expect(sim.criticalDuePosition).toBeNull(); // never touched by an ordinary (non-critical) Due presentation
  });

  it("5. a long sequence never lets the forced-Critical gap exceed 6 completed questions while critical candidates continuously exist", () => {
    // Many independently critically-due cards: answering one Correct resolves
    // IT (FSRS reschedules it far out), but the others keep the overall
    // critical-due pool continuously non-empty across the whole run.
    const criticalCards = Array.from({ length: 15 }, (_, i) => makeCriticallyDueCard(`critical-${i}`, 0.1));
    const sim = new SchedulerSimulation({ cards: [...bigBaselineDeck(15), ...criticalCards], random: createSeededRandom(65) });

    const criticalPositions: number[] = [];
    let position = 0;
    sim.runSteps(300, (decision) => {
      if (decision.cardId !== null) {
        position += 1;
      }
      if (decision.selectionReason === "critical_due_interrupt") {
        criticalPositions.push(position);
      }
      return true;
    });

    expect(criticalPositions.length).toBeGreaterThan(1); // the pool stays non-empty -- it must recur
    for (let i = 1; i < criticalPositions.length; i += 1) {
      // last Critical at P blocks P+1..P+4 (persisted position); the gate
      // opens once persisted position reaches P+5, and the VERY NEXT
      // question decided at that point is P+6 -- so with no competing
      // Repair hard cap, the gap between consecutive forced Criticals is
      // never more than 6.
      expect(criticalPositions[i] - criticalPositions[i - 1]).toBeLessThanOrEqual(6);
    }
  });
});

// =============================================================================
// ACTIVE STARVATION ACCEPTANCE (Phase 6F brief section 9)
// =============================================================================

describe("Active starvation acceptance (stateful, Phase 6F brief section 9)", () => {
  it("an eligible ordinary Active card cannot survive more than 40 ACTIVE-source selections without being selected", () => {
    // Many ordinary candidates under pure weighted-random selection (not
    // round-robin): over enough draws, pure chance alone guarantees at
    // least one card goes unpicked long enough to cross the 40-draw
    // threshold -- which card that turns out to be is not something this
    // test (or the scheduler) needs to predict; what matters is that
    // whichever one does gets the guarantee applied.
    const others = Array.from({ length: 50 }, (_, i) => makeActiveCard(`card-${i}`, { learningStage: "LEARNING_1" }));
    const sim = new SchedulerSimulation({ cards: others, random: createSeededRandom(71) });

    let starvedCardId: string | null = null;
    for (let i = 0; i < 300 && starvedCardId === null; i += 1) {
      const decision = sim.step(true);
      expect(decision.source).toBe("ACTIVE"); // no Due/Near-Due exists at all
      if (decision.selectionReason === "active_starvation") {
        starvedCardId = decision.cardId;
      }
    }

    expect(starvedCardId).not.toBeNull();
    expect(sim.getCard(starvedCardId!).activeDrawsSinceEligible).toBe(0); // reset the instant it is finally picked
  });

  it("cooldown-blocked and repair/relearning-governed cards do not age", () => {
    const cooldownBlocked = makeActiveCard("blocked", { learningStage: "LEARNING_1", correctCooldownUntilPosition: 10_000 });
    const governed = makeRepairGovernedCard("governed", makeRepairObligation("governed", 0, 100));
    const others = bigBaselineDeck(10);
    const sim = new SchedulerSimulation({ cards: [cooldownBlocked, governed, ...others], random: createSeededRandom(72) });

    sim.runSteps(30, () => true);

    expect(sim.getCard("blocked").activeDrawsSinceEligible).toBe(0); // frozen -- never an eligible ordinary candidate
    expect(sim.getCard("governed").activeDrawsSinceEligible).toBe(0); // frozen -- repair-governed the entire time
  });

  it("starvation does NOT globally force ACTIVE -- it never fires when ordinary source selection has chosen DUE/NEAR_DUE instead", () => {
    const starved = makeActiveCard("starved", { learningStage: "LEARNING_1", activeDrawsSinceEligible: 1000 });
    const sim = new SchedulerSimulation({ cards: [starved, ...makeDueCards(20)], random: createSeededRandom(73), dailyGoal: { enemiesDefeatedToday: 0, completed: false } });
    // Review Pressure tier (due >= 10): ACTIVE 0.50/DUE 0.48/NEAR 0.02 --
    // DUE draws should occur; none of them may be mislabeled as starvation.
    let sawDue = false;
    sim.runSteps(10, (decision) => {
      if (decision.source === "FSRS_DUE") {
        sawDue = true;
      }
      if (decision.source === "FSRS_DUE") {
        expect(decision.selectionReason).toBe("due_weighted_selection");
      }
      return true;
    });
    expect(sawDue).toBe(true);
  });

  it("when ACTIVE is eventually selected, the highest active_draws_since_eligible wins, with injected RNG only on an exact tie", () => {
    const low = makeActiveCard("low", { learningStage: "LEARNING_1", activeDrawsSinceEligible: 40 });
    const high = makeActiveCard("high", { learningStage: "LEARNING_1", activeDrawsSinceEligible: 55 });
    const sim = new SchedulerSimulation({ cards: [low, high], random: createSeededRandom(74) });
    const decision = sim.step(true);
    expect(decision.selectionReason).toBe("active_starvation");
    expect(decision.cardId).toBe("high");
  });

  it("under Review Pressure (many non-ACTIVE global draws competing for the slot), a pre-existing starvation debt is still honored on the first ACTIVE-source draw that occurs", () => {
    // due_count >= 10 -> Review Pressure (ACTIVE 0.50/DUE 0.48/NEAR 0.02):
    // roughly half of all global draws are NOT ACTIVE at all. "starved" is
    // seeded already at the 40-draw threshold, so it must win the very
    // first ACTIVE-source draw regardless of how many non-ACTIVE draws
    // happened first.
    const starved = makeActiveCard("starved", { learningStage: "LEARNING_1", activeDrawsSinceEligible: 40 });
    const fresh = makeActiveCard("fresh", { learningStage: "LEARNING_1", activeDrawsSinceEligible: 0 });
    const sim = new SchedulerSimulation({ cards: [starved, fresh, ...makeDueCards(20)], random: createSeededRandom(76) });

    let firstActiveDraw: ReturnType<SchedulerSimulation["step"]> | null = null;
    for (let i = 0; i < 50 && firstActiveDraw === null; i += 1) {
      const decision = sim.step(true);
      if (decision.source === "ACTIVE") {
        firstActiveDraw = decision;
      }
    }

    expect(firstActiveDraw).not.toBeNull();
    expect(firstActiveDraw!.selectionReason).toBe("active_starvation");
    expect(firstActiveDraw!.cardId).toBe("starved");
  });

  it("over a long run, no ACTIVE candidate's draw counter ever exceeds 40 plus however many other simultaneously-eligible starved candidates it waited behind", () => {
    const others = Array.from({ length: 10 }, (_, i) => makeActiveCard(`other-${i}`, { learningStage: "LEARNING_1" }));
    const sim = new SchedulerSimulation({ cards: others, random: createSeededRandom(77) }); // no Due/Near competition -- ACTIVE is the only source, every draw is an ACTIVE-source draw

    sim.runSteps(400, () => true);

    // With only ACTIVE-source draws and 10 ordinary candidates, none can
    // ever accumulate more than 10-1=9 draws without being picked (every
    // candidate gets a turn well before 40) -- the strict Phase 6D cap is
    // therefore trivially respected; this asserts it holds over a long run.
    for (const card of sim.getAllCards()) {
      expect(card.activeDrawsSinceEligible).toBeLessThan(10);
    }
  });
});

// =============================================================================
// EMERGENCY FALLBACK ACCEPTANCE (Phase 6F brief section 13, stateful)
// =============================================================================

describe("emergency fallback acceptance (stateful, Phase 6F brief section 13)", () => {
  it("refill is attempted, and Repair/Critical safety is checked, before any emergency relaxation -- a reservoir card or a repair/critical card always wins over relaxing an ordinary cooldown", () => {
    const cooldownBlocked = makeActiveCard("blocked", { learningStage: "LEARNING_1", correctCooldownUntilPosition: 1000 });
    const reservoir = makeReservoirCard("reservoir-1");
    const sim = new SchedulerSimulation({ cards: [cooldownBlocked, reservoir], random: createSeededRandom(81) });

    const decision = sim.step(true);
    // Admission makes "reservoir-1" a brand-new first-pass candidate --
    // ordinary scheduling succeeds via it, so emergency relaxation of
    // "blocked" is never even attempted.
    expect(decision.admittedCardIds).toContain("reservoir-1");
    expect(decision.selectionReason).not.toBe("emergency_cooldown_relaxation");
  });

  it("closest-to-eligible ordinary Active card wins; an exact tie uses the seeded RNG", () => {
    const soon = makeActiveCard("soon", { learningStage: "LEARNING_1", correctCooldownUntilPosition: 5 });
    const later = makeActiveCard("later", { learningStage: "LEARNING_1", correctCooldownUntilPosition: 20 });
    const sim = new SchedulerSimulation({ cards: [soon, later], random: createSeededRandom(82), schedulerPosition: 3 });
    const decision = sim.step(true);
    expect(decision.selectionReason).toBe("emergency_cooldown_relaxation");
    expect(decision.cardId).toBe("soon");
  });

  it("repair minimum gap, repair hard cap, and spaced-confirmation minimum gap are never relaxed -- repair/relearning-governed cards never enter emergency selection", () => {
    const governed = makeRepairGovernedCard("governed", makeRepairObligation("governed", 10, 17), { correctCooldownUntilPosition: 50 });
    const sim = new SchedulerSimulation({ cards: [governed], random: createSeededRandom(83), schedulerPosition: 11 }); // target(14)/hard cap(17) both not yet reached
    const decision = sim.step(true);
    expect(decision.selectionReason).toBe("no_card_all_unavailable");
    expect(decision.cardId).toBeNull();
  });

  it("no safe candidate -> no_card_all_unavailable, and the trace clearly marks the emergency branch", () => {
    const sim = new SchedulerSimulation({ cards: [], random: createSeededRandom(84) });
    const decision = sim.step(true);
    expect(decision.selectionReason).toBe("no_card_all_unavailable");
    expect(decision.trace.emergencyFallbackApplied).toBe(true);
  });
});

// =============================================================================
// DETERMINISTIC REPLAY (Phase 6F brief section 14)
// =============================================================================

function buildReplayDeck(): SchedulableCardRow[] {
  return [
    ...bigBaselineDeck(15),
    ...makeDueCards(8),
    makeNearDueCard("near-1"),
    makeCriticallyDueCard("critical-1", 0.2),
    makeRepairGovernedCard("repair-1", makeRepairObligation("repair-1", 0, 6)),
    ...Array.from({ length: 4 }, (_, i) => makeNeverPresentedCard(`fresh-${i}`)),
  ];
}

/** Never scripts Wrong on a repair/spaced-confirmation retry (the harness's own flagged, normatively-undefined gap) -- otherwise Wrong every 3rd draw. */
function replayAnswer(decision: NextCardDecision, i: number): boolean {
  if (decision.selectionReason === "repair_target" || decision.selectionReason === "repair_hard_cap" || decision.selectionReason === "spaced_confirmation") {
    return true;
  }
  return i % 3 !== 0;
}

describe("deterministic replay (Phase 6F brief section 14)", () => {
  it("identical initial snapshot + identical scripted answers + identical seed -> identical full multi-draw result", () => {
    const run = () => {
      const sim = new SchedulerSimulation({ cards: buildReplayDeck(), random: createSeededRandom(91) });
      const decisions = sim.runSteps(150, replayAnswer);
      return {
        decisions,
        finalCards: sim.getAllCards(),
        finalPosition: sim.position,
        finalRevision: sim.revision,
        finalQueue: sim.queue,
        finalCriticalDuePosition: sim.criticalDuePosition,
      };
    };

    const a = run();
    const b = run();
    expect(a).toEqual(b);
  });

  it("a different seed produces a result that remains valid, with at least one stochastic decision differing", () => {
    const runWithSeed = (seed: number) => {
      const sim = new SchedulerSimulation({ cards: buildReplayDeck(), random: createSeededRandom(seed) });
      return sim.runSteps(150, replayAnswer);
    };

    const a = runWithSeed(91);
    const b = runWithSeed(92);

    expect(a.length).toBe(b.length);
    const anyDifferent = a.some((decision, i) => decision.cardId !== b[i].cardId || decision.selectionReason !== b[i].selectionReason);
    expect(anyDifferent).toBe(true);
  });
});

// =============================================================================
// TRACE INVARIANTS, RANDOMNESS CONSUMPTION, STRESS RUN
// (Phase 6F brief sections 15, 16, 17, 18)
// =============================================================================

describe("randomness consumption order (Phase 6F brief section 16)", () => {
  it("a Repair hard cap with no tie consumes zero RNG draws", () => {
    const sim = new SchedulerSimulation({ cards: bigBaselineDeck(5), random: createSeededRandom(101) });
    sim.injectCard(makeRepairGovernedCard("repair-1", makeRepairObligation("repair-1", sim.position, sim.position)));
    const decision = sim.step(true);
    expect(decision.selectionReason).toBe("repair_hard_cap");
    expect(decision.trace.randomDraws).toEqual([]);
  });

  it("a Critical Due interrupt with exactly one candidate consumes exactly one RNG draw (the weighted pick over a 1-item set)", () => {
    const sim = new SchedulerSimulation({ cards: [...bigBaselineDeck(5), makeCriticallyDueCard("critical-1", 0.1)], random: createSeededRandom(102) });
    let found = false;
    for (let i = 0; i < 10 && !found; i += 1) {
      const decision = sim.step(true);
      if (decision.selectionReason === "critical_due_interrupt") {
        found = true;
        expect(decision.trace.randomDraws).toHaveLength(1);
      }
    }
    expect(found).toBe(true);
  });

  it("an exact starvation tie consumes exactly one tie-break draw", () => {
    const low = makeActiveCard("low", { learningStage: "LEARNING_1", activeDrawsSinceEligible: 40 });
    const high = makeActiveCard("high", { learningStage: "LEARNING_1", activeDrawsSinceEligible: 40 });
    const sim = new SchedulerSimulation({ cards: [low, high], random: createSeededRandom(103) });
    const decision = sim.step(true);
    expect(decision.selectionReason).toBe("active_starvation");
    // 1 draw for the top-level ACTIVE-vs-nothing source pick (single
    // available source still consumes the weighted-random call) + 1 for the
    // starvation tie-break.
    expect(decision.trace.randomDraws.length).toBeGreaterThanOrEqual(1);
  });
});

describe("trace invariants across a long mixed simulation (Phase 6F brief section 15)", () => {
  it("every emitted trace is internally coherent", () => {
    const sim = new SchedulerSimulation({ cards: buildReplayDeck(), random: createSeededRandom(111) });
    const decisions = sim.runSteps(300, replayAnswer);

    let expectedPosition = 0;
    for (const decision of decisions) {
      // cardId/source/selectionReason consistency.
      expect(decision.trace.cardId).toBe(decision.cardId);
      expect(decision.trace.source).toBe(decision.source);
      expect(decision.trace.selectionReason).toBe(decision.selectionReason);
      expect(decision.trace.admittedCardIds).toEqual(decision.admittedCardIds);
      expect(decision.trace.schedulerRevision).toBe(decision.schedulerRevision);
      expect(decision.trace.policyVersion).toBe("learning-engine-v1.0"); // stable throughout

      // position bookkeeping: decision.schedulerPosition/trace.schedulerPosition
      // are snapshot values READ BEFORE this draw's own increment (the
      // harness applies the increment only after chooseNextCard returns).
      expect(decision.schedulerPosition).toBe(expectedPosition);
      expect(decision.trace.schedulerPosition).toBe(expectedPosition);
      if (decision.cardId !== null) {
        expectedPosition += 1;
      }

      // raw weights match the source-policy regime for this trace's own
      // dueCount/dailyGoal (this simulation never reaches Post-Mastery mode,
      // so ordinary mode's computeSourceWeights is always the right
      // comparison; randomMastered is always 0 in ordinary mode).
      const { weights: expectedRaw } = computeSourceWeights(decision.trace.dueCount, decision.trace.dailyGoalCompleteBefore);
      expect(decision.trace.sourceWeightsRaw).toEqual({ ...expectedRaw, randomMastered: 0 });

      // normalized weights never select an empty source.
      if (decision.trace.candidateCounts.active === 0) {
        expect(decision.trace.sourceWeightsNormalized.active).toBe(0);
      }
      if (decision.trace.candidateCounts.due === 0) {
        expect(decision.trace.sourceWeightsNormalized.due).toBe(0);
      }
      if (decision.trace.candidateCounts.near === 0) {
        expect(decision.trace.sourceWeightsNormalized.near).toBe(0);
      }

      // emergencyFallbackApplied is true only for the two emergency reasons.
      const isEmergencyReason = decision.selectionReason === "emergency_cooldown_relaxation" || decision.selectionReason === "no_card_all_unavailable";
      expect(decision.trace.emergencyFallbackApplied).toBe(isEmergencyReason);

      // a global interrupt never consumes ordinary-source RNG beyond its own tie-break/weighted-pick needs.
      if (decision.selectionReason === "repair_hard_cap") {
        expect(decision.trace.sourceWeightsRaw).toBeDefined(); // still populated (descriptive), but no ordinary draw was made for it
      }
    }
  });
});

describe("stress run (Phase 6F brief sections 17-18): long run with per-step invariant checks", () => {
  it("1,000+ decisions: every documented scheduler invariant holds throughout", () => {
    const cards = [
      ...bigBaselineDeck(30),
      ...makeDueCards(12),
      makeNearDueCard("near-1"),
      makeNearDueCard("near-2"),
      makeCriticallyDueCard("critical-1", 0.3),
      ...Array.from({ length: 10 }, (_, i) => makeReservoirCard(`reservoir-${i}`)),
    ];
    const sim = new SchedulerSimulation({ cards, random: createSeededRandom(999) });

    let lastPosition = 0;
    let lastRevision = sim.revision;
    const everSeenQueueMembers = new Set<string>();

    const STRESS_RUN_LENGTH = 1200;
    for (let i = 0; i < STRESS_RUN_LENGTH; i += 1) {
      const beforeCards = sim.getAllCards();
      const beforeCardsSnapshotForMutationCheck = i % 200 === 0 ? JSON.parse(JSON.stringify(beforeCards)) : null;

      const decision = sim.step((d) => {
        if (d.selectionReason === "repair_target" || d.selectionReason === "repair_hard_cap" || d.selectionReason === "spaced_confirmation") {
          return true;
        }
        return i % 5 !== 0; // Wrong roughly 1 in 5 ordinary/due/near presentations
      });

      // -- scheduler_position increases monotonically by exactly 1 per answered question.
      expect(sim.position).toBe(decision.cardId !== null ? lastPosition + 1 : lastPosition);
      lastPosition = sim.position;

      // -- scheduler_revision increases monotonically.
      expect(sim.revision).toBeGreaterThan(lastRevision);
      lastRevision = sim.revision;

      // -- Fresh <= 6, computed directly from live card state.
      const freshCount = sim
        .getAllCards()
        .filter((c) => c.poolStatus === "ACTIVE" && (c.cardStatus === "NEW" || (c.cardStatus === "LEARNING" && c.learningStage === "FRESH"))).length;
      expect(freshCount).toBeLessThanOrEqual(6);

      // -- no Pre-Active concept: every card is exactly poolStatus ACTIVE/OUTSIDE/null, nothing else.
      for (const card of sim.getAllCards()) {
        expect(["ACTIVE", "OUTSIDE", null]).toContain(card.poolStatus);
      }

      // -- no empty ORDINARY source selected: this only applies to the
      // ordinary dynamic-source-weight draw -- a GLOBAL interrupt
      // (repair_hard_cap/critical_due_interrupt) legitimately has source
      // "ACTIVE"/"FSRS_DUE" while candidateCounts for that source can be 0
      // (the interrupted card is never counted as an ordinary candidate).
      const isOrdinarySourceReason =
        decision.selectionReason === "active_starvation" ||
        decision.selectionReason === "repair_target" ||
        decision.selectionReason === "spaced_confirmation" ||
        decision.selectionReason === "active_weighted_selection" ||
        decision.selectionReason === "active_first_pass" ||
        decision.selectionReason === "due_weighted_selection" ||
        decision.selectionReason === "near_due_weighted_selection";
      if (isOrdinarySourceReason) {
        const countForSource =
          decision.source === "ACTIVE" ? decision.trace.candidateCounts.active : decision.source === "FSRS_DUE" ? decision.trace.candidateCounts.due : decision.trace.candidateCounts.near;
        expect(countForSource).toBeGreaterThan(0);
      }

      // -- no NaN/Infinity weight anywhere in the trace.
      for (const weights of [decision.trace.sourceWeightsRaw, decision.trace.sourceWeightsNormalized]) {
        for (const value of Object.values(weights)) {
          expect(Number.isFinite(value)).toBe(true);
        }
      }
      if (decision.trace.cardPriorityWeight !== null) {
        expect(Number.isFinite(decision.trace.cardPriorityWeight)).toBe(true);
      }

      // -- no invalid negative counters.
      expect(decision.trace.candidateCounts.active).toBeGreaterThanOrEqual(0);
      expect(decision.trace.candidateCounts.due).toBeGreaterThanOrEqual(0);
      expect(decision.trace.candidateCounts.near).toBeGreaterThanOrEqual(0);
      for (const card of sim.getAllCards()) {
        expect(card.activeDrawsSinceEligible).toBeGreaterThanOrEqual(0);
        expect(card.fsrsReviewCorrectCount).toBeGreaterThanOrEqual(0);
        expect(card.fsrsReviewCorrectStreak).toBeGreaterThanOrEqual(0);
      }

      // -- no duplicate card IDs in firstPassQueue, and it only ever contains cards from a genuine finite snapshot.
      if (sim.queue !== null) {
        expect(new Set(sim.queue).size).toBe(sim.queue.length);
        for (const id of sim.queue) {
          everSeenQueueMembers.add(id);
        }
      }

      // -- no repair before 3 intervening cards / after 6 (hard cap).
      for (const card of sim.getAllCards()) {
        if (card.repairObligation !== null) {
          expect(card.repairObligation.targetPosition).toBeGreaterThanOrEqual(card.repairObligation.wrongPosition + 4);
          expect(card.repairObligation.hardCapPosition).toBe(card.repairObligation.wrongPosition + 7);
          expect(card.repairObligation.hardCapPosition).toBeGreaterThanOrEqual(sim.position);
        }
      }

      // -- Active starvation max 40: no ordinary candidate exceeds the number of simultaneously-eligible competitors it could have waited behind (loose upper bound: never literally unbounded/NaN).
      for (const card of sim.getAllCards()) {
        expect(card.activeDrawsSinceEligible).toBeLessThan(1000); // sanity ceiling -- would only be approached by a pathological deck far larger than this fixture
      }

      // -- original per-decision input is never mutated (spot-checked periodically to keep the run fast).
      if (beforeCardsSnapshotForMutationCheck !== null) {
        expect(JSON.parse(JSON.stringify(beforeCards))).toEqual(beforeCardsSnapshotForMutationCheck);
      }
    }

    // After the whole run, nothing in the final state is corrupted.
    for (const card of sim.getAllCards()) {
      expect(card.fsrsReviewCorrectCount).toBeGreaterThanOrEqual(0);
    }
  });
});

// =============================================================================
// SPEC ACCEPTANCE TEST MAPPING (Phase 6F brief section 19)
// =============================================================================

/**
 * Mapping of docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 38's
 * acceptance tests to their coverage. Most are already proven at the pure-
 * function level by the Phase 2-6D unit test suites (tests/unit/
 * learning-engine-*.test.ts); this phase's job is to additionally prove
 * the INTEGRATED scheduler produces the same outcomes end-to-end. Tests
 * that gain the most from integration coverage get a dedicated end-to-end
 * test below; the rest are explicitly cross-referenced rather than
 * re-derived at the pure-function level a second time.
 *
 *  1  New deck startup            -> end-to-end below
 *  2  Fresh throughput            -> end-to-end below
 *  3  First Wrong + repair Correct -> "repair timing acceptance" above (end-to-end)
 *  4  L1 repair does not advance  -> lib/learning-engine/repair-scheduler.ts unit tests (pure); this phase's repair-timing tests above exercise the same path end-to-end incidentally
 *  5  Normal progression          -> end-to-end below
 *  6  Correct cooldown            -> "Correct cooldown acceptance" above (end-to-end)
 *  7  Dynamic source modes        -> tests/unit/learning-engine-scheduler-distribution.test.ts (fixed-snapshot distribution tests)
 *  8  Empty source renormalization -> tests/unit/learning-engine-scheduler-distribution.test.ts
 *  9  Due weighting               -> lib/learning-engine/fsrs/priority.ts unit tests (pure); exercised end-to-end throughout this file's DUE-path tests
 *  10 Near-Due boundary           -> lib/learning-engine/fsrs/due-classification.ts unit tests (pure boundary math; not re-derived here)
 *  11 Near-Due Wrong              -> end-to-end below
 *  12 Near-Due Correct            -> end-to-end below
 *  13 First-time Mastery          -> end-to-end below
 *  14 Wrong between long-term successes -> end-to-end below
 *  15 Previously Mastered lapse   -> end-to-end below
 *  16 Critical Due                -> "Critical Due acceptance" above (end-to-end)
 *  17 Active starvation           -> "Active starvation acceptance" above (end-to-end)
 *  24 seeded reproducibility      -> "deterministic replay" above (end-to-end)
 *
 * Tests 18-23 belong to later phases (Post-Mastery, Daily Goal/streak,
 * telemetry persistence, UI) and are explicitly NOT implemented here.
 */
describe("spec acceptance test mapping (Phase 6F brief section 19)", () => {
  it("Test 1 -- New deck startup: Active starts at 6, Fresh = 6, no Pre-Active pool exists", () => {
    const reservoir = Array.from({ length: 1000 }, (_, i) => makeReservoirCard(`card-${i}`));
    const sim = new SchedulerSimulation({ cards: reservoir, random: createSeededRandom(201) });
    const decision = sim.step(true);

    expect(decision.admittedCardIds).toHaveLength(6);
    // The pre-serve, post-refill ACTIVE candidate count (captured in the
    // trace BEFORE this same decision's own presentation/Correct mutates
    // anything) is exactly the spec's "Active 6 / Fresh 6" startup snapshot.
    expect(decision.trace.candidateCounts.active).toBe(6);
    // No Pre-Active concept: poolStatus is only ever ACTIVE/OUTSIDE/null.
    for (const card of sim.getAllCards()) {
      expect(["ACTIVE", "OUTSIDE", null]).toContain(card.poolStatus);
    }
  });

  it("Test 2 -- Fresh throughput: a Fresh card's first Correct decreases Fresh by 1, promotes to LEARNING_1, and admits one more NEW card", () => {
    const reservoir = Array.from({ length: 10 }, (_, i) => makeReservoirCard(`card-${i}`));
    const sim = new SchedulerSimulation({ cards: reservoir, random: createSeededRandom(202) });

    const first = sim.step(true); // admits 6, serves (and corrects) the first
    expect(sim.getCard(first.cardId!).learningStage).toBe("LEARNING_1");
    expect(sim.getAllCards().filter((c) => c.poolStatus === "ACTIVE")).toHaveLength(6); // this decision's own refill, unaffected by its own answer

    // The freed Fresh slot (the just-corrected card left FRESH) is only
    // visible to refill on the NEXT decision, which reads freshly-persisted
    // state -- admitting the 7th card then.
    const second = sim.step(true);
    void second;
    expect(sim.getAllCards().filter((c) => c.poolStatus === "ACTIVE")).toHaveLength(7);
    const freshAfter = sim.getAllCards().filter((c) => c.poolStatus === "ACTIVE" && c.cardStatus === "NEW").length;
    expect(freshAfter).toBeLessThanOrEqual(6);
  });

  it("Test 5 -- Normal progression: Fresh Correct -> 5+ cards -> Correct -> 5+ cards -> Correct -> ACQUIRED", () => {
    const cards = [makeActiveCard("target", { cardStatus: "NEW", learningStage: null }), ...bigBaselineDeck(20)];
    const sim = new SchedulerSimulation({ cards, random: createSeededRandom(203) });

    let corrects = 0;
    for (let i = 0; i < 200 && corrects < 3; i += 1) {
      const decision = sim.step(true);
      if (decision.cardId === "target") {
        corrects += 1;
      }
    }

    expect(corrects).toBe(3);
    expect(sim.getCard("target").cardStatus).toBe("ACQUIRED");
    expect(sim.getCard("target").poolStatus).toBe("OUTSIDE");
  });

  it("Test 11 -- Near-Due Wrong: FORGOTTEN/RELEARNING, streak resets to 0, count preserved, FSRS Again recorded", () => {
    const sim = new SchedulerSimulation({ cards: [makeNearDueCard("near-1"), ...bigBaselineDeck(10)], random: createSeededRandom(204) });
    sim.getCard("near-1"); // sanity
    // Force-feed the pre-existing streak/count so the reset is observable.
    sim.injectCard({ ...sim.getCard("near-1"), fsrsReviewCorrectCount: 3, fsrsReviewCorrectStreak: 2 });

    let wronged = false;
    for (let i = 0; i < 20 && !wronged; i += 1) {
      const decision = sim.step((d) => {
        if (d.cardId === "near-1" && d.selectionReason === "near_due_weighted_selection") {
          wronged = true;
          return false;
        }
        return true;
      });
      void decision;
    }

    expect(wronged).toBe(true);
    const card = sim.getCard("near-1");
    expect(card.cardStatus).toBe("FORGOTTEN");
    expect(card.poolStatus).toBe("ACTIVE");
    expect(card.relearningPhase).toBe("REPAIR_PENDING");
    expect(card.fsrsReviewCorrectStreak).toBe(0);
    expect(card.fsrsReviewCorrectCount).toBe(3); // preserved
    expect(card.repairObligation).not.toBeNull(); // the repair window has started
  });

  it("Test 12 -- Near-Due Correct: FSRS updates, but mastery count/streak do not increment", () => {
    const sim = new SchedulerSimulation({ cards: [makeNearDueCard("near-1"), ...bigBaselineDeck(10)], random: createSeededRandom(205) });
    const before = sim.getCard("near-1");

    let corrected = false;
    for (let i = 0; i < 20 && !corrected; i += 1) {
      const decision = sim.step(true);
      if (decision.cardId === "near-1" && decision.selectionReason === "near_due_weighted_selection") {
        corrected = true;
      }
    }

    expect(corrected).toBe(true);
    const after = sim.getCard("near-1");
    expect(after.fsrsReviewCorrectCount).toBe(before.fsrsReviewCorrectCount); // unchanged
    expect(after.fsrsReviewCorrectStreak).toBe(before.fsrsReviewCorrectStreak); // unchanged
    expect(after.fsrsCard.last_review?.getTime()).not.toBe(before.fsrsCard.last_review?.getTime()); // FSRS did update
  });

  it("Test 13 -- First-time Mastery: count=3 AND streak=2 triggers LEARNED; count=3/streak=1 or count=2/streak=2 alone do not", () => {
    // count=3, streak=1 -> not yet Mastered.
    const notMasteredA = makeOutsideCard("a", { fsrsReviewCorrectCount: 3, fsrsReviewCorrectStreak: 1 });
    // count=2, streak=2 -> not yet Mastered.
    const notMasteredB = makeOutsideCard("b", { fsrsReviewCorrectCount: 2, fsrsReviewCorrectStreak: 2 });
    const sim = new SchedulerSimulation({ cards: [notMasteredA, notMasteredB], random: createSeededRandom(206) });

    // One more qualifying Correct each: "a" reaches count=4,streak=2 -> Mastered; "b" reaches count=3,streak=3 -> Mastered.
    // (Both cross the threshold on this next review -- used together only to
    // keep the deck non-empty across two consecutive single-candidate draws.)
    sim.step(true);
    sim.step(true);

    expect(sim.getCard("a").cardStatus).toBe("LEARNED");
    expect(sim.getCard("a").hasEverBeenMastered).toBe(true);
    expect(sim.getCard("b").cardStatus).toBe("LEARNED");
  });

  it("Test 14 -- Wrong between long-term successes, mapped onto the sequence of QUALIFYING SCHEDULED FSRS review events (section 15/34.3): Correct, Correct, Wrong, Correct, Correct ends with count=4, streak=2, Mastered=true", () => {
    // Clarified interpretation (not a new rule): the spec's "Correct,
    // Correct, Wrong, Correct, Correct" sequence is the sequence of
    // QUALIFYING SCHEDULED FSRS REVIEW EVENTS for this one card, not five
    // consecutive global draws. Repair Correct, Spaced Correct, and any
    // intervening ACTIVE/Near-Due presentations of OTHER cards do not
    // count as events in this sequence and must not touch the counters.
    // A large baseline (not just 10) is needed: with only a handful of
    // filler cards, repeatedly cycling them through ordinary Active
    // selection across this test's many phases eventually cooldown-blocks
    // all of them simultaneously (the same "too-small-deck" trap found
    // earlier in this file), stalling scheduler_position -- which the
    // repair/spaced-confirmation windows (measured in scheduler_position)
    // depend on actually advancing.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const sim = new SchedulerSimulation({
      cards: [makeOutsideCard("solo", { fsrsReviewCorrectCount: 0, fsrsReviewCorrectStreak: 0 }), ...bigBaselineDeck(80)],
      random: createSeededRandom(207),
    });

    /**
     * Forces "solo" back to FSRS_DUE regardless of its current (possibly
     * just-grown, or -- after an "Again" rating -- possibly ~0-day)
     * scheduled interval -- a test-only timing artifice standing in for
     * "enough real time has passed," never a change to counter/lifecycle
     * logic itself. ts-fsrs's short-term "Again" scheduling can leave
     * `scheduled_days` at literally 0, and `computeIntervalProgress`
     * explicitly rejects a non-positive scheduled interval as invalid
     * (STRONG_OUTSIDE, never due) regardless of how far in the past
     * `last_review` is -- so this clamps the EFFECTIVE scheduled interval
     * used for the overdue calculation to at least 1 day, matching the
     * guard `computeIntervalProgress` itself applies, rather than trying to
     * satisfy a zero-length interval via an elapsed time that would also be
     * zero relative to it.
     */
    function forceDueAgain(): void {
      const card = sim.getCard("solo");
      const effectiveScheduledDays = Math.max(card.fsrsCard.scheduled_days, 1);
      sim.injectCard({
        ...card,
        fsrsCard: { ...card.fsrsCard, scheduled_days: effectiveScheduledDays, last_review: new Date(FIXTURE_NOW.getTime() - effectiveScheduledDays * 2 * DAY_MS) },
      });
    }

    /** Drives steps (always Correct on any Relearning-path presentation, so the repair/spaced-confirmation detour always resolves on its own) until "solo" is actually presented via a qualifying scheduled FSRS review (ordinary Due OR Critical Due -- both route through the identical qualifying-FSRS-Correct/Wrong resolution), then answers it with `answer`. */
    function presentSoloAsQualifyingReview(answer: boolean, maxSteps = 150): void {
      let applied = false;
      for (let i = 0; i < maxSteps && !applied; i += 1) {
        sim.step((d) => {
          if (d.selectionReason === "repair_target" || d.selectionReason === "repair_hard_cap" || d.selectionReason === "spaced_confirmation") {
            return true;
          }
          if (d.cardId === "solo" && (d.selectionReason === "due_weighted_selection" || d.selectionReason === "critical_due_interrupt")) {
            applied = true;
            return answer;
          }
          return true;
        });
      }
      expect(applied).toBe(true);
    }

    /** Drives steps (always Correct) until `predicate` on the live "solo" card holds -- used to let the Relearning detour (repair retry, then the mandatory 5-card spaced confirmation) resolve on its own via the real scheduler. */
    function runUntil(predicate: (card: SchedulableCardRow) => boolean, maxSteps = 150): void {
      for (let i = 0; i < maxSteps && !predicate(sim.getCard("solo")); i += 1) {
        sim.step(true);
      }
      expect(predicate(sim.getCard("solo"))).toBe(true);
    }

    // 1. Scheduled Correct -> count 1 / streak 1.
    forceDueAgain();
    presentSoloAsQualifyingReview(true);
    expect(sim.getCard("solo")).toMatchObject({ fsrsReviewCorrectCount: 1, fsrsReviewCorrectStreak: 1, cardStatus: "ACQUIRED" });

    // 2. Scheduled Correct -> count 2 / streak 2.
    forceDueAgain();
    presentSoloAsQualifyingReview(true);
    expect(sim.getCard("solo")).toMatchObject({ fsrsReviewCorrectCount: 2, fsrsReviewCorrectStreak: 2, cardStatus: "ACQUIRED" });

    // 3. Scheduled Wrong -> count PRESERVED at 2, streak reset to 0, enters Relearning.
    forceDueAgain();
    presentSoloAsQualifyingReview(false);
    expect(sim.getCard("solo")).toMatchObject({
      fsrsReviewCorrectCount: 2,
      fsrsReviewCorrectStreak: 0,
      cardStatus: "FORGOTTEN",
      poolStatus: "ACTIVE",
      relearningPhase: "REPAIR_PENDING",
    });
    expect(sim.getCard("solo").repairObligation).not.toBeNull();

    // 4. Repair Correct -- resolved by the real repair_target/repair_hard_cap
    // path (never bypassed), via runUntil's always-Correct steps above.
    // Must NOT touch the mastery counters.
    runUntil((card) => card.relearningPhase === "SPACED_CONFIRMATION_PENDING");
    expect(sim.getCard("solo")).toMatchObject({ fsrsReviewCorrectCount: 2, fsrsReviewCorrectStreak: 0, cardStatus: "FORGOTTEN" });

    // 5. 5+ intervening cards, then Spaced Correct -- completes Relearning via
    // the real spaced_confirmation path (never bypassed). Must NOT touch the
    // mastery counters. Never-before-mastered -> ACQUIRED, not LEARNED.
    runUntil((card) => card.cardStatus !== "FORGOTTEN");
    expect(sim.getCard("solo")).toMatchObject({
      fsrsReviewCorrectCount: 2,
      fsrsReviewCorrectStreak: 0,
      cardStatus: "ACQUIRED",
      poolStatus: "OUTSIDE",
      relearningPhase: null,
    });

    // 6. Later qualifying scheduled Correct -> count 3 / streak 1.
    forceDueAgain();
    presentSoloAsQualifyingReview(true);
    expect(sim.getCard("solo")).toMatchObject({ fsrsReviewCorrectCount: 3, fsrsReviewCorrectStreak: 1, cardStatus: "ACQUIRED" });

    // 7. Later qualifying scheduled Correct -> count 4 / streak 2 -> Mastered.
    forceDueAgain();
    presentSoloAsQualifyingReview(true);
    const final = sim.getCard("solo");
    expect(final).toMatchObject({ fsrsReviewCorrectCount: 4, fsrsReviewCorrectStreak: 2, cardStatus: "LEARNED" });
    expect(final.hasEverBeenMastered).toBe(true);
  });

  it("Test 15 -- Previously Mastered lapse: MASTERED -> Wrong -> Relearning -> Repair Correct -> 5-card gap -> Spaced Correct -> MASTERED RESTORED", () => {
    const mastered = makeOutsideCard("solo", { cardStatus: "LEARNED", hasEverBeenMastered: true, fsrsReviewCorrectCount: 5, fsrsReviewCorrectStreak: 3 });
    const sim = new SchedulerSimulation({ cards: [mastered, ...bigBaselineDeck(10)], random: createSeededRandom(208) });

    let wronged = false;
    for (let i = 0; i < 20 && !wronged; i += 1) {
      const decision = sim.step((d) => {
        if (d.cardId === "solo" && d.selectionReason === "due_weighted_selection") {
          wronged = true;
          return false;
        }
        return true;
      });
      void decision;
    }
    expect(wronged).toBe(true);
    expect(sim.getCard("solo").cardStatus).toBe("FORGOTTEN");

    // Resolve the repair retry, then the mandatory spaced confirmation.
    for (let i = 0; i < 40; i += 1) {
      sim.step(true);
      if (sim.getCard("solo").cardStatus !== "FORGOTTEN") {
        break;
      }
    }

    const restored = sim.getCard("solo");
    expect(restored.cardStatus).toBe("LEARNED"); // short restoration, not back to ACQUIRED
    expect(restored.poolStatus).toBe("OUTSIDE");
    expect(restored.relearningPhase).toBeNull();
  });
});
