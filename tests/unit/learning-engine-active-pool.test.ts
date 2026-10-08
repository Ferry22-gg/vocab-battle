import { describe, expect, it } from "vitest";

import {
  buildFirstPassOrder,
  computeActiveAdmissions,
  isFresh,
  selectNewAdmissionCandidates,
  type DeckActivePoolCard,
  type RandomSource,
} from "@/lib/learning-engine/active-pool";
import { applyFirstPresentation, applyNormalCorrect } from "@/lib/learning-engine/transitions";
import { INITIAL_CARD_STATE } from "@/lib/learning-engine/state";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 6, 8,
 * 9 (Phase 3: Active Pool admission/refill and first-encounter ordering).
 *
 * Alpha pre-launch correction: NEW admission (computeActiveAdmissions /
 * selectNewAdmissionCandidates) is now a uniform-random-without-replacement
 * draw over the WHOLE reservoir, never a sort_order-first prefix. Most
 * tests below pass `ZERO_RANDOM` (always returns 0), under which the
 * partial Fisher-Yates in selectNewAdmissionCandidates degenerates to the
 * identity permutation (every swap target j === i, nothing moves) -- i.e.
 * it exercises exactly the same "first N of the reservoir" shape the old
 * deterministic algorithm produced, so these admission-count/capacity
 * assertions need no change beyond threading `random` through. Tests that
 * specifically exercise randomness itself live in their own describe
 * block below ("NEW admission randomness (Alpha pre-launch correction)").
 */
const ZERO_RANDOM: RandomSource = () => 0;

