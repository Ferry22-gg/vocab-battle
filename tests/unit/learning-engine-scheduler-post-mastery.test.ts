import { describe, expect, it, vi, afterEach } from "vitest";

import {
  computeHasAchievedFullMastery,
  hasOrdinaryActiveAcquisitionWork,
  shouldUsePostMasteryMode,
} from "@/lib/learning-engine/scheduler/post-mastery-mode";
import {
  computePostMasterySourceWeights,
  renormalizePostMasterySourceWeights,
} from "@/lib/learning-engine/scheduler/post-mastery-source-policy";
import {
  chooseRandomMasteredCard,
  drawFromShuffleBag,
  reconcileShuffleBag,
  selectStrongMasteredCandidateIds,
} from "@/lib/learning-engine/scheduler/random-mastered-selection";
import { createSeededRandom, makeMasteredCard, makeOutsideCard, FIXTURE_NOW } from "../helpers/learning-engine-simulation";

/**
 * Phase 7 (Post-Mastery Mode): pure-function unit tests for the mode
 * predicate, historical unlock rule, Post-Mastery source policy, and the
 * RANDOM_MASTERED eligibility/shuffle-bag mechanics. See
 * tests/unit/learning-engine-scheduler-post-mastery-simulation.test.ts
 * for end-to-end stateful coverage through the real integrated scheduler.
 */

// =============================================================================
// TESTS -- FULL MASTERY UNLOCK (Phase 7 brief section 24)
// =============================================================================

describe("computeHasAchievedFullMastery (section 3 of the brief)", () => {
  it("1. below current full mastery threshold: unlock does not newly flip true", () => {
    expect(computeHasAchievedFullMastery({ currentlyUnlocked: false, masteredCount: 499, totalCards: 500 })).toBe(false);
  });

  it("2. first current full mastery: false -> true", () => {
    expect(computeHasAchievedFullMastery({ currentlyUnlocked: false, masteredCount: 500, totalCards: 500 })).toBe(true);
  });

  it("3. once true: remains true after a lapse (masteredCount drops)", () => {
    expect(computeHasAchievedFullMastery({ currentlyUnlocked: true, masteredCount: 499, totalCards: 500 })).toBe(true);
  });

  it("4. once true: remains true after new cards are added (totalCards grows)", () => {
    expect(computeHasAchievedFullMastery({ currentlyUnlocked: true, masteredCount: 500, totalCards: 520 })).toBe(true);
  });

  it("is monotonic across a realistic sequence: 499/500 -> 500/500 -> (add 20) 500/520 -> (lapse) 499/520", () => {
    let unlocked = false;
    unlocked = computeHasAchievedFullMastery({ currentlyUnlocked: unlocked, masteredCount: 499, totalCards: 500 });
    expect(unlocked).toBe(false);
    unlocked = computeHasAchievedFullMastery({ currentlyUnlocked: unlocked, masteredCount: 500, totalCards: 500 });
    expect(unlocked).toBe(true);
    unlocked = computeHasAchievedFullMastery({ currentlyUnlocked: unlocked, masteredCount: 500, totalCards: 520 });
    expect(unlocked).toBe(true);
    unlocked = computeHasAchievedFullMastery({ currentlyUnlocked: unlocked, masteredCount: 499, totalCards: 520 });
    expect(unlocked).toBe(true);
  });

  it("an empty deck (0/0) does not spuriously unlock", () => {
    expect(computeHasAchievedFullMastery({ currentlyUnlocked: false, masteredCount: 0, totalCards: 0 })).toBe(false);
  });
});

// =============================================================================
// TESTS -- MODE RETURN CONDITION (Phase 7 brief section 25)
// =============================================================================

