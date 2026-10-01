/**
 * Learning Engine v1 -- repair scheduler (Phase 4 of the implementation
 * plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections
 * 12 (Wrong/repair logic), 13 (relearning), 22.1 (repair hard cap), 23/24
 * (interrupt priority: repair hard cap precedes Critical Due precedes
 * Active starvation precedes the normal scheduler), 34.2 (scheduling
 * invariants), 35.2 (multiple repair collisions).
 *
 * Pure and deterministic throughout: no database access, no clock reads,
 * no hidden `Math.random()` call -- the only randomness (gap sampling,
 * tie-break) is injected via `RandomSource` (re-exported from
 * lib/learning-engine/active-pool.ts, the same contract, not redefined a
 * third time).
 *
 * What this module does NOT do (explicitly out of Phase 4's scope):
 *   - Critical Due selection (section 22.2) -- Gate 2 of the interrupt
 *     pipeline, a separate later phase.
 *   - the Active starvation guarantee itself (section 22.3) -- Gate 3;
 *     this module only avoids corrupting active_draws_since_eligible
 *     while a repair governs a card (section 9's ask), it does not
 *     implement the 40-draw guarantee.
 *   - Dynamic Source Weighting, Near-Due, FSRS wiring, or the full
 *     next-card selection pipeline (Phase 5/6).
 *   - deciding *when* a repair's sampled target should additionally
 *     present it ahead of ordinary Active selection -- only the
 *     MANDATORY hard-cap interrupt (Gate 1) is implemented here, per the
 *     explicit Phase 4 brief ("Phase 4 should implement the Repair side
 *     of [the interrupt] boundary only").
 *
 * ---------------------------------------------------------------------
 * Flagged ambiguity: target/hard-cap POSITION collision-shifting
 * ---------------------------------------------------------------------
 * The spec (section 12.2) says, in the same breath as describing the
 * uniform {3,4,5,6} sample: "if multiple repair targets collide, resolve
 * by oldest Wrong first with random tie-break... a target may be moved
 * earlier only by explicit safety logic; never move it later than the
 * 6-card hard cap." Read one way, this describes pure SELECTION-time
 * priority among several simultaneously-due repair obligations (which
 * one gets presented on a given draw) -- that is what
 * selectRepairCandidate/findMandatoryRepairInterrupt below implement, and
 * it is unambiguous. Read another way, it could also mean STORAGE-time
 * repositioning: if two repairs' sampled target positions land on the
 * identical absolute position number, bump one of them forward (mirroring
 * the legacy engine's collision-shift loop in
 * supabase/migrations/20260927000000_learning_wrong_reappearance_floor.sql).
 *
 * This module deliberately implements only the first (selection-time
 * priority) interpretation. It does NOT shift a stored targetPosition/
 * hardCapPosition to avoid two repairs numerically sharing a position:
 * doing so would invent a new cognitive rule the spec does not
 * unambiguously specify (how far to shift, whether a shift can itself
 * collide with a THIRD repair's hard cap, etc.), which section 41 of the
 * spec explicitly instructs against ("stop that portion of implementation
 * and flag the ambiguity instead of inventing a new cognitive rule").
 * Safety is preserved without it: selectRepairCandidate deterministically
 * picks exactly one winner per draw among however many repairs are
 * simultaneously due, and a non-winning repair's own targetPosition/
 * hardCapPosition are untouched (computed independently from its own
 * wrongPosition), so it is simply reconsidered -- never discarded -- on
 * the next draw. Flagged here for explicit review before Phase 6 builds
 * on this module.
 */

import {
  REPAIR_GAP_OPTIONS,
  WRONG_RETRY_HARD_CAP,
} from "@/lib/learning-engine/config";
import { applyCorrectCooldown, isEligibleForNormalSelection } from "@/lib/learning-engine/active-priority";
import { applyRelearningRepairCorrect, applyRepairCorrect } from "@/lib/learning-engine/transitions";
import type { RandomSource } from "@/lib/learning-engine/active-pool";
import type { LearningEngineCardState } from "@/lib/learning-engine/state";

export type { RandomSource };

// =============================================================================
// Section 12.1-12.2/29.1: the repair obligation
// =============================================================================

