/**
 * Learning Engine v1 -- Active Pool admission/refill and first-encounter
 * ordering (Phase 3 of the implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 6
 * (pool model), 8 (Active Pool lifecycle), 9 (first encounters).
 *
 * Pure and deterministic throughout: no database access, no clock reads,
 * no mutation of input. Randomness (computeActiveAdmissions's NEW-admission
 * draw, and buildFirstPassOrder's first-pass presentation shuffle -- two
 * DELIBERATELY SEPARATE random decisions, see each function's own doc
 * comment) is injected, same discipline as lib/learning/battle.ts's
 * RandomSource and lib/learning-engine/transitions.ts's lack of any
 * Math.random() call.
 *
 * What this module does NOT do (explicitly out of Phase 3's scope):
 *   - decide eligibility/weight for an ordinary (non-first-pass) Active
 *     draw, or maintain active_draws_since_eligible -- see
 *     lib/learning-engine/active-priority.ts.
 *   - select a repair target, honor a repair hard cap, or do anything
 *     with FORGOTTEN/relearning cards beyond counting them toward the
 *     Active Pool's target size (they occupy an Active slot per section
 *     6.2's "concentrated within-day acquisition/relearning area", but
 *     their actual selection is Phase 4's repair scheduler).
 *   - run the full next-card selection pipeline (source weighting,
 *     Critical Due, starvation) -- Phase 6.
 */

import type { CardStatus, LearningStage, PoolStatus } from "@/lib/learning-engine/state";
import { ACTIVE_POOL_TARGET_SIZE, FRESH_CARD_LIMIT } from "@/lib/learning-engine/config";

/**
 * The minimal per-card projection Active Pool admission needs -- not the
 * full `ActivePoolCardState` (no FSRS/mastery/repair fields are relevant
 * to "is this card Active, and is it Fresh").
 */
export interface DeckActivePoolCard {
  readonly cardId: string;
  readonly cardStatus: CardStatus;
  readonly poolStatus: PoolStatus;
  readonly learningStage: LearningStage;
}

/**
 * Section 8.2: "FRESH means the card has not yet achieved its first
 * successful retrieval" -- broader than the learningStage === "FRESH"
 * enum value alone. A card that is Active and still literally NEW (never
 * presented, learningStage null) is also Fresh for pool-sizing purposes:
 * section 8.3's worked example counts all 6 newly-admitted NEW cards as
 * "Fresh 6" before any of them have been presented even once. A card
 * that has left NEW (learningStage LEARNING_1/LEARNING_2) or completed
 * acquisition (ACQUIRED/LEARNED) or lapsed (FORGOTTEN -- which has
 * necessarily succeeded before) is never Fresh, regardless of
 * poolStatus.
 */
export function isFresh(card: DeckActivePoolCard): boolean {
  if (card.poolStatus !== "ACTIVE") {
    return false;
  }
  if (card.cardStatus === "NEW") {
    return true;
  }
  return card.cardStatus === "LEARNING" && card.learningStage === "FRESH";
}

/** Matches lib/learning/battle.ts's RandomSource contract (Math.random() shape) without importing from the legacy lib/learning/ tree -- this engine stays fully decoupled from it (see lib/learning-engine/transitions.ts's own module header). */
export type RandomSource = () => number;

export interface ComputeActiveAdmissionsInput {
  /** Every card currently poolStatus === "ACTIVE" in this user's deck, any cardStatus (NEW-but-admitted, LEARNING, or FORGOTTEN-in-relearning per section 6.2 -- never ACQUIRED/LEARNED, which are OUTSIDE). */
  readonly activeCards: readonly DeckActivePoolCard[];
  /**
   * Every card currently in the NEW reservoir (poolStatus === null,
   * cardStatus === "NEW"), in whatever order the caller's query returns
   * them (e.g. by cards.sort_order then card_id -- see
   * get_learning_engine_v1_scheduler_snapshot()). That incoming order is
   * NO LONGER admission priority (Alpha pre-launch correction: see
   * selectNewAdmissionCandidates below) -- it is only the candidate set,
   * read in whatever order is convenient for the caller. This module
   * does not re-derive or rely on that ordering itself.
   */
  readonly newReservoir: readonly DeckActivePoolCard[];
  /** Injected RandomSource for the uniform-random-without-replacement admission draw (selectNewAdmissionCandidates) -- same discipline as buildFirstPassOrder's own `random` parameter below. */
  readonly random: RandomSource;
}

export interface ActiveAdmissionResult {
  /**
   * NEW cards' ids to admit to Active this pass -- a uniform-random
   * subset of `newReservoir`, WITHOUT replacement, never a prefix/
   * sort_order-first selection (Alpha pre-launch correction: deterministic
   * sort_order-first admission caused every tester to learn the same
   * CSV-ordered words first, clustering by content-authoring category;
   * see selectNewAdmissionCandidates below). The returned order is simply
   * selection order, not a presentation order -- buildFirstPassOrder
   * remains the SEPARATE, unchanged concern of what order admitted-but-
   * unpresented cards are first shown in.
   *
   * Admission only ever means setting pool_status = 'ACTIVE' -- it never
   * changes card_status. A newly admitted card stays card_status = 'NEW'
   * until its actual first presentation (section 3, invariant 34.1) --
   * lib/learning-engine/transitions.ts's applyFirstPresentation is the
   * only thing that ever flips that, and is not called by this module.
   */
  readonly admittedCardIds: readonly string[];
  readonly activeCountAfter: number;
  readonly freshCountAfter: number;
}

