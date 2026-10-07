import { describe, expect, it } from "vitest";

import { SchedulerSimulation, makeActiveCard } from "../helpers/learning-engine-simulation";
import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

/** Plenty of ordinary LEARNING_1 Active candidates -- mirrors tests/unit/learning-engine-scheduler-simulation.test.ts's own local helper of the same name (not shared/exported, so duplicated here rather than cross-importing one test file from another). */
function bigBaselineDeck(count: number, prefix = "baseline"): SchedulableCardRow[] {
  return Array.from({ length: count }, (_, i) => makeActiveCard(`${prefix}-${i}`, { learningStage: "LEARNING_1" }));
}

/**
 * Stage 0 audit follow-up: end-to-end position-semantics tests (task
 * section 6, cases A-G) exercising the REAL composition -- claim position
 * -> answer preparation -> answer commit position -> intervening committed
 * answers -> next-card selection -- through `SchedulerSimulation.step()`,
 * never constructing a synthetic `wrongPosition`/`schedulerPosition` pair
 * directly the way the PRE-EXISTING pure-helper tests did (the exact gap
 * that let the original off-by-one through -- see this suite's own Stage
 * 0 audit report).
 *
 * `random: () => 0` is used throughout (deterministic): `sampleRepairGap`'s
 * index 0 -> gap 3 whenever a repair is freshly created. Every boundary
 * below is verified by directly counting real intervening `step()` calls,
 * never by constructing a position literal.
 */

function deterministicWrong(sim: SchedulerSimulation): { cardId: string; wrongN: number } {
  let cardId: string | null = null;
  let wrongN = 0;
  for (let i = 0; i < 50 && cardId === null; i += 1) {
    const decision = sim.step((d) => {
      if (d.cardId !== null && (d.selectionReason === "active_weighted_selection" || d.selectionReason === "active_starvation" || d.selectionReason === "active_first_pass")) {
        wrongN = sim.position; // PRE-step position, i.e. the claim's own presentation position N -- sim.position has not yet advanced for THIS draw.
        cardId = d.cardId;
        return false; // Wrong it
      }
      return true;
    });
    void decision;
  }
  if (cardId === null) throw new Error("deterministicWrong: no ordinary Active card ever presented");
  return { cardId, wrongN };
}

function answerOthers(sim: SchedulerSimulation, count: number, excludedCardId: string, correct = true): void {
  for (let i = 0; i < count; i += 1) {
    const decision = sim.step(correct);
    expect(decision.cardId).not.toBeNull();
    expect(decision.cardId).not.toBe(excludedCardId);
  }
}

