import { describe, expect, it } from "vitest";

import {
  createSeededRandom,
  FIXTURE_NOW,
  makeActiveCard,
  makeCriticallyDueCard,
  makeDueCards,
  makeMasteredCard,
  makeNearDueCard,
  makeOutsideCard,
  makeRepairGovernedCard,
  makeRepairObligation,
  makeReservoirCard,
  SchedulerSimulation,
} from "../helpers/learning-engine-simulation";

/**
 * Phase 7 (Post-Mastery Mode): end-to-end stateful simulations through the
 * real, integrated chooseNextCard() pipeline -- never a second scheduler.
 * See tests/unit/learning-engine-scheduler-post-mastery.test.ts for the
 * pure-function-level coverage of the individual Phase 7 modules this
 * exercises together.
 */

/** Always Correct -- used for driving a card through acquisition without ever scripting a Wrong on a repair/spaced-confirmation retry (the Phase 6F harness's own flagged, normatively-undefined gap). */
const alwaysCorrect = (): boolean => true;

// =============================================================================
// TESTS -- NEW CARDS AFTER FULL MASTERY (Phase 7 brief sections 21, 29)
// =============================================================================

describe("new cards after Full Mastery -- the exact 500/520 example (scaled down for test speed, same logical structure)", () => {
  it("40-43, 45. unlock survives added cards; ORDINARY mode while new cards need acquisition; switches to POST_MASTERY the instant they reach ACQUIRED, NOT at Mastered", () => {
    const masteredCards = Array.from({ length: 10 }, (_, i) => makeMasteredCard(`mastered-${i}`));
    const newCards = Array.from({ length: 5 }, (_, i) => makeReservoirCard(`new-${i}`));
    // hasAchievedFullMastery: true models the HISTORICAL fact that this
    // deck unlocked at 10/10 (the spec's 500/500) BEFORE the 5 new cards
    // were ever added -- the deck as constructed here (10 Mastered + 5
    // new, 10/15) is the state immediately AFTER that addition, so the
    // flag cannot be auto-derived from the current card composition (it
    // never equals 100% at this snapshot) and must be carried forward
    // explicitly, exactly as section 25.1's "once true, always true"
    // requires.
    const sim = new SchedulerSimulation({
      cards: [...masteredCards, ...newCards],
      random: createSeededRandom(301),
      hasAchievedFullMastery: true,
    });

    expect(sim.fullMasteryUnlocked).toBe(true);
    expect(sim.masteredCount).toBe(10);

    // 41. new cards start has_ever_been_mastered = false.
    for (const card of newCards) {
      expect(sim.getCard(card.cardId).hasEverBeenMastered).toBe(false);
    }

    // 42. ordinary mode while the 5 new cards still need Active acquisition.
    const first = sim.step(true);
    expect(["active_first_pass", "active_weighted_selection"]).toContain(first.selectionReason);
    expect(first.source).toBe("ACTIVE");
    // 43. RANDOM_MASTERED is not mixed into ordinary acquisition mode.
    expect(first.trace.sourceWeightsRaw.randomMastered).toBe(0);

    // Drive every new-* card all the way to ACQUIRED (3 qualifying Corrects
    // each: Fresh -> L1 -> L2 -> ACQUIRED, per section 10 of the spec).
    const newIds = new Set(newCards.map((c) => c.cardId));
    const acquired = new Set<string>();
    for (let i = 0; i < 2000 && acquired.size < newIds.size; i += 1) {
      const decision = sim.step(alwaysCorrect);
      if (decision.cardId !== null && newIds.has(decision.cardId) && sim.getCard(decision.cardId).cardStatus === "ACQUIRED") {
        acquired.add(decision.cardId);
      }
    }
    expect(acquired.size).toBe(newIds.size);
    for (const id of newIds) {
      expect(sim.getCard(id).cardStatus).toBe("ACQUIRED");
      expect(sim.getCard(id).poolStatus).toBe("OUTSIDE");
      // 44. new cards cannot short-restore before first true Mastery.
      expect(sim.getCard(id).hasEverBeenMastered).toBe(false);
    }

    // 11-12/45. Immediately: 10 currently Mastered / 15 total, but ordinary
    // acquisition work is gone -> POST_MASTERY, NOT waiting for 15/15.
    expect(sim.masteredCount).toBe(10);
    expect(sim.fullMasteryUnlocked).toBe(true);
    const postMasteryDecision = sim.step(true);
    expect(postMasteryDecision.trace.schedulerMode.startsWith("post_mastery_")).toBe(true);
    expect(["RANDOM_MASTERED", "FSRS_DUE", "NEAR_DUE"]).toContain(postMasteryDecision.source);
  });
});