describe("hasOrdinaryActiveAcquisitionWork / shouldUsePostMasteryMode (sections 4-6 of the brief)", () => {
  it("6. unlock=true + NEW exists -> ORDINARY", () => {
    expect(shouldUsePostMasteryMode({ hasAchievedFullMastery: true, cards: [{ cardStatus: "NEW" }] })).toBe(false);
  });

  it("7. unlock=true + LEARNING/FRESH exists -> ORDINARY", () => {
    expect(shouldUsePostMasteryMode({ hasAchievedFullMastery: true, cards: [{ cardStatus: "LEARNING" }] })).toBe(false);
  });

  it("8-9. unlock=true + LEARNING (LEARNING_1/LEARNING_2 are not separately tracked in cardStatus) -> ORDINARY", () => {
    // learningStage is not part of ModeDecisionCard's shape -- cardStatus
    // "LEARNING" alone already covers FRESH/LEARNING_1/LEARNING_2 (section 5).
    expect(hasOrdinaryActiveAcquisitionWork([{ cardStatus: "LEARNING" }])).toBe(true);
  });

  it("10. unlock=true + only ACQUIRED new cards remain -> POST_MASTERY", () => {
    expect(shouldUsePostMasteryMode({ hasAchievedFullMastery: true, cards: [{ cardStatus: "ACQUIRED" }] })).toBe(true);
  });

  it("11-12. 500 Mastered + 20 ACQUIRED / 520 total -> POST_MASTERY (does NOT require 520/520 Mastered)", () => {
    const cards = [
      ...Array.from({ length: 500 }, () => ({ cardStatus: "LEARNED" as const })),
      ...Array.from({ length: 20 }, () => ({ cardStatus: "ACQUIRED" as const })),
    ];
    expect(shouldUsePostMasteryMode({ hasAchievedFullMastery: true, cards })).toBe(true);
  });

  it("FORGOTTEN (local relearning) does not block Post-Mastery -- section 6: 'local relearning is not new acquisition'", () => {
    const cards = [{ cardStatus: "LEARNED" as const }, { cardStatus: "FORGOTTEN" as const }];
    expect(shouldUsePostMasteryMode({ hasAchievedFullMastery: true, cards })).toBe(true);
  });

  it("unlock=false, regardless of card composition (even 100% currently Mastered) -> ORDINARY; the predicate trusts the flag, never re-derives it", () => {
    const allMastered = Array.from({ length: 500 }, () => ({ cardStatus: "LEARNED" as const }));
    expect(shouldUsePostMasteryMode({ hasAchievedFullMastery: false, cards: allMastered })).toBe(false);
  });

  it("an empty card list with unlock=true -> POST_MASTERY (vacuously no acquisition work)", () => {
    expect(shouldUsePostMasteryMode({ hasAchievedFullMastery: true, cards: [] })).toBe(true);
  });
});

// =============================================================================
// TESTS -- POST-MASTERY SOURCE POLICY (Phase 7 brief section 27)
// =============================================================================

describe("computePostMasterySourceWeights (section 25.3, reusing classifyDueTier unchanged; six regimes, all explicit)", () => {
  it("1. pre-goal, Due 0 -> 0.80/0.00/0.20", () => {
    const result = computePostMasterySourceWeights(0, false);
    expect(result.weights).toEqual({ randomMastered: 0.8, due: 0.0, near: 0.2 });
    expect(result.mode).toBe("post_mastery_pre_goal_active_focus");
  });

  it("2. post-goal, Due 0 -> 0.80/0.00/0.20 (reviewed correction: identical to pre-goal, not a gap)", () => {
    const result = computePostMasterySourceWeights(0, true);
    expect(result.weights).toEqual({ randomMastered: 0.8, due: 0.0, near: 0.2 });
    expect(result.mode).toBe("post_mastery_post_goal_active_focus");
  });

  it("3. post-goal zero-Due must NOT throw", () => {
    expect(() => computePostMasterySourceWeights(0, true)).not.toThrow();
  });

  it("4. pre-goal, Due 1-9 -> 0.45/0.40/0.15", () => {
    const result = computePostMasterySourceWeights(5, false);
    expect(result.weights).toEqual({ randomMastered: 0.45, due: 0.4, near: 0.15 });
    expect(result.mode).toBe("post_mastery_pre_goal_balanced");
  });

  it("5. post-goal, Due 1-9 -> 0.55/0.25/0.20", () => {
    const result = computePostMasterySourceWeights(5, true);
    expect(result.weights).toEqual({ randomMastered: 0.55, due: 0.25, near: 0.2 });
    expect(result.mode).toBe("post_mastery_post_goal_balanced");
  });

  it("6. Due 10+ before/after goal -> 0.30/0.60/0.10 (identical both sides)", () => {
    const pre = computePostMasterySourceWeights(15, false);
    const post = computePostMasterySourceWeights(15, true);
    expect(pre.weights).toEqual({ randomMastered: 0.3, due: 0.6, near: 0.1 });
    expect(post.weights).toEqual({ randomMastered: 0.3, due: 0.6, near: 0.1 });
    expect(pre.mode).toBe("post_mastery_pre_goal_review_pressure");
    expect(post.mode).toBe("post_mastery_post_goal_review_pressure");
  });
});