/**
 * One pending repair obligation -- the pure-TS mirror of
 * user_card_progress's repair_pending/repair_wrong_position/
 * repair_target_position/repair_hard_cap_position columns
 * (supabase/migrations/20261001000000_learning_engine_v1_additive_schema.sql).
 * The existence of this object IS "repair_pending = true"; there is no
 * separate boolean field here -- a future DAL maps "object present" to
 * that column, and its absence to repair_pending = false (and every
 * position field NULL).
 */
export interface RepairObligation {
  readonly cardId: string;
  /** The position the Wrong occurred at -- also the priority key (oldest Wrong first, section 35.2). */
  readonly wrongPosition: number;
  /** Earliest position this repair may be presented at (never before 3 full intervening cards). */
  readonly targetPosition: number;
  /** Position at which this repair becomes a MANDATORY interrupt (never after 6 full intervening cards). Authoritative -- see this module's header. */
  readonly hardCapPosition: number;
}

/**
 * Section 12.2: "sample a target repair offset uniformly from {3,4,5,6}."
 * Defensive clamp on the index: `random()`'s contract is [0, 1), so
 * `index` should never reach REPAIR_GAP_OPTIONS.length, but a clamp costs
 * nothing and avoids an out-of-bounds read if a test/future RNG ever
 * returns exactly 1.
 */
export function sampleRepairGap(random: RandomSource): (typeof REPAIR_GAP_OPTIONS)[number] {
  const index = Math.min(
    Math.floor(random() * REPAIR_GAP_OPTIONS.length),
    REPAIR_GAP_OPTIONS.length - 1,
  );
  return REPAIR_GAP_OPTIONS[index];
}

export interface CreateRepairObligationInput {
  readonly cardId: string;
  readonly wrongPosition: number;
  readonly random: RandomSource;
}

/**
 * Section 12.1-12.2: the immediate scheduling response to a Wrong.
 *
 * ---------------------------------------------------------------------
 * Position semantics (be extremely explicit, per review)
 * ---------------------------------------------------------------------
 * The spec's "3 intervening cards" / "6 intervening cards" describe a
 * COUNT of cards shown between the Wrong and the repair, not a raw
 * position delta. If Wrong occurs at position N:
 *   - 3 intervening cards are N+1, N+2, N+3 -> earliest repair
 *     presentation is N+4.
 *   - 6 intervening cards are N+1..N+6 -> latest legal repair
 *     presentation is N+7.
 * So for a sampled `repairGap` (one of 3/4/5/6):
 *   targetPosition   = wrongPosition + repairGap + 1
 *   hardCapPosition  = wrongPosition + WRONG_RETRY_HARD_CAP + 1
 * (Same `+1` correction as applyCorrectCooldown in active-priority.ts, and
 * for the identical reason -- see that function's doc comment for the
 * off-by-one this mirrors and avoids repeating.)
 *
 * hardCapPosition does NOT depend on the sampled gap -- it is always
 * wrongPosition + the fixed WRONG_RETRY_HARD_CAP (6), even when the
 * sampled gap happens to equal 6 itself. They are computed independently
 * because they answer different questions ("when may this repair first
 * appear" vs. "when MUST this repair appear by"), per section 3 of the
 * Phase 4 brief.
 */
export function createRepairObligation(input: CreateRepairObligationInput): RepairObligation {
  const repairGap = sampleRepairGap(input.random);
  return {
    cardId: input.cardId,
    wrongPosition: input.wrongPosition,
    targetPosition: input.wrongPosition + repairGap + 1,
    hardCapPosition: input.wrongPosition + WRONG_RETRY_HARD_CAP + 1,
  };
}

// =============================================================================
// Section 3 (Phase 4 brief)/22.1/35.2: target/hard-cap eligibility and
// collision priority
// =============================================================================

/** Section 12.2: true once the sampled target position has been reached -- the earliest this repair may be presented. Never true before wrongPosition + 4 (gap >= 3). */
export function isRepairTargetReached(repair: RepairObligation, currentPosition: number): boolean {
  return currentPosition >= repair.targetPosition;
}

/** Section 22.1: true once the repair's hard cap has been reached -- it MUST be presented now (Gate 1, before Critical Due). Never true before wrongPosition + 7 (fixed 6-card cap). */
export function isRepairHardCapReached(repair: RepairObligation, currentPosition: number): boolean {
  return currentPosition >= repair.hardCapPosition;
}

