import { describe, expect, it } from "vitest";

import {
  assignForgottenOrdinals,
  computeNormalizedCardProgress,
  computeNormalizedForgottenCard,
} from "@/lib/learning-engine/cutover/normalize-legacy-state";
import { createDeterministicRandom, buildNormalizationSeed } from "@/lib/learning-engine/cutover/deterministic-random";
import {
  createRepairObligation,
  isGovernedByRepairObligation,
  isRepairHardCapReached,
  isRepairTargetReached,
} from "@/lib/learning-engine/repair-scheduler";
import { WRONG_RETRY_HARD_CAP } from "@/lib/learning-engine/config";

/**
 * Unit tests for the Runtime Cutover RC-A one-time legacy-normalization
 * logic (approved plan sections 3/4, R1, R2, and the resolved pre-RC-A
 * invariant check). These tests are the "RC-A tests for legacy
 * FORGOTTEN" the approval explicitly requires, at the pure-TS level.
 */

function seededRandom(cardId: string, ordinal: number) {
  const seed = buildNormalizationSeed({ normalizationVersion: "test-version", deckId: "deck-x", cardId });
  return { seed, random: createDeterministicRandom(seed), ordinal };
}

describe("computeNormalizedCardProgress -- NEW", () => {
  it("is a true no-op target matching the engine's own INITIAL_CARD_STATE shape", () => {
    const { random } = seededRandom("card-new", 0);
    const target = computeNormalizedCardProgress({ legacyCardStatus: "NEW", cardId: "card-new", forgottenOrdinal: 0, random });

    expect(target.cardStatus).toBe("NEW");
    expect(target.learningStage).toBeNull();
    expect(target.poolStatus).toBeNull();
    expect(target.relearningPhase).toBeNull();
    expect(target.hasEverBeenMastered).toBe(false);
    expect(target.repairPending).toBe(false);
    expect(target.repairWrongPosition).toBeNull();
    expect(target.repairTargetPosition).toBeNull();
    expect(target.repairHardCapPosition).toBeNull();
  });
});

describe("computeNormalizedCardProgress -- LEARNING (R1, approved)", () => {
  it("normalizes to FRESH + ACTIVE, never inferring LEARNING_1/LEARNING_2", () => {
    const { random } = seededRandom("card-learning", 0);
    const target = computeNormalizedCardProgress({ legacyCardStatus: "LEARNING", cardId: "card-learning", forgottenOrdinal: 0, random });

    expect(target.cardStatus).toBe("LEARNING");
    expect(target.learningStage).toBe("FRESH");
    expect(target.poolStatus).toBe("ACTIVE");
    expect(target.relearningPhase).toBeNull();
    expect(target.hasEverBeenMastered).toBe(false);
    expect(target.repairPending).toBe(false);
    expect(target.repairWrongPosition).toBeNull();
    expect(target.repairTargetPosition).toBeNull();
    expect(target.repairHardCapPosition).toBeNull();
  });
});

describe("computeNormalizedCardProgress -- LEARNED", () => {
  it("normalizes pool_status to OUTSIDE, preserving has_ever_been_mastered=true and no repair state", () => {
    const { random } = seededRandom("card-learned", 0);
    const target = computeNormalizedCardProgress({ legacyCardStatus: "LEARNED", cardId: "card-learned", forgottenOrdinal: 0, random });

    expect(target.cardStatus).toBe("LEARNED");
    expect(target.learningStage).toBeNull();
    expect(target.poolStatus).toBe("OUTSIDE");
    expect(target.relearningPhase).toBeNull();
    expect(target.hasEverBeenMastered).toBe(true);
    expect(target.repairPending).toBe(false);
    expect(target.repairWrongPosition).toBeNull();
    expect(target.repairTargetPosition).toBeNull();
    expect(target.repairHardCapPosition).toBeNull();
  });
});