describe("renormalizePostMasterySourceWeights (section 11 of the brief / spec section 21)", () => {
  const nominal = { randomMastered: 0.45, due: 0.4, near: 0.15 };

  it("26. empty RANDOM_MASTERED renormalizes away", () => {
    const result = renormalizePostMasterySourceWeights(nominal, { randomMastered: false, due: true, near: true });
    expect(result.randomMastered).toBe(0);
    expect(result.due + result.near).toBeCloseTo(1);
    expect(result.due / result.near).toBeCloseTo(nominal.due / nominal.near);
  });

  it("27. empty DUE renormalizes away", () => {
    const result = renormalizePostMasterySourceWeights(nominal, { randomMastered: true, due: false, near: true });
    expect(result.due).toBe(0);
    expect(result.randomMastered + result.near).toBeCloseTo(1);
  });

  it("28. empty NEAR renormalizes away", () => {
    const result = renormalizePostMasterySourceWeights(nominal, { randomMastered: true, due: true, near: false });
    expect(result.near).toBe(0);
    expect(result.randomMastered + result.due).toBeCloseTo(1);
  });

  it("29. one remaining source -> 1.0", () => {
    const result = renormalizePostMasterySourceWeights(nominal, { randomMastered: true, due: false, near: false });
    expect(result).toEqual({ randomMastered: 1, due: 0, near: 0 });
  });

  it("30. all sources empty -> all zero, never divides by zero / never throws", () => {
    const result = renormalizePostMasterySourceWeights(nominal, { randomMastered: false, due: false, near: false });
    expect(result).toEqual({ randomMastered: 0, due: 0, near: 0 });
  });
});

// =============================================================================
// TESTS -- RANDOM_MASTERED ELIGIBILITY (Phase 7 brief section 12)
// =============================================================================