/**
 * Section 35.2/22.1: "oldest Wrong / earliest hard cap first" -- the two
 * phrasings name the same ordering here, since hardCapPosition is always
 * wrongPosition + a fixed constant (monotonic in wrongPosition), so
 * sorting by one sorts identically by the other. "Random tie-break for
 * equal priority" (genuinely equal wrongPosition, which can only arise
 * from synthetic/test data -- two different cards cannot both be
 * Wronged at the same real draw position in a single continuous stream).
 *
 * General-purpose: usable for priority among ANY set of repair
 * obligations a caller has already filtered to its tier of interest
 * (e.g. only hard-cap-reached ones -- see findMandatoryRepairInterrupt --
 * or, in a future phase, only target-reached ones). Never silently
 * drops a non-winning candidate: it simply isn't the one returned, and
 * remains in the caller's own obligation set for the next draw.
 *
 * Returns null only for an empty input.
 */
export function selectRepairCandidate(
  repairs: readonly RepairObligation[],
  random: RandomSource,
): RepairObligation | null {
  if (repairs.length === 0) {
    return null;
  }

  const oldestWrongPosition = Math.min(...repairs.map((r) => r.wrongPosition));
  const oldest = repairs.filter((r) => r.wrongPosition === oldestWrongPosition);

  if (oldest.length === 1) {
    return oldest[0];
  }

  const index = Math.min(Math.floor(random() * oldest.length), oldest.length - 1);
  return oldest[index];
}

/**
 * Section 4 (Phase 4 brief)/23/24: the Repair side of the interrupt
 * boundary -- Gate 1 of the future pipeline ("1. Repair hard cap, 2.
 * Critical Due, 3. Active starvation, 4. Normal scheduler"). Phase 6 is
 * expected to call this before evaluating Critical Due or anything else:
 * if it returns non-null, that repair MUST be presented this draw,
 * unconditionally.
 *
 * Only considers repairs whose hard cap has been reached -- a repair
 * whose target is merely reached (but not yet its hard cap) is not a
 * mandatory interrupt and must not win here (see
 * isRepairTargetReached/isRepairHardCapReached and this module's header
 * for why only the hard-cap tier is implemented as an interrupt in this
 * phase).
 */
export function findMandatoryRepairInterrupt(
  repairs: readonly RepairObligation[],
  currentPosition: number,
  random: RandomSource,
): RepairObligation | null {
  const dueForHardCap = repairs.filter((r) => isRepairHardCapReached(r, currentPosition));
  return selectRepairCandidate(dueForHardCap, random);
}

// =============================================================================
// Section 8 (Phase 4 brief): cleanup after a successful Repair Correct
// =============================================================================

/**
 * The cleared shape of the four repair scheduling columns
 * (repair_pending/repair_wrong_position/repair_target_position/
 * repair_hard_cap_position) after a Repair Correct resolves the
 * obligation that triggered it -- named fields, not reused from
 * RepairObligation's shape, so a future DAL writing this patch cannot
 * mistake it for a still-pending obligation. Deliberately does NOT touch
 * relearning_phase or correct_cooldown_until_position: those are a
 * SEPARATE concept (memory state / the next cooldown-or-spaced-
 * confirmation gate) -- see resolveOrdinaryRepairCorrect/
 * resolveRelearningRepairCorrect below for how all three pieces compose
 * without conflating them.
 */
export interface ClearedRepairFields {
  readonly repairPending: false;
  readonly repairWrongPosition: null;
  readonly repairTargetPosition: null;
  readonly repairHardCapPosition: null;
}

export function clearRepairObligationFields(): ClearedRepairFields {
  return {
    repairPending: false,
    repairWrongPosition: null,
    repairTargetPosition: null,
    repairHardCapPosition: null,
  };
}

/**
 * The full result of resolving one successful Repair Correct: three
 * conceptually separate pieces, kept as separate named fields rather than
 * flattened into one object (section 8's "keep scheduler state and
 * memory state conceptually separate"):
 *   - cardState: the memory-state transition (Phase 2 -- unchanged logic,
 *     not duplicated here);
 *   - clearedRepairFields: the resolved obligation's scheduling cleanup
 *     (section 8);
 *   - nextCorrectCooldownUntilPosition: the new 5-intervening-card gate
 *     this Correct starts (section 5's "begin the normal 5-intervening-
 *     card Correct cooldown" for the ordinary case, and section 7's
 *     spaced-confirmation gate for the relearning case -- the SAME
 *     Phase 3 primitive, applyCorrectCooldown, reused rather than
 *     reimplemented, since both are literally the same "5 full
 *     intervening cards" rule, section 7's correct_min_gap).
 */