/** Deterministic LCG, not Math.random -- reproducible across runs/CI (same convention as buildFirstPassOrder's own tests below). */
function makeLcg(seed: number): RandomSource {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function newCard(cardId: string): DeckActivePoolCard {
  return { cardId, cardStatus: "NEW", poolStatus: null, learningStage: null };
}

function activeFreshNew(cardId: string): DeckActivePoolCard {
  return { cardId, cardStatus: "NEW", poolStatus: "ACTIVE", learningStage: null };
}

function activeLearning(cardId: string, learningStage: "FRESH" | "LEARNING_1" | "LEARNING_2"): DeckActivePoolCard {
  return { cardId, cardStatus: "LEARNING", poolStatus: "ACTIVE", learningStage };
}

function reservoirOf(n: number, prefix = "r"): DeckActivePoolCard[] {
  return Array.from({ length: n }, (_, i) => newCard(`${prefix}${i}`));
}

describe("isFresh (section 8.2)", () => {
  it("an Active, never-presented NEW card is Fresh", () => {
    expect(isFresh(activeFreshNew("a"))).toBe(true);
  });

  it("an Active card at learningStage FRESH (presented, 0 successes) is Fresh", () => {
    expect(isFresh(activeLearning("a", "FRESH"))).toBe(true);
  });

  it("a card past its first success (LEARNING_1/LEARNING_2) is not Fresh", () => {
    expect(isFresh(activeLearning("a", "LEARNING_1"))).toBe(false);
    expect(isFresh(activeLearning("a", "LEARNING_2"))).toBe(false);
  });

  it("a NEW card not yet admitted (poolStatus null) is not Fresh", () => {
    expect(isFresh(newCard("a"))).toBe(false);
  });

  it("a FORGOTTEN (relearning) card is never Fresh, regardless of poolStatus", () => {
    expect(isFresh({ cardId: "a", cardStatus: "FORGOTTEN", poolStatus: "ACTIVE", learningStage: null })).toBe(false);
  });
});

describe("computeActiveAdmissions (sections 6.1, 8.3, 8.4)", () => {
  it("new deck startup: Active starts at 6, Fresh = 6 (Test 1)", () => {
    const result = computeActiveAdmissions({ activeCards: [], newReservoir: reservoirOf(1000), random: ZERO_RANDOM });
    expect(result.admittedCardIds).toHaveLength(6);
    expect(result.activeCountAfter).toBe(6);
    expect(result.freshCountAfter).toBe(6);
  });

  it("admits fewer than 6 if the NEW reservoir itself has fewer than 6 cards", () => {
    const result = computeActiveAdmissions({ activeCards: [], newReservoir: reservoirOf(3), random: ZERO_RANDOM });
    expect(result.admittedCardIds).toEqual(["r0", "r1", "r2"]);
    expect(result.activeCountAfter).toBe(3);
    expect(result.freshCountAfter).toBe(3);
  });

  it("admission never changes card_status -- admitted cards stay NEW (section 3, invariant 34.1)", () => {
    const result = computeActiveAdmissions({ activeCards: [], newReservoir: reservoirOf(6), random: ZERO_RANDOM });
    // computeActiveAdmissions's result only ever names cardIds to flip
    // pool_status; it has no card_status field to set at all.
    expect(result.admittedCardIds).toHaveLength(6);
    for (const id of result.admittedCardIds) {
      // The only semantics admission carries for `id` is "now Active" --
      // proving the caller must separately decide whether/when to call
      // applyFirstPresentation (Phase 2), never implied by admission.
      expect(typeof id).toBe("string");
    }
  });

  it("no Pre-Active pool: a NEW card goes reservoir -> admitted in one step, never through an intermediate status", () => {
    const result = computeActiveAdmissions({ activeCards: [], newReservoir: reservoirOf(1), random: ZERO_RANDOM });
    expect(result.admittedCardIds).toEqual(["r0"]);
  });

  it("Test 2: one Fresh card's first Correct frees exactly one Fresh slot, admitting exactly one NEW refill", () => {
    const first = computeActiveAdmissions({ activeCards: [], newReservoir: reservoirOf(100), random: ZERO_RANDOM });
    expect(first.admittedCardIds).toHaveLength(6);

    // r0 gets presented and answers Correct: NEW -> LEARNING/FRESH -> LEARNING_1.
    const afterFirstPresented = applyFirstPresentation(INITIAL_CARD_STATE);
    const afterFirstCorrect = applyNormalCorrect(afterFirstPresented);
    expect(afterFirstCorrect.learningStage).toBe("LEARNING_1");

    const activeCardsAfter: DeckActivePoolCard[] = [
      { cardId: "r0", cardStatus: afterFirstCorrect.cardStatus, poolStatus: "ACTIVE", learningStage: afterFirstCorrect.learningStage },
      ...first.admittedCardIds.slice(1).map(activeFreshNew),
    ];
    expect(activeCardsAfter.filter(isFresh)).toHaveLength(5); // Fresh dropped by 1

    const remainingReservoir = reservoirOf(94, "r").map((c) => ({ ...c, cardId: `r${Number(c.cardId.slice(1)) + 6}` }));
    const refill = computeActiveAdmissions({ activeCards: activeCardsAfter, newReservoir: remainingReservoir, random: ZERO_RANDOM });

    expect(refill.admittedCardIds).toHaveLength(1); // exactly one NEW refill
    expect(refill.activeCountAfter).toBe(7); // Active 6 -> 7
    expect(refill.freshCountAfter).toBe(6); // Fresh returns to 6 (back at the cap)
  });

  it("Fresh never exceeds 6, even with plenty of Active target room left", () => {
    // 6 Fresh cards already Active, 4 more non-Fresh Active cards (Active=10, well under target 20).
    const activeCards: DeckActivePoolCard[] = [
      ...Array.from({ length: 6 }, (_, i) => activeFreshNew(`fresh${i}`)),
      ...Array.from({ length: 4 }, (_, i) => activeLearning(`l1-${i}`, "LEARNING_1")),
    ];
    const result = computeActiveAdmissions({ activeCards, newReservoir: reservoirOf(50), random: ZERO_RANDOM });
    expect(result.admittedCardIds).toHaveLength(0);
    expect(result.freshCountAfter).toBe(6);
  });

  it("stops admitting once Active reaches target 20, even if Fresh has room", () => {
    // 20 Active cards, all past Fresh (so Fresh=0, plenty of "Fresh room"), target already saturated.
    const activeCards: DeckActivePoolCard[] = Array.from({ length: 20 }, (_, i) => activeLearning(`l1-${i}`, "LEARNING_1"));
    const result = computeActiveAdmissions({ activeCards, newReservoir: reservoirOf(50), random: ZERO_RANDOM });
    expect(result.admittedCardIds).toHaveLength(0);
    expect(result.activeCountAfter).toBe(20);
  });

  it("an empty NEW reservoir admits nothing even with room on both axes", () => {
    const result = computeActiveAdmissions({ activeCards: [], newReservoir: [], random: ZERO_RANDOM });
    expect(result.admittedCardIds).toEqual([]);
    expect(result.activeCountAfter).toBe(0);
    expect(result.freshCountAfter).toBe(0);
  });

  it("FORGOTTEN (relearning) cards count toward the Active target but never toward Fresh", () => {
    const activeCards: DeckActivePoolCard[] = Array.from({ length: 14 }, (_, i) => ({
      cardId: `forgotten${i}`,
      cardStatus: "FORGOTTEN" as const,
      poolStatus: "ACTIVE" as const,
      learningStage: null,
    }));
    const result = computeActiveAdmissions({ activeCards, newReservoir: reservoirOf(50), random: ZERO_RANDOM });
    // Active=14 (<20), Fresh=0 (<6) -> admits up to the Fresh limit (6), landing Active at 20.
    expect(result.admittedCardIds).toHaveLength(6);
    expect(result.activeCountAfter).toBe(20);
    expect(result.freshCountAfter).toBe(6);
  });

  it("Active grows gradually toward 20 as repeated first-Corrects free Fresh slots (section 8.3's worked example, generalized)", () => {
    let activeCards: DeckActivePoolCard[] = [];
    const reservoir = reservoirOf(1000);
    let nextReservoirIndex = 0;

    const admitFromReservoir = (count: number) => {
      const admitted = reservoir.slice(nextReservoirIndex, nextReservoirIndex + count);
      nextReservoirIndex += count;
      activeCards = [...activeCards, ...admitted.map((c) => activeFreshNew(c.cardId))];
    };

    // Initial admission.
    let step = computeActiveAdmissions({ activeCards, newReservoir: reservoir.slice(nextReservoirIndex), random: ZERO_RANDOM });
    admitFromReservoir(step.admittedCardIds.length);
    expect(step.activeCountAfter).toBe(6);

    const activeCountHistory: number[] = [step.activeCountAfter];

    // Repeatedly: one Fresh card graduates past Fresh (simulated directly,
    // not via a card actually drawn/answered -- Phase 6's draw loop is out
    // of scope), then refill.
    while (step.activeCountAfter < 20) {
      const freshIndex = activeCards.findIndex(isFresh);
      activeCards = activeCards.map((c, i) => (i === freshIndex ? activeLearning(c.cardId, "LEARNING_1") : c));

      step = computeActiveAdmissions({ activeCards, newReservoir: reservoir.slice(nextReservoirIndex), random: ZERO_RANDOM });
      admitFromReservoir(step.admittedCardIds.length);
      activeCountHistory.push(step.activeCountAfter);

      expect(step.freshCountAfter).toBeLessThanOrEqual(6);
    }

    expect(step.activeCountAfter).toBe(20);
    // Strictly non-decreasing (growth, never shrinkage) and, once past the
    // initial burst of 6, grows one at a time -- "gradual", not a jump.
    for (let i = 1; i < activeCountHistory.length; i += 1) {
      expect(activeCountHistory[i]).toBeGreaterThanOrEqual(activeCountHistory[i - 1]);
    }
    expect(activeCountHistory.slice(1)).toEqual(activeCountHistory.slice(1).map((_, i) => 7 + i));
  });
});

describe("NEW admission randomness (Alpha pre-launch correction)", () => {
  it("uniform admission: a scripted RandomSource can select cards outside the first sort_order-ordered entries", () => {
    // A reservoir in ascending sort_order-ish id order, same shape as the
    // real snapshot query's `order by c.sort_order, c.id` -- the point of
    // this test is that the OUTPUT is not simply this input's own prefix.
    const reservoir = reservoirOf(60);
    const result = computeActiveAdmissions({ activeCards: [], newReservoir: reservoir, random: makeLcg(7) });

    expect(result.admittedCardIds).toHaveLength(6);
    const admittedIndices = result.admittedCardIds.map((id) => Number(id.slice(1)));
    // At least one admitted card must come from outside the first six
    // reservoir positions -- proof this is not sort_order-first admission.
    expect(admittedIndices.some((i) => i >= 6)).toBe(true);
  });

  it("without replacement: selecting 6 of 60 always returns 6 distinct cards, for many different RandomSources", () => {
    const reservoir = reservoirOf(60);
    for (let seed = 1; seed <= 25; seed += 1) {
      const result = computeActiveAdmissions({ activeCards: [], newReservoir: reservoir, random: makeLcg(seed) });
      expect(result.admittedCardIds).toHaveLength(6);
      expect(new Set(result.admittedCardIds).size).toBe(6);
    }
  });

  it("Fresh limit: random admission never admits more than FRESH_CARD_LIMIT (6) even from a huge reservoir", () => {
    const reservoir = reservoirOf(1000);
    for (let seed = 1; seed <= 10; seed += 1) {
      const result = computeActiveAdmissions({ activeCards: [], newReservoir: reservoir, random: makeLcg(seed) });
      expect(result.admittedCardIds.length).toBeLessThanOrEqual(6);
      expect(result.freshCountAfter).toBeLessThanOrEqual(6);
    }
  });

  it("Active target: random admission never pushes Active above ACTIVE_POOL_TARGET_SIZE (20)", () => {
    // 18 already-Active non-Fresh cards -- only 2 slots of Active headroom
    // left, even though Fresh headroom (6) would otherwise allow more.
    const activeCards: DeckActivePoolCard[] = Array.from({ length: 18 }, (_, i) => activeLearning(`l1-${i}`, "LEARNING_1"));
    const reservoir = reservoirOf(50);
    for (let seed = 1; seed <= 10; seed += 1) {
      const result = computeActiveAdmissions({ activeCards, newReservoir: reservoir, random: makeLcg(seed) });
      expect(result.admittedCardIds).toHaveLength(2);
      expect(result.activeCountAfter).toBe(20);
    }
  });

  it("small deck: a reservoir with fewer eligible NEW cards than the limit admits exactly all of them, in some order, with no duplicates", () => {
    for (const size of [1, 2, 3, 4, 5]) {
      const reservoir = reservoirOf(size);
      const result = computeActiveAdmissions({ activeCards: [], newReservoir: reservoir, random: makeLcg(size) });
      expect(result.admittedCardIds).toHaveLength(size);
      expect(new Set(result.admittedCardIds).size).toBe(size);
      expect([...result.admittedCardIds].sort()).toEqual(reservoir.map((c) => c.cardId).sort());
    }
  });

  it("existing Active state: an already-ACTIVE NEW card is never re-selected, because it is never part of the reservoir candidate set", () => {
    // Simulates: 2 cards already admitted (ACTIVE) in a prior decision;
    // only the remaining 58 are ever passed as newReservoir, so the
    // randomized selector has no way to re-pick them even in principle.
    const alreadyActive: DeckActivePoolCard[] = [activeFreshNew("already0"), activeFreshNew("already1")];
    const reservoir = reservoirOf(58, "pending");
    for (let seed = 1; seed <= 10; seed += 1) {
      const result = computeActiveAdmissions({ activeCards: alreadyActive, newReservoir: reservoir, random: makeLcg(seed) });
      expect(result.admittedCardIds).not.toContain("already0");
      expect(result.admittedCardIds).not.toContain("already1");
      expect(result.admittedCardIds.every((id) => id.startsWith("pending"))).toBe(true);
    }
  });

  it("reload/recompute stability: recomputing admission against a snapshot where the prior admission is already persisted as Active does not change or replace that admitted set", () => {
    const reservoir = reservoirOf(60);
    const first = computeActiveAdmissions({ activeCards: [], newReservoir: reservoir, random: makeLcg(3) });
    expect(first.admittedCardIds).toHaveLength(6);

    // Simulate persistence: the 6 admitted cards are now poolStatus ACTIVE
    // (still cardStatus NEW, still Fresh -- no card has been presented),
    // so they are EXCLUDED from any future newReservoir by construction
    // (the real snapshot query only ever includes poolStatus = null rows).
    const admittedSet = new Set(first.admittedCardIds);
    const remainingReservoir = reservoir.filter((c) => !admittedSet.has(c.cardId));
    const activeCardsAfterPersistence = reservoir.filter((c) => admittedSet.has(c.cardId)).map((c) => activeFreshNew(c.cardId));

    // "Reload" = recompute from this now-persisted state, with a
    // DIFFERENT random draw than the first decision used -- proving
    // stability comes from the reservoir filter, not from reusing the
    // same RandomSource/seed.
    const reloaded = computeActiveAdmissions({
      activeCards: activeCardsAfterPersistence,
      newReservoir: remainingReservoir,
      random: makeLcg(999),
    });

    // Fresh is already at the cap (6) from the persisted admission, so no
    // further admission happens, and critically: none of the previously-
    // admitted cards reappear as a "new" admission.
    expect(reloaded.admittedCardIds).toHaveLength(0);
    for (const id of first.admittedCardIds) {
      expect(reloaded.admittedCardIds).not.toContain(id);
    }
  });

  it("refill: freeing one Fresh slot admits exactly one more random reservoir card, which may be any remaining card, not a fixed index", () => {
    const reservoir = reservoirOf(60);
    const first = computeActiveAdmissions({ activeCards: [], newReservoir: reservoir, random: makeLcg(11) });
    const admittedSet = new Set(first.admittedCardIds);

    // One admitted card graduates past Fresh (its first Correct).
    const [graduated, ...stillFresh] = first.admittedCardIds;
    const activeCardsAfter: DeckActivePoolCard[] = [activeLearning(graduated, "LEARNING_1"), ...stillFresh.map(activeFreshNew)];
    const remainingReservoir = reservoir.filter((c) => !admittedSet.has(c.cardId));

    const refill = computeActiveAdmissions({ activeCards: activeCardsAfter, newReservoir: remainingReservoir, random: makeLcg(23) });
    expect(refill.admittedCardIds).toHaveLength(1);
    // The refilled card must come from the TRUE remaining reservoir, never
    // one already admitted in the first batch.
    expect(admittedSet.has(refill.admittedCardIds[0])).toBe(false);
  });

  it("distribution sanity: across many trials with a real production-like RandomSource, admission is not restricted to low-index reservoir cards", () => {
    // Broad sanity bound only (not an exact-frequency statistical test,
    // per this task's own instruction): over 200 independent trials
    // drawing 6 of 60, SOME trial must admit a card from the second half
    // of the reservoir (index >= 30). A sort_order-first implementation
    // would make this impossible in every single trial.
    const reservoir = reservoirOf(60);
    let sawSecondHalf = false;
    for (let trial = 0; trial < 200 && !sawSecondHalf; trial += 1) {
      const result = computeActiveAdmissions({ activeCards: [], newReservoir: reservoir, random: Math.random });
      if (result.admittedCardIds.some((id) => Number(id.slice(1)) >= 30)) {
        sawSecondHalf = true;
      }
    }
    expect(sawSecondHalf).toBe(true);
  });

  it("selectNewAdmissionCandidates in isolation: equal selection probability is not biased toward input order (broad sanity bound)", () => {
    // Over many trials selecting 1 of 4 candidates, every candidate should
    // be selected at least once -- a broad existence check, not a
    // frequency/chi-squared test, per this task's explicit instruction to
    // avoid fragile exact-frequency assertions.
    const seen = new Set<string>();
    for (let seed = 1; seed <= 200; seed += 1) {
      const picked = selectNewAdmissionCandidates({ candidates: ["w", "x", "y", "z"], count: 1, random: makeLcg(seed) });
      expect(picked).toHaveLength(1);
      seen.add(picked[0]);
    }
    expect(seen.size).toBe(4);
  });

  it("first-pass regression: the admitted set's randomness is independent of the first-pass presentation shuffle, and first-pass remains a true no-repeat permutation of whatever was admitted", () => {
    const reservoir = reservoirOf(60);
    const admission = computeActiveAdmissions({ activeCards: [], newReservoir: reservoir, random: makeLcg(5) });
    expect(admission.admittedCardIds).toHaveLength(6);

    // A DIFFERENT RandomSource (different seed entirely) drives first-pass
    // presentation order -- the two decisions do not share derived state,
    // only the fact that both are pure functions of their own injected
    // RandomSource.
    const presentationOrder = buildFirstPassOrder(admission.admittedCardIds, makeLcg(999));

    // First-pass is still exactly a permutation of whatever admission
    // produced (no-repeat, full coverage), regardless of how admission
    // itself selected that set.
    expect([...presentationOrder].sort()).toEqual([...admission.admittedCardIds].sort());
    expect(new Set(presentationOrder).size).toBe(6);
  });
});

describe("buildFirstPassOrder (section 9)", () => {
  it("is a permutation of the input -- every card appears exactly once, no repeats", () => {
    const ids = ["A", "B", "C", "D", "E", "F"];
    let seed = 42;
    const random = () => {
      // Deterministic LCG, not Math.random -- reproducible across runs/CI.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const order = buildFirstPassOrder(ids, random);
    expect([...order].sort()).toEqual([...ids].sort());
    expect(new Set(order).size).toBe(ids.length);
  });

  it("does not mutate the input array", () => {
    const ids = ["A", "B", "C"];
    buildFirstPassOrder(ids, () => 0.5);
    expect(ids).toEqual(["A", "B", "C"]);
  });

  it("is deterministic given a scripted RandomSource (section 24: seeded reproducibility)", () => {
    const ids = ["A", "B", "C", "D"];
    const script = [0.1, 0.9, 0.5];
    let i = 0;
    const scriptedRandom = () => script[i++];

    const run = () => {
      i = 0;
      return buildFirstPassOrder(ids, scriptedRandom);
    };

    expect(run()).toEqual(run());
  });

  it("an empty or single-element input returns it unchanged", () => {
    expect(buildFirstPassOrder([], () => 0.5)).toEqual([]);
    expect(buildFirstPassOrder(["only"], () => 0.5)).toEqual(["only"]);
  });
});