describe("selectStrongMasteredCandidateIds (section 12 of the brief)", () => {
  it("a LEARNED, OUTSIDE, STRONG_OUTSIDE card with has_ever_been_mastered qualifies", () => {
    const card = makeMasteredCard("a");
    expect(selectStrongMasteredCandidateIds([card], FIXTURE_NOW)).toEqual(["a"]);
  });

  it("ACQUIRED-but-not-Mastered cards must NOT participate, even if otherwise STRONG_OUTSIDE", () => {
    const card = makeOutsideCard("acquired-only", { cardStatus: "ACQUIRED", hasEverBeenMastered: false }, { last_review: FIXTURE_NOW });
    expect(selectStrongMasteredCandidateIds([card], FIXTURE_NOW)).toEqual([]);
  });

  it("a Due Mastered card is excluded (not 'strong')", () => {
    const dueMastered = makeMasteredCard("due-mastered", {}); // default makeOutsideCard fsrs is 10-day schedule
    // Force it FSRS_DUE by evaluating far enough past FIXTURE_NOW.
    const farFuture = new Date(FIXTURE_NOW.getTime() + 20 * 24 * 60 * 60 * 1000);
    expect(selectStrongMasteredCandidateIds([dueMastered], farFuture)).toEqual([]);
  });

  it("a Near-Due Mastered card is excluded (not 'strong')", () => {
    const nearDueMastered = makeMasteredCard("near-due-mastered");
    const eightDaysLater = new Date(FIXTURE_NOW.getTime() + 8 * 24 * 60 * 60 * 1000); // ~0.8 progress against the default 10-day schedule
    expect(selectStrongMasteredCandidateIds([nearDueMastered], eightDaysLater)).toEqual([]);
  });

  it("a relearning-governed (FORGOTTEN) card is excluded even if somehow has_ever_been_mastered (defense-in-depth; not reachable under the engine's own invariants since FORGOTTEN != LEARNED)", () => {
    const card = makeMasteredCard("impossible-state", { cardStatus: "FORGOTTEN", relearningPhase: "REPAIR_PENDING" });
    expect(selectStrongMasteredCandidateIds([card], FIXTURE_NOW)).toEqual([]);
  });

  it("an ACTIVE-pool card is excluded (not OUTSIDE), even if cardStatus happens to be LEARNED", () => {
    const card = makeMasteredCard("active-pool", { poolStatus: "ACTIVE" });
    expect(selectStrongMasteredCandidateIds([card], FIXTURE_NOW)).toEqual([]);
  });

  it("multiple eligible cards are all returned", () => {
    const cards = [makeMasteredCard("a"), makeMasteredCard("b"), makeMasteredCard("c")];
    expect(selectStrongMasteredCandidateIds(cards, FIXTURE_NOW)).toEqual(["a", "b", "c"]);
  });
});

// =============================================================================
// TESTS -- SHUFFLE BAG (Phase 7 brief section 28)
// =============================================================================