// =============================================================================
// TESTS -- SHORT RESTORATION (Phase 7 brief section 26)
// =============================================================================

describe("short restoration (sections 7-8 of the brief)", () => {
  it("14-19. previously-Mastered Wrong -> Relearning -> Repair Correct alone does not restore -> 5+ intervening cards -> Spaced Correct restores Mastery; historical mastery and FSRS lapse history are preserved", () => {
    // All-Mastered baseline (not ordinary ACTIVE/LEARNING fillers): this
    // exercises short restoration specifically IN Post-Mastery mode, so the
    // Repair/Spaced Confirmation steps below are serviced by the Phase 7
    // relearning-servicing tier, not ordinary mode's ACTIVE-source draw.
    const target = makeMasteredCard("target");
    const baseline = Array.from({ length: 15 }, (_, i) => makeMasteredCard(`baseline-${i}`));
    const sim = new SchedulerSimulation({ cards: [target, ...baseline], random: createSeededRandom(302) });
    expect(sim.fullMasteryUnlocked).toBe(true); // 16/16 LEARNED at construction

    // 14. Wrong -> FORGOTTEN/Relearning.
    let wronged = false;
    for (let i = 0; i < 100 && !wronged; i += 1) {
      sim.step((d) => {
        if (d.cardId === "target" && d.selectionReason === "random_mastered_shuffle_bag") {
          wronged = true;
          return false;
        }
        return true;
      });
    }
    expect(wronged).toBe(true);
    const afterWrong = sim.getCard("target");
    expect(afterWrong.cardStatus).toBe("FORGOTTEN");
    expect(afterWrong.poolStatus).toBe("ACTIVE");
    expect(afterWrong.relearningPhase).toBe("REPAIR_PENDING");
    expect(afterWrong.hasEverBeenMastered).toBe(true); // 19 (checked early too): never cleared

    // 15. Repair Correct alone does not restore.
    let repaired = false;
    for (let i = 0; i < 60 && !repaired; i += 1) {
      const decision = sim.step(true);
      if (decision.cardId === "target" && (decision.selectionReason === "repair_target" || decision.selectionReason === "repair_hard_cap")) {
        repaired = true;
      }
    }
    expect(repaired).toBe(true);
    const afterRepair = sim.getCard("target");
    expect(afterRepair.cardStatus).toBe("FORGOTTEN"); // NOT restored yet
    expect(afterRepair.relearningPhase).toBe("SPACED_CONFIRMATION_PENDING");

    // 16. Before 5 intervening cards, no Spaced Confirmation is due yet.
    const gatePosition = afterRepair.correctCooldownUntilPosition!;
    expect(sim.position).toBeLessThan(gatePosition);

    // 17-18. After 5+, Spaced Confirmation becomes eligible and Spaced
    // Correct completes restoration.
    let restored = false;
    for (let i = 0; i < 60 && !restored; i += 1) {
      const decision = sim.step(true);
      if (decision.cardId === "target" && decision.selectionReason === "spaced_confirmation") {
        restored = true;
      }
    }
    expect(restored).toBe(true);
    const final = sim.getCard("target");
    expect(final.cardStatus).toBe("LEARNED"); // MASTERED RESTORED, not ACQUIRED
    expect(final.poolStatus).toBe("OUTSIDE");
    expect(final.relearningPhase).toBeNull();
    expect(final.hasEverBeenMastered).toBe(true); // 19. never cleared
    expect(sim.fullMasteryUnlocked).toBe(true); // historical unlock untouched throughout
  });

  it("20. never-mastered Relearning completion -> ACQUIRED, not Mastered", () => {
    const neverMastered = makeOutsideCard("never-mastered", { hasEverBeenMastered: false });
    const baseline = Array.from({ length: 15 }, (_, i) => makeActiveCard(`baseline-${i}`, { learningStage: "LEARNING_1" }));
    const sim = new SchedulerSimulation({ cards: [neverMastered, ...baseline], random: createSeededRandom(303) });

    let wronged = false;
    for (let i = 0; i < 100 && !wronged; i += 1) {
      sim.step((d) => {
        if (d.cardId === "never-mastered" && (d.selectionReason === "due_weighted_selection" || d.selectionReason === "critical_due_interrupt")) {
          wronged = true;
          return false;
        }
        return true;
      });
    }
    expect(wronged).toBe(true);

    for (let i = 0; i < 80 && sim.getCard("never-mastered").cardStatus === "FORGOTTEN"; i += 1) {
      sim.step(true);
    }
    const final = sim.getCard("never-mastered");
    expect(final.cardStatus).toBe("ACQUIRED"); // not LEARNED
    expect(final.hasEverBeenMastered).toBe(false);
  });
});