describe("position-semantics end-to-end (Stage 0 audit, task section 6)", () => {
  it("A. Repair minimum boundary: not eligible after 0, 1, or 2 intervening answers; eligible at exactly 3", () => {
    const sim = new SchedulerSimulation({ cards: bigBaselineDeck(30), random: () => 0 });
    const { cardId, wrongN } = deterministicWrong(sim);

    const targetPosition = sim.getCard(cardId).repairObligation!.targetPosition;
    expect(targetPosition).toBe(wrongN + 4); // gap 3 -> N + 3 + 1

    for (let intervening = 0; intervening <= 2; intervening += 1) {
      expect(sim.position).toBeLessThan(targetPosition); // not yet eligible
      answerOthers(sim, 1, cardId);
    }
    expect(sim.position).toBe(targetPosition); // exactly 3 intervening answers committed -> eligible now
  });

  it("B. Repair target gaps 3/4/5/6 each correspond to exactly that many completed intervening cards", () => {
    // One fresh simulation per gap, sampled gap forced via the RNG index
    // sampleRepairGap uses (REPAIR_GAP_OPTIONS = [3,4,5,6]).
    const gapRandoms: Array<[number, () => number]> = [
      [3, () => 0.0], // index 0
      [4, () => 0.3], // index 1
      [5, () => 0.6], // index 2
      [6, () => 0.99], // index 3
    ];
    for (const [gap, random] of gapRandoms) {
      const sim = new SchedulerSimulation({ cards: bigBaselineDeck(30), random });
      const { cardId, wrongN } = deterministicWrong(sim);
      const obligation = sim.getCard(cardId).repairObligation!;
      expect(obligation.targetPosition).toBe(wrongN + gap + 1);

      for (let i = 0; i < gap; i += 1) {
        expect(sim.position).toBeLessThan(obligation.targetPosition);
        answerOthers(sim, 1, cardId);
      }
      expect(sim.position).toBe(obligation.targetPosition);
    }
  });

  it("C. Repair hard cap: not mandatory after 5 intervening answers; mandatory and selected at exactly 6", () => {
    // Sampled gap forced to 6 (index 3) so targetPosition and
    // hardCapPosition coincide exactly -- otherwise (e.g. gap 3) the card
    // becomes an ORDINARY repair_target candidate well before the hard
    // cap and could legitimately win a weighted draw during the
    // "intervening" loop below, which would resolve the obligation early
    // and invalidate this test's own setup (it is testing the MANDATORY
    // boundary specifically, not target-eligibility -- see test B above
    // for that).
    const sim = new SchedulerSimulation({ cards: bigBaselineDeck(30), random: () => 0.99 });
    const { cardId, wrongN } = deterministicWrong(sim);
    const hardCapPosition = sim.getCard(cardId).repairObligation!.hardCapPosition;
    expect(hardCapPosition).toBe(wrongN + 7); // fixed, independent of the sampled gap
    expect(sim.getCard(cardId).repairObligation!.targetPosition).toBe(hardCapPosition); // gap 6 coincides with the hard cap

    for (let intervening = 0; intervening <= 4; intervening += 1) {
      expect(sim.position).toBeLessThan(hardCapPosition);
      answerOthers(sim, 1, cardId);
    }
    expect(sim.position).toBeLessThan(hardCapPosition); // still only 5 intervening answers so far

    answerOthers(sim, 1, cardId); // the 6th intervening answer
    expect(sim.position).toBe(hardCapPosition);

    // Mandatory: GUARANTEED to be the next decision, never merely eligible.
    const decision = sim.step(true);
    expect(decision.cardId).toBe(cardId);
    expect(decision.selectionReason).toBe("repair_hard_cap");
  });

  it("D. Correct cooldown: blocked for 0-4 intervening answers, eligible at exactly 5", () => {
    const sim = new SchedulerSimulation({ cards: bigBaselineDeck(30), random: () => 0 });
    let cardId: string | null = null;
    let correctN = 0;
    for (let i = 0; i < 50 && cardId === null; i += 1) {
      const decision = sim.step((d) => {
        if (d.cardId !== null && (d.selectionReason === "active_weighted_selection" || d.selectionReason === "active_starvation" || d.selectionReason === "active_first_pass")) {
          correctN = sim.position;
          cardId = d.cardId;
        }
        return true; // Correct it
      });
      void decision;
    }
    if (cardId === null) throw new Error("no ordinary Active card ever presented");

    const cooldownUntil = sim.getCard(cardId).correctCooldownUntilPosition!;
    expect(cooldownUntil).toBe(correctN + 6); // CORRECT_MIN_GAP(5) + 1

    for (let intervening = 0; intervening <= 3; intervening += 1) {
      expect(sim.position).toBeLessThan(cooldownUntil);
      answerOthers(sim, 1, cardId);
    }
    expect(sim.position).toBeLessThan(cooldownUntil); // 4 intervening so far, still blocked

    answerOthers(sim, 1, cardId); // the 5th intervening answer
    expect(sim.position).toBe(cooldownUntil); // eligible now
  });

  it("E. Repeat Wrong on a Repair presentation: a fresh obligation is scheduled using the corrected position scale", () => {
    const sim = new SchedulerSimulation({ cards: bigBaselineDeck(30), random: () => 0 });
    const { cardId, wrongN } = deterministicWrong(sim);
    const firstTarget = sim.getCard(cardId).repairObligation!.targetPosition;
    expect(firstTarget).toBe(wrongN + 4);

    // Drive to eligibility, then Wrong the repair retry itself.
    answerOthers(sim, 3, cardId);
    expect(sim.position).toBe(firstTarget);

    let retryWrongN = -1;
    for (let i = 0; i < 20; i += 1) {
      const decision = sim.step((d) => {
        if (d.cardId === cardId) {
          expect(d.selectionReason === "repair_target" || d.selectionReason === "repair_hard_cap").toBe(true);
          retryWrongN = sim.position;
          return false; // Wrong the retry
        }
        return true;
      });
      if (decision.cardId === cardId) break;
    }
    expect(retryWrongN).toBeGreaterThanOrEqual(0);

    const card = sim.getCard(cardId);
    expect(card.repairPending).toBe(true);
    const freshObligation = card.repairObligation!;
    expect(freshObligation.wrongPosition).toBe(retryWrongN); // anchored at the Wrong retry's OWN presentation position, never the old one
    expect(freshObligation.targetPosition).toBe(retryWrongN + 4);
  });

  it("F. Repair Correct: obligation cleared, L1 does not advance to L2 on a repair resolution", () => {
    const sim = new SchedulerSimulation({ cards: bigBaselineDeck(30), random: () => 0 });
    const { cardId } = deterministicWrong(sim);
    const stageBeforeWrong = sim.getCard(cardId).learningStage;

    answerOthers(sim, 3, cardId);

    let resolved = false;
    for (let i = 0; i < 20 && !resolved; i += 1) {
      const decision = sim.step((d) => {
        if (d.cardId === cardId) {
          resolved = true;
          return true; // Correct the retry
        }
        return true;
      });
      void decision;
    }
    expect(resolved).toBe(true);

    const card = sim.getCard(cardId);
    expect(card.repairPending).toBe(false);
    expect(card.repairObligation).toBeNull();
    expect(card.correctCooldownUntilPosition).not.toBeNull(); // the normal 5-intervening-card gate begins
    // A repair Correct is never a normal stage-advancing success (section
    // 12.3) -- LEARNING_1 stays LEARNING_1 (the FRESH exception does not
    // apply here, since this card started at LEARNING_1 before the Wrong).
    if (stageBeforeWrong !== "FRESH") {
      expect(card.learningStage).toBe(stageBeforeWrong);
    }
  });

  it("G. Small-deck liveness regression: emergency_repair_relaxation remains valid after the timing correction (1-card deck)", () => {
    const sim = new SchedulerSimulation({ cards: bigBaselineDeck(1), random: () => 0 });
    // Wrong the only card -- it becomes the only card in the deck AND is
    // now repair-governed, so ordinary Active selection has nothing left
    // to offer and the ordinary-cooldown emergency fallback cannot help
    // either (it never relaxes a governed card) -- only the Repair
    // liveness fallback (emergency_repair_relaxation) can present it again
    // before its own normal gate opens.
    const first = sim.step(false);
    expect(first.cardId).not.toBeNull();
    const cardId = first.cardId!;

    const second = sim.step(true);
    expect(second.cardId).toBe(cardId);
    expect(second.selectionReason).toBe("emergency_repair_relaxation");
  });
});