export interface RepairCorrectResolution {
  readonly cardState: LearningEngineCardState;
  readonly clearedRepairFields: ClearedRepairFields;
  readonly nextCorrectCooldownUntilPosition: number;
}

/**
 * Section 5/6: ordinary within-day Repair Correct (FRESH/LEARNING_1/
 * LEARNING_2). Delegates the stage/status transition entirely to Phase
 * 2's applyRepairCorrect -- unchanged: LEARNING_1/LEARNING_2 remain at
 * the same stage (a Repair Correct is never a normal stage-advancing
 * success), FRESH advances to LEARNING_1 (the Fresh exception, section
 * 12.4). Either way, a normal 5-intervening-card Correct cooldown begins
 * immediately, exactly as an ordinary stage-advancing Correct would
 * (section 5: "begin the normal 5-intervening-card Correct cooldown").
 */
export function resolveOrdinaryRepairCorrect(
  cardState: LearningEngineCardState,
  currentPosition: number,
): RepairCorrectResolution {
  return {
    cardState: applyRepairCorrect(cardState),
    clearedRepairFields: clearRepairObligationFields(),
    nextCorrectCooldownUntilPosition: applyCorrectCooldown(currentPosition),
  };
}

/**
 * Section 7/13: the first successful retrieval after a long-term/Near-Due
 * Wrong. Delegates to Phase 2's applyRelearningRepairCorrect (FORGOTTEN
 * stays FORGOTTEN; relearning_phase -> SPACED_CONFIRMATION_PENDING -- the
 * first Repair Correct alone does NOT complete relearning). The repair
 * obligation that triggered this is cleared (section 8) exactly as the
 * ordinary case is, and the SAME 5-intervening-card gate
 * (applyCorrectCooldown) is started for the mandatory spaced
 * confirmation (section 13: "at least 5 intervening cards -> Spaced
 * Correct") -- reusing Phase 3's cooldown primitive rather than inventing
 * a parallel one, since it is the identical rule (section 7's
 * correct_min_gap = 5 in both cases). A later Spaced Correct
 * (lib/learning-engine/transitions.ts's applySpacedCorrect) must only be
 * applied once isEligibleForNormalSelection reports this gate satisfied.
 */
export function resolveRelearningRepairCorrect(
  cardState: LearningEngineCardState,
  currentPosition: number,
): RepairCorrectResolution {
  return {
    cardState: applyRelearningRepairCorrect(cardState),
    clearedRepairFields: clearRepairObligationFields(),
    nextCorrectCooldownUntilPosition: applyCorrectCooldown(currentPosition),
  };
}

/** Re-exported so callers checking the post-repair spaced-confirmation gate don't need a second import of active-priority.ts just for this one function. */
export { isEligibleForNormalSelection };

// =============================================================================
// Lifecycle-gap fix (review, section 7): the positive "due" signal that
// closes the loop resolveRelearningRepairCorrect opens.
// =============================================================================

export interface SpacedConfirmationCardState {
  readonly relearningPhase: LearningEngineCardState["relearningPhase"];
  readonly correctCooldownUntilPosition: number | null;
}