// =============================================================================
// TESTS -- FULL-MASTERY LAPSE (Phase 7 brief section 22)
// =============================================================================

describe("Full-Mastery lapse (section 22 of the brief)", () => {
  it("500/500 (scaled down) -> one Wrong -> 499/500 currently Mastered, unlock remains true, only the local card enters Relearning", () => {
    const cards = Array.from({ length: 10 }, (_, i) => makeMasteredCard(`m-${i}`));
    const sim = new SchedulerSimulation({ cards, random: createSeededRandom(304) });
    expect(sim.fullMasteryUnlocked).toBe(true);
    expect(sim.masteredCount).toBe(10);

    let wronged: string | null = null;
    for (let i = 0; i < 100 && wronged === null; i += 1) {
      sim.step((d) => {
        if (d.selectionReason === "random_mastered_shuffle_bag") {
          wronged = d.cardId;
          return false;
        }
        return true;
      });
    }
    expect(wronged).not.toBeNull();
    expect(sim.masteredCount).toBe(9); // 499/500-equivalent
    expect(sim.fullMasteryUnlocked).toBe(true); // never resets
    expect(sim.getCard(wronged!).cardStatus).toBe("FORGOTTEN");

    // Every OTHER card is untouched.
    for (const card of cards) {
      if (card.cardId !== wronged) {
        expect(sim.getCard(card.cardId).cardStatus).toBe("LEARNED");
      }
    }
  });
});

// =============================================================================
// TESTS -- INTERRUPTS / RELEARNING DURING POST-MASTERY (Phase 7 brief section 30)
// =============================================================================