describe("reconcileShuffleBag / drawFromShuffleBag (sections 13-15 of the brief)", () => {
  it("31. deterministic shuffle from seed: identical eligible set + identical seed -> identical first draw", () => {
    const run = () => drawFromShuffleBag(null, ["a", "b", "c", "d", "e"], createSeededRandom(7));
    expect(run()).toEqual(run());
  });

  it("32. without replacement until exhaustion: 5 eligible cards are drawn exactly once each across 5 draws", () => {
    const eligible = ["a", "b", "c", "d", "e"];
    let bag: readonly string[] | null = null;
    const drawn: string[] = [];
    const random = createSeededRandom(8);
    for (let i = 0; i < 5; i += 1) {
      const result = drawFromShuffleBag(bag, eligible, random);
      drawn.push(result.cardId!);
      bag = result.bagAfter;
    }
    expect(new Set(drawn)).toEqual(new Set(eligible));
    expect(bag).toBeNull(); // fully exhausted
  });

  it("33. broad coverage before reshuffle: a 6th draw (after exhaustion) rebuilds from the same eligible set and again covers all members before repeating", () => {
    const eligible = ["a", "b", "c", "d", "e"];
    let bag: readonly string[] | null = null;
    const random = createSeededRandom(9);
    const firstCycle: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = drawFromShuffleBag(bag, eligible, random);
      firstCycle.push(result.cardId!);
      bag = result.bagAfter;
    }
    const secondCycle: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = drawFromShuffleBag(bag, eligible, random);
      secondCycle.push(result.cardId!);
      bag = result.bagAfter;
    }
    expect(new Set(secondCycle)).toEqual(new Set(eligible)); // broad coverage again
  });

  it("34. no duplicate IDs in the remaining bag after reconciliation", () => {
    const reconciled = reconcileShuffleBag(["a", "a", "b", "c"], ["a", "b", "c"]);
    expect(reconciled).toEqual(["a", "b", "c"]);
  });

  it("35. exhausted bag (empty array) rebuilds from the current eligible set", () => {
    const result = drawFromShuffleBag([], ["a", "b"], createSeededRandom(10));
    expect(result.cardId).not.toBeNull();
    expect(["a", "b"]).toContain(result.cardId);
  });

  it("36. stale IDs (no longer eligible) are removed on reconciliation", () => {
    const reconciled = reconcileShuffleBag(["a", "b", "c"], ["a", "c"]); // "b" lapsed/became ineligible
    expect(reconciled).toEqual(["a", "c"]);
  });

  it("37. a lapsed Mastered card (no longer in eligible set) is removed from the bag, never drawn", () => {
    const result = drawFromShuffleBag(["a", "b", "c"], ["a", "c"], createSeededRandom(11));
    expect(result.cardId).not.toBe("b");
    for (let i = 0; i < 10; i += 1) {
      const r2 = drawFromShuffleBag(result.bagAfter, ["a", "c"], createSeededRandom(12 + i));
      expect(r2.cardId).not.toBe("b");
    }
  });

  it("38. a restored card (re-added to the eligible set after reappearing) may later re-enter the bag on the next rebuild", () => {
    // "b" was ineligible (lapsed), now restored -- not retroactively added to
    // the CURRENT bag (section 15's interpretation: a bag is a fixed shuffle
    // order; new eligibility joins only on the next rebuild), but freely
    // drawable once the bag next rebuilds.
    let bag: readonly string[] | null = reconcileShuffleBag(["a", "c"], ["a", "b", "c"]); // "b" restored, but bag itself unchanged by reconciliation (it wasn't IN the old bag)
    expect(bag).toEqual(["a", "c"]);
    // Exhaust the current bag...
    const random = createSeededRandom(13);
    let r = drawFromShuffleBag(bag, ["a", "b", "c"], random);
    bag = r.bagAfter;
    r = drawFromShuffleBag(bag, ["a", "b", "c"], random);
    bag = r.bagAfter;
    expect(bag).toBeNull();
    // ...the next draw rebuilds from the full current eligible set, including "b".
    const seenAfterRebuild = new Set<string>();
    let rebuildBag: readonly string[] | null = null;
    for (let i = 0; i < 3; i += 1) {
      const result = drawFromShuffleBag(rebuildBag, ["a", "b", "c"], random);
      seenAfterRebuild.add(result.cardId!);
      rebuildBag = result.bagAfter;
    }
    expect(seenAfterRebuild).toEqual(new Set(["a", "b", "c"]));
  });

  it("39. identical seed/state -> identical sequence across a full multi-draw run", () => {
    const run = () => {
      const eligible = ["a", "b", "c", "d"];
      let bag: readonly string[] | null = null;
      const random = createSeededRandom(21);
      const sequence: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        const result = drawFromShuffleBag(bag, eligible, random);
        sequence.push(result.cardId!);
        bag = result.bagAfter;
      }
      return sequence;
    };
    expect(run()).toEqual(run());
  });

  it("never returns an ineligible bag ID even when the eligible set shrinks mid-bag", () => {
    const random = createSeededRandom(22);
    const first = drawFromShuffleBag(null, ["a", "b", "c", "d", "e"], random);
    // "b" becomes ineligible between draws.
    const remainingEligible = ["a", "c", "d", "e"].filter((id) => id !== first.cardId);
    const second = drawFromShuffleBag(first.bagAfter, remainingEligible, random);
    expect(second.cardId).not.toBe("b");
    expect(remainingEligible).toContain(second.cardId);
  });
});

describe("chooseRandomMasteredCard (composition)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("composes eligibility + shuffle bag end-to-end", () => {
    const cards = [makeMasteredCard("a"), makeMasteredCard("b")];
    const result = chooseRandomMasteredCard(cards, FIXTURE_NOW, null, createSeededRandom(5));
    expect(result).not.toBeNull();
    expect(["a", "b"]).toContain(result!.cardId);
  });

  it("returns null when no strong-Mastered candidate exists", () => {
    expect(chooseRandomMasteredCard([], FIXTURE_NOW, null, createSeededRandom(5))).toBeNull();
  });

  it("never calls Math.random directly", () => {
    const spy = vi.spyOn(Math, "random");
    chooseRandomMasteredCard([makeMasteredCard("a"), makeMasteredCard("b")], FIXTURE_NOW, null, createSeededRandom(6));
    expect(spy).not.toHaveBeenCalled();
  });
});