describe("computeNormalizedForgottenCard / computeNormalizedCardProgress -- FORGOTTEN (R2 + pre-RC-A repair-completeness rule)", () => {
  it("produces a complete RepairObligation -- no repair position is NULL", () => {
    const { random } = seededRandom("card-forgotten", 3);
    const target = computeNormalizedForgottenCard(3, random, "card-forgotten");

    expect(target.repairWrongPosition).not.toBeNull();
    expect(target.repairTargetPosition).not.toBeNull();
    expect(target.repairHardCapPosition).not.toBeNull();
  });

  it("sets the full relearning-entry card state: FORGOTTEN / ACTIVE / REPAIR_PENDING / has_ever_been_mastered=true / repair_pending=true", () => {
    const { random } = seededRandom("card-forgotten", 0);
    const target = computeNormalizedForgottenCard(0, random, "card-forgotten");

    expect(target.cardStatus).toBe("FORGOTTEN");
    expect(target.learningStage).toBeNull();
    expect(target.poolStatus).toBe("ACTIVE");
    expect(target.relearningPhase).toBe("REPAIR_PENDING");
    expect(target.hasEverBeenMastered).toBe(true);
    expect(target.repairPending).toBe(true);
  });

  it("the synthetic wrongPosition is exactly the supplied ordinal, and target/hard-cap obey the real 3-6-intervening-card formula relative to it", () => {
    const ordinal = 5;
    const { random } = seededRandom("card-forgotten", ordinal);
    const target = computeNormalizedForgottenCard(ordinal, random, "card-forgotten");

    expect(target.repairWrongPosition).toBe(ordinal);
    expect(target.repairTargetPosition!).toBeGreaterThanOrEqual(ordinal + 4);
    expect(target.repairTargetPosition!).toBeLessThanOrEqual(ordinal + WRONG_RETRY_HARD_CAP + 1);
    expect(target.repairHardCapPosition).toBe(ordinal + WRONG_RETRY_HARD_CAP + 1);
    expect(target.repairHardCapPosition!).toBeGreaterThanOrEqual(target.repairTargetPosition!);
  });

  it("produces the exact same RepairObligation a direct createRepairObligation() call would, given the same deterministic random -- the real function is never reimplemented or approximated", () => {
    const ordinal = 2;
    const { random: randomForModule } = seededRandom("card-forgotten", ordinal);
    const { random: randomForDirectCall } = seededRandom("card-forgotten", ordinal);

    const viaModule = computeNormalizedForgottenCard(ordinal, randomForModule, "card-forgotten");
    const direct = createRepairObligation({ cardId: "card-forgotten", wrongPosition: ordinal, random: randomForDirectCall });

    expect(viaModule.repairWrongPosition).toBe(direct.wrongPosition);
    expect(viaModule.repairTargetPosition).toBe(direct.targetPosition);
    expect(viaModule.repairHardCapPosition).toBe(direct.hardCapPosition);
  });

  it("is deterministic: re-running normalization for the same card + same normalization version reproduces the identical obligation", () => {
    const cardId = "card-forgotten";
    const ordinal = 7;
    const seed = buildNormalizationSeed({ normalizationVersion: "same-version", deckId: "deck-x", cardId });

    const first = computeNormalizedForgottenCard(ordinal, createDeterministicRandom(seed), cardId);
    const second = computeNormalizedForgottenCard(ordinal, createDeterministicRandom(seed), cardId);

    expect(first).toEqual(second);
  });

  it("is excluded from ordinary Active selection (isGovernedByRepairObligation) while repair-governed", () => {
    const { random } = seededRandom("card-forgotten", 0);
    const target = computeNormalizedForgottenCard(0, random, "card-forgotten");

    expect(isGovernedByRepairObligation({ repairPending: target.repairPending, relearningPhase: target.relearningPhase })).toBe(true);
  });

  it("is serviceable through the normal repair scheduler: not reached before the target, reached once the target position is hit, and hard-capped by position wrong+7", () => {
    const ordinal = 10;
    const { random } = seededRandom("card-forgotten", ordinal);
    const target = computeNormalizedForgottenCard(ordinal, random, "card-forgotten");

    const obligation = {
      cardId: "card-forgotten",
      wrongPosition: target.repairWrongPosition!,
      targetPosition: target.repairTargetPosition!,
      hardCapPosition: target.repairHardCapPosition!,
    };

    // One position before the window opens: neither target nor hard cap reached.
    expect(isRepairTargetReached(obligation, obligation.targetPosition - 1)).toBe(false);
    expect(isRepairHardCapReached(obligation, obligation.targetPosition - 1)).toBe(false);

    // Exactly at the sampled target: target reached (serviceable), hard cap not yet
    // (unless the sampled gap happened to be the maximum, in which case target ==
    // hardCap and this is also the hard cap -- a legitimate, already-tested edge
    // case of the real repair scheduler, not something this normalization invents).
    expect(isRepairTargetReached(obligation, obligation.targetPosition)).toBe(true);

    // At the (always-present) hard cap: mandatory interrupt eligible.
    expect(isRepairHardCapReached(obligation, obligation.hardCapPosition)).toBe(true);
  });
});

describe("assignForgottenOrdinals", () => {
  it("assigns stable, ascending-card_id ordinals starting at 0", () => {
    const ordinals = assignForgottenOrdinals(["card-c", "card-a", "card-b"]);
    expect(ordinals.get("card-a")).toBe(0);
    expect(ordinals.get("card-b")).toBe(1);
    expect(ordinals.get("card-c")).toBe(2);
  });

  it("is a pure function of the input set: re-running with the same card ids produces the same ordinals", () => {
    const ids = ["card-z", "card-x", "card-y"];
    const first = assignForgottenOrdinals(ids);
    const second = assignForgottenOrdinals([...ids]);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it("multiple FORGOTTEN cards in the same deck do not all share the same hard-cap position", () => {
    const ids = ["card-1", "card-2", "card-3", "card-4", "card-5"];
    const ordinals = assignForgottenOrdinals(ids);

    const hardCaps = ids.map((cardId) => {
      const ordinal = ordinals.get(cardId)!;
      const { random } = seededRandom(cardId, ordinal);
      return computeNormalizedForgottenCard(ordinal, random, cardId).repairHardCapPosition;
    });

    expect(new Set(hardCaps).size).toBe(hardCaps.length);
  });
});

describe("normal v1 Wrong handling never uses synthetic anchors (documentation-level audit guard)", () => {
  it("a real createRepairObligation() call with a REAL current scheduler position (unrelated to any synthetic ordinal) behaves identically to every other call -- this module adds no special-casing to the shared function", () => {
    const realCurrentSchedulerPosition = 184;
    const obligation = createRepairObligation({
      cardId: "any-card",
      wrongPosition: realCurrentSchedulerPosition,
      random: createDeterministicRandom("irrelevant-to-real-wrongs"),
    });
    expect(obligation.wrongPosition).toBe(realCurrentSchedulerPosition);
    expect(obligation.hardCapPosition).toBe(realCurrentSchedulerPosition + WRONG_RETRY_HARD_CAP + 1);
  });
});