describe("global interrupts during Post-Mastery, and the architecture-conflict fix (section 30 of the brief)", () => {
  it("47. Repair hard cap beats a Post-Mastery source draw", () => {
    const sim = new SchedulerSimulation({ cards: Array.from({ length: 10 }, (_, i) => makeMasteredCard(`m-${i}`)), random: createSeededRandom(305) });
    sim.injectCard(makeRepairGovernedCard("repair-1", makeRepairObligation("repair-1", sim.position, sim.position)));
    const decision = sim.step(true);
    expect(decision.selectionReason).toBe("repair_hard_cap");
  });

  it("48. Critical Due beats an ordinary Post-Mastery draw", () => {
    const sim = new SchedulerSimulation({
      cards: [...Array.from({ length: 10 }, (_, i) => makeMasteredCard(`m-${i}`)), makeCriticallyDueCard("critical-1", 0.1)],
      random: createSeededRandom(306),
    });
    let sawCritical = false;
    for (let i = 0; i < 20 && !sawCritical; i += 1) {
      if (sim.step(true).selectionReason === "critical_due_interrupt") {
        sawCritical = true;
      }
    }
    expect(sawCritical).toBe(true);
  });

  it("49. Repair hard cap beats Critical Due, even in Post-Mastery mode", () => {
    const sim = new SchedulerSimulation({
      cards: [...Array.from({ length: 10 }, (_, i) => makeMasteredCard(`m-${i}`)), makeCriticallyDueCard("critical-1", 0.1)],
      random: createSeededRandom(307),
    });
    sim.injectCard(makeRepairGovernedCard("repair-1", makeRepairObligation("repair-1", sim.position, sim.position)));
    const decision = sim.step(true);
    expect(decision.selectionReason).toBe("repair_hard_cap");
  });

  it("50. the shuffle bag survives an interleaved global interrupt untouched", () => {
    const masteredCards = Array.from({ length: 10 }, (_, i) => makeMasteredCard(`m-${i}`));
    const sim = new SchedulerSimulation({ cards: masteredCards, random: createSeededRandom(308) });

    const first = sim.step(true);
    expect(first.source).toBe("RANDOM_MASTERED");
    const bagBeforeInterrupt = sim.shuffleBag;
    expect(bagBeforeInterrupt).not.toBeNull();

    sim.injectCard(makeRepairGovernedCard("repair-1", makeRepairObligation("repair-1", sim.position, sim.position)));
    const interrupted = sim.step(true);
    expect(interrupted.selectionReason).toBe("repair_hard_cap");
    expect(sim.shuffleBag).toEqual(bagBeforeInterrupt); // completely untouched by the interrupt
  });

  it("proves a lapsed Post-Mastery card is never stranded: Spaced Confirmation actually resolves during pure Post-Mastery mode (the architecture fix)", () => {
    // Pure Post-Mastery: ACTIVE is never an ordinary source here. Without
    // the relearning-servicing tier, this Wronged card's Spaced
    // Confirmation would never be reached (no hard cap exists for it) and
    // it would remain FORGOTTEN forever.
    const masteredCards = Array.from({ length: 10 }, (_, i) => makeMasteredCard(`m-${i}`));
    const sim = new SchedulerSimulation({ cards: masteredCards, random: createSeededRandom(309) });

    let wronged: string | null = null;
    for (let i = 0; i < 100 && wronged === null; i += 1) {
      sim.step((d) => {
        if (d.selectionReason === "random_mastered_shuffle_bag") {
          wronged = d.cardId;
          return false;
        }
        return true;
      });
    }
    expect(wronged).not.toBeNull();

    // Drive many Post-Mastery decisions (every OTHER card is RANDOM_MASTERED/DUE/NEAR,
    // never ACTIVE at the top level) and confirm the lapsed card still
    // completes relearning via the relearning-servicing tier.
    let restored = false;
    for (let i = 0; i < 200 && !restored; i += 1) {
      sim.step(true);
      if (sim.getCard(wronged!).cardStatus === "LEARNED") {
        restored = true;
      }
    }
    expect(restored).toBe(true);
    expect(sim.getCard(wronged!).relearningPhase).toBeNull();
  });
});

// =============================================================================
// TESTS -- LONG POST-MASTERY FREE PLAY (Phase 7 brief section 34)
// =============================================================================

describe("long Post-Mastery free play (stress run)", () => {
  it("runs 500 decisions in Post-Mastery mode mixing RANDOM_MASTERED/DUE/NEAR and relearning servicing, with no invariant violations", () => {
    const cards = [
      ...Array.from({ length: 20 }, (_, i) => makeMasteredCard(`m-${i}`)),
      ...makeDueCards(5),
      makeNearDueCard("near-1"),
    ];
    // The 5 Due + 1 Near-Due cards are ACQUIRED-but-not-yet-Mastered (the
    // ordinary makeDueCards/makeNearDueCard default), so this deck is NOT
    // currently 100% Mastered (20/26) -- hasAchievedFullMastery models the
    // historical fact that it unlocked earlier, before these cards were
    // added, exactly like the "new cards after Full Mastery" test above.
    const sim = new SchedulerSimulation({ cards, random: createSeededRandom(310), hasAchievedFullMastery: true });
    expect(sim.fullMasteryUnlocked).toBe(true);

    let i = 0;
    sim.runSteps(500, (decision) => {
      i += 1;
      if (decision.selectionReason === "repair_target" || decision.selectionReason === "repair_hard_cap" || decision.selectionReason === "spaced_confirmation") {
        return true;
      }
      return i % 6 !== 0; // occasional Wrong to exercise lapse/relearning
    });

    // No NEW/LEARNING cards ever appear -- this deck never had any, and
    // Post-Mastery mode never admits ordinary acquisition cards out of thin air.
    for (const card of sim.getAllCards()) {
      expect(["ACQUIRED", "LEARNED", "FORGOTTEN"]).toContain(card.cardStatus);
    }
    // The historical unlock never reset.
    expect(sim.fullMasteryUnlocked).toBe(true);
    // Every trace stayed internally coherent on mode/source.
    for (const decision of sim.decisions) {
      if (decision.source === "RANDOM_MASTERED") {
        expect(decision.selectionReason).toBe("random_mastered_shuffle_bag");
      }
    }
  });
});