/**
 * The missing piece identified in review: resolveRelearningRepairCorrect
 * puts a card into relearningPhase = SPACED_CONFIRMATION_PENDING and
 * returns a nextCorrectCooldownUntilPosition gate, but nothing previously
 * turned "that gate has been reached" into a positive, checkable signal
 * -- isGovernedByRepairObligation (below) stays true for this card
 * regardless of whether the gate has opened, because it answers a
 * DIFFERENT question ("is this card excluded from ORDINARY stage-weighted
 * selection", which remains yes for the entire relearning episode, since
 * a FORGOTTEN card has no learningStage and was never a
 * computeActiveWeight candidate in the first place). Without this
 * function, nothing ever told a caller "this SPACED_CONFIRMATION_PENDING
 * card is now actually due" -- exactly the permanent-exclusion risk
 * flagged in review.
 *
 * True only once BOTH hold: the card is actually awaiting spaced
 * confirmation (relearningPhase === SPACED_CONFIRMATION_PENDING -- a
 * REPAIR_PENDING card is never "due" via this function, only via the
 * repair-target/hard-cap functions above), AND the stored cooldown gate
 * has been reached (reusing active-priority.ts's
 * isEligibleForNormalSelection -- the identical 5-intervening-card
 * comparison, not reimplemented).
 *
 * This is the direct analogue of isRepairTargetReached for the
 * relearning side of the repair/relearning lifecycle: a boolean
 * eligibility signal, not a forced interrupt -- section 13 states only a
 * MINIMUM gap ("at least 5 intervening cards"), never an upper bound, so
 * unlike the repair hard cap there is no "mandatory interrupt" tier to
 * build for this case. Once true, the future Phase 6 scheduler is
 * expected to treat this card as an eligible candidate for presentation
 * (ordinary priority among such candidates, if more than one, is Phase
 * 6's concern -- ordering several simultaneously-due spaced
 * confirmations is not specified by the spec the way repair collisions
 * explicitly are in section 35.2, so this phase does not invent one).
 *
 * See isGovernedByRepairObligation's doc comment for exactly how this
 * function and that one compose without contradicting each other, and
 * tests/unit/learning-engine-repair-scheduler.test.ts's "lifecycle gap"
 * describe block for the full before/after-the-gate proof.
 */
export function isSpacedConfirmationDue(card: SpacedConfirmationCardState, currentPosition: number): boolean {
  return card.relearningPhase === "SPACED_CONFIRMATION_PENDING" && isEligibleForNormalSelection(card, currentPosition);
}

// =============================================================================
// Section 9 (Phase 4 brief): exclusion from ordinary Active selection
// while a repair governs a card
// =============================================================================

export interface RepairGovernanceCardState {
  readonly repairPending: boolean;
  readonly relearningPhase: LearningEngineCardState["relearningPhase"];
}

/**
 * Section 9: "normal Active starvation aging should not incorrectly
 * accumulate while a card is ineligible for ordinary selection because it
 * is governed by a repair obligation." True for the ENTIRE lifetime of a
 * repair/relearning episode -- from the triggering Wrong until the
 * obligation resolves (not merely "while waiting for the target
 * position"): a card is governed by the within-day repair mechanism
 * whenever repairPending is true, and by the relearning mechanism
 * whenever relearningPhase is non-null (REPAIR_PENDING or
 * SPACED_CONFIRMATION_PENDING) -- in both cases it is never a candidate
 * for ordinary stage-weighted Active selection
 * (lib/learning-engine/active-priority.ts's computeActiveWeight), so it
 * must not be treated as "eligible" when calling that module's
 * advanceActiveDrawCounters either (this module does not call that
 * function itself -- composing the two is a future scheduler's job; see
 * tests/unit/learning-engine-repair-scheduler.test.ts for a worked
 * example of the composition this predicate is meant to feed).
 *
 * Does NOT rewrite or wrap advanceActiveDrawCounters/computeActiveWeight
 * themselves (section 9: "do not rewrite Phase 3 Active weights") -- this
 * is purely the extra predicate Phase 3 had no reason to know about yet.
 *
 * Importantly, "governed" here means "excluded from the ORDINARY
 * stage-weighted channel" -- it is not, by itself, "permanently
 * unselectable". A card can be isGovernedByRepairObligation === true and
 * simultaneously a positive candidate via one of the OTHER channels this
 * module exposes: isRepairTargetReached/findMandatoryRepairInterrupt
 * (REPAIR_PENDING) or isSpacedConfirmationDue
 * (SPACED_CONFIRMATION_PENDING, once its 5-intervening-card gate has been
 * reached). A caller must check those channels independently -- this
 * function intentionally does not stop returning true just because one of
 * them has opened, since the card still is not an ordinary-channel
 * candidate at that point either way. See isSpacedConfirmationDue's own
 * doc comment and this file's "lifecycle gap" tests for the worked
 * before/after proof that a SPACED_CONFIRMATION_PENDING card does not
 * stay permanently excluded overall, even though this one predicate alone
 * never flips back to false until relearning actually completes
 * (lib/learning-engine/transitions.ts's applySpacedCorrect).
 */
export function isGovernedByRepairObligation(card: RepairGovernanceCardState): boolean {
  return card.repairPending || card.relearningPhase !== null;
}