/**
 * The v1 Alpha NEW-admission selection policy: uniform random sampling
 * without replacement over `count` of `candidates`, via a partial
 * Fisher-Yates shuffle (identical algorithm to buildFirstPassOrder,
 * stopped after `count` swaps instead of running to completion -- the
 * standard, unbiased way to draw a uniform random sample without
 * replacement: each of the first `count` positions ends up holding a
 * uniformly-random distinct element of the original array). Every
 * candidate has equal selection probability -- "weight(card) = 1" for
 * v1. `candidates` is never mutated (a local copy is shuffled).
 *
 * Deliberately the ONLY thing this function decides: WHICH candidates
 * are chosen, nothing about presentation order (buildFirstPassOrder,
 * unchanged, separate concern) and nothing about HOW MANY slots exist
 * (the caller -- computeActiveAdmissions below -- computes `count` from
 * Active/Fresh capacity; this function trusts it completely and never
 * re-derives or clamps it beyond `candidates.length`).
 *
 * Future extension point: a later version may replace the implicit
 * `weight(card) = 1` here with a weighted draw (e.g.
 * `admissionWeight(card, learner, deckPolicy)`), by swapping this
 * function's body for a weighted-sampling-without-replacement
 * implementation while keeping the exact same `{ candidates, count,
 * random } -> readonly string[]` contract -- computeActiveAdmissions
 * and everything upstream of it would need no change. No such
 * weighting is implemented now; this is a documented seam, not new
 * surface area.
 */
export function selectNewAdmissionCandidates(input: {
  readonly candidates: readonly string[];
  readonly count: number;
  readonly random: RandomSource;
}): readonly string[] {
  const { candidates, count, random } = input;
  const take = Math.min(Math.max(count, 0), candidates.length);
  if (take === 0) {
    return [];
  }

  const pool = [...candidates];
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.floor(random() * (pool.length - i));
    const temp = pool[i];
    pool[i] = pool[j];
    pool[j] = temp;
  }
  return pool.slice(0, take);
}

/**
 * Section 8.3/8.4: the refill rule. No Pre-Active pool (section 6.1) --
 * a NEW card goes straight from the reservoir (poolStatus null) to
 * Active (poolStatus 'ACTIVE') in one step; there is no intermediate
 * state for this function, or anywhere else in this engine, to produce.
 *
 * ```text
 * while active_count < 20
 *   and fresh_count < 6
 *   and NEW reservoir is non-empty:
 *     admit next NEW card to ACTIVE
 * ```
 *
 * Calling this repeatedly as state changes (a card's first Correct frees
 * a Fresh slot, enabling one more admission; that admission's own
 * Freshness then re-saturates the Fresh limit until ITS first Correct)
 * is what produces section 8.3's "gradual Active growth toward 20" --
 * there is no separate growth function, growth is this admission rule
 * applied again each time Fresh/Active counts change.
 *
 * WHICH cards fill those slots is selectNewAdmissionCandidates's policy
 * (uniform random for v1 Alpha, see its own doc comment above) -- this
 * function only computes HOW MANY slots are available (`slots`, the same
 * three-way min the original sequential-admission loop enforced one
 * break-condition at a time: Active headroom, Fresh headroom, reservoir
 * size) and delegates the actual selection to it. Every admitted NEW
 * card is Fresh by construction (isFresh above), so admitting `n` cards
 * always consumes exactly `n` of BOTH the Active and Fresh headroom --
 * computing `slots` once up front is equivalent to the original loop's
 * per-iteration re-check.
 */
export function computeActiveAdmissions(input: ComputeActiveAdmissionsInput): ActiveAdmissionResult {
  const activeCount = input.activeCards.length;
  const freshCount = input.activeCards.filter(isFresh).length;

  const slots = Math.min(ACTIVE_POOL_TARGET_SIZE - activeCount, FRESH_CARD_LIMIT - freshCount, input.newReservoir.length);

  const admittedCardIds = selectNewAdmissionCandidates({
    candidates: input.newReservoir.map((candidate) => candidate.cardId),
    count: slots,
    random: input.random,
  });

  return {
    admittedCardIds,
    activeCountAfter: activeCount + admittedCardIds.length,
    freshCountAfter: freshCount + admittedCardIds.length,
  };
}

/**
 * Section 9: "the engine SHOULD use a randomized no-repeat first-pass
 * order" for several never-presented Active cards, e.g. six initial
 * cards A-F shown as "D, A, F, B, C, E", never a repeating order like
 * "A, A, B, A, C". A Fisher-Yates shuffle over the given ids, using the
 * injected RandomSource for determinism/testability (production: a seeded
 * generator per section 24's "seeded reproducibility" acceptance test;
 * tests: a fixed/deterministic stub). No-repeat is satisfied by
 * construction: every id in `cardIds` appears exactly once in the
 * returned order, consumed in that order by the caller.
 *
 * This is the presentation-order primitive only -- it does not select
 * which cards are in `cardIds` (that's computeActiveAdmissions, or
 * simply "every currently Active, never-presented NEW card" at any given
 * moment) and does not itself drive a session's draw loop (Phase 6).
 * "Repair hard caps and critical safety interrupts may still preempt the
 * first-pass ordering" (section 9) is likewise a later phase's concern,
 * layered on top of whatever order this function produces, not something
 * this function needs to know about.
 */
export function buildFirstPassOrder(cardIds: readonly string[], random: RandomSource): readonly string[] {
  const shuffled = [...cardIds];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const temp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = temp;
  }
  return shuffled;
}