// =============================================================================
// TESTS -- REVIEWED CORRECTIONS (post-goal zero-Due; RANDOM_MASTERED Correct
// actually advances FSRS timing)
// =============================================================================

describe("reviewed corrections: post-goal zero-Due mode, and RANDOM_MASTERED Correct's real FSRS advance", () => {
  it("post-goal + zero Due is reachable in Post-Mastery mode and never throws", () => {
    const sim = new SchedulerSimulation({
      cards: Array.from({ length: 10 }, (_, i) => makeMasteredCard(`m-${i}`)),
      random: createSeededRandom(311),
      dailyGoal: { enemiesDefeatedToday: 5, completed: true },
    });
    expect(() => sim.step(true)).not.toThrow();
    const decision = sim.decisions[0];
    expect(decision.trace.schedulerMode).toBe("post_mastery_post_goal_active_focus");
    expect(decision.trace.sourceWeightsRaw).toMatchObject({ randomMastered: 0.8, due: 0, near: 0.2 });
  });

  it("a RANDOM_MASTERED Correct actually advances the card's FSRS schedule (not a no-op), while mastery counters stay byte-for-byte unchanged", () => {
    // last_review 2 days before FIXTURE_NOW (still comfortably STRONG_OUTSIDE
    // against the 10-day schedule, progress 0.2) so there is genuine elapsed
    // time for the review to act on -- at elapsed=0 (makeMasteredCard's
    // default), a Good review can legitimately leave stability unchanged,
    // which would not distinguish "advanced" from "no-op".
    const solo = makeOutsideCard(
      "solo",
      { cardStatus: "LEARNED", hasEverBeenMastered: true, fsrsReviewCorrectCount: 3, fsrsReviewCorrectStreak: 2 },
      { last_review: new Date(FIXTURE_NOW.getTime() - 2 * 24 * 60 * 60 * 1000) },
    );
    const sim = new SchedulerSimulation({ cards: [solo], random: createSeededRandom(312) });
    const before = sim.getCard("solo");

    let applied = false;
    for (let i = 0; i < 20 && !applied; i += 1) {
      const decision = sim.step(true);
      if (decision.cardId === "solo" && decision.selectionReason === "random_mastered_shuffle_bag") {
        applied = true;
      }
    }
    expect(applied).toBe(true);

    const after = sim.getCard("solo");
    // The harness's simulated clock is frozen (FIXTURE_NOW throughout), so
    // last_review coincides with the card's own pre-existing last_review --
    // the meaningful proof that FSRS genuinely advanced (not a no-op) is
    // that a fresh review recomputed stability/due from the prior state.
    expect(after.fsrsCard.stability).not.toBe(before.fsrsCard.stability);
    expect(after.fsrsCard.due.getTime()).not.toBe(before.fsrsCard.due.getTime());
    expect(after.fsrsReviewCorrectCount).toBe(before.fsrsReviewCorrectCount); // mastery counters untouched
    expect(after.fsrsReviewCorrectStreak).toBe(before.fsrsReviewCorrectStreak);
    expect(after.cardStatus).toBe("LEARNED");
    expect(after.hasEverBeenMastered).toBe(true);
  });

  it("shuffle-bag exhaustion and rebuild happen correctly across a stateful run", () => {
    const sim = new SchedulerSimulation({
      cards: Array.from({ length: 4 }, (_, i) => makeMasteredCard(`m-${i}`)),
      random: createSeededRandom(313),
    });
    const drawn: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const decision = sim.step(true);
      if (decision.source === "RANDOM_MASTERED") {
        drawn.push(decision.cardId!);
      }
    }
    expect(drawn.length).toBeGreaterThan(0);
    // Every 4-draw window should cover all 4 cards (shuffle-bag semantics:
    // no card repeats before the other 3 have each appeared once).
    for (let start = 0; start + 4 <= drawn.length; start += 4) {
      const window = drawn.slice(start, start + 4);
      expect(new Set(window).size).toBe(Math.min(4, window.length));
    }
  });
});
