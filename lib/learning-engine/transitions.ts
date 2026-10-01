/**
 * Learning Engine v1 -- pure deterministic card-state transition
 * functions (Phase 2 of the implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 3
 * (backend card states), 10-13 (within-day acquisition/repair/
 * relearning), 15 (first-time Mastery), 16.3 (Near-Due/long-term Wrong),
 * 25.2 (Post-Mastery short restoration), 34 (invariants Claude must
 * enforce).
 *
 * Every function here is pure: no database access, no RNG, no clock
 * reads, no session/position bookkeeping, no mutation of its input --
 * same discipline as the existing lib/learning/fsrs.ts adapter and
 * lib/learning/rating.ts estimator. Each takes a `LearningEngineCardState`
 * and returns a brand new one. What these functions do NOT do, by design
 * (explicitly out of Phase 2's scope):
 *   - decide WHEN a repair/spaced-confirmation requirement is satisfied
 *     (i.e. whether "3-6 intervening cards" or "5 intervening cards" has
 *     actually elapsed) -- that is Phase 4's repair scheduler. These
 *     functions assume the caller has already confirmed the triggering
 *     event is eligible to apply (e.g. only calls applySpacedCorrect
 *     once the 5-card gap has genuinely elapsed).
 *   - compute or store session-position numbers
 *     (correct_cooldown_until_position, repair_target_position, etc.).
 *   - decide which FSRS source (FSRS_DUE vs NEAR_DUE) produced a given
 *     Correct/Wrong -- the caller decides which function to invoke
 *     (applyQualifyingFsrsCorrect only for a qualifying scheduled FSRS_DUE
 *     review; Near-Due Correct is deliberately NOT implemented in this
 *     phase, since the spec's only mastery-counter effect for it is "do
 *     nothing", which needs no dedicated transition function yet -- see
 *     the module-level phase-2 handoff report for this and the other
 *     modeling decisions below).
 *   - run FSRS itself, pick a repair window offset, or select a card.
 *
 * ---------------------------------------------------------------------
 * Mapping from the spec's own named Phase 2 function list (section 37) to
 * the functions below -- two deliberate consolidations and one addition,
 * each documented at its own function:
 *   - "acquisition graduation" is not a separate function: it is the
 *     terminal case (LEARNING_2 -> ACQUIRED) of the same stage-advance
 *     table "normal Correct" already is (section 11.2), so
 *     applyNormalCorrect implements both.
 *   - "short restoration" is not a separate function: section 25.2
 *     describes it as the SAME relearning-complete event as "spaced
 *     Correct" (section 13), with its outcome (ACQUIRED vs. LEARNED-
 *     restored) dispatched purely on hasEverBeenMastered -- the same
 *     condition a caller would need to already know to decide which
 *     function to call in the first place. applySpacedCorrect implements
 *     both branches internally instead of forcing a fake split.
 *   - applyRelearningRepairCorrect is an ADDITION beyond the named list's
 *     single "Repair Correct" entry: the spec body describes two
 *     materially different repair-correct mechanics -- the within-day
 *     Active-pool one (section 12.3/12.4, touches learning_stage) and the
 *     post-FORGOTTEN relearning one (section 13, touches
 *     relearning_phase, never leaves card_status = FORGOTTEN by itself).
 *     Collapsing them into one function would require it to silently
 *     guess which mechanic applies from ambient state; splitting them
 *     keeps each one's precondition/effect pair unambiguous and
 *     independently testable against its own spec section.
 */

import type { LearningEngineCardState } from "@/lib/learning-engine/state";
import {
  MASTERY_CORRECT_COUNT_REQUIRED,
  MASTERY_CORRECT_STREAK_REQUIRED,
} from "@/lib/learning-engine/config";

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`learning-engine transitions: ${message}`);
  }
}

// =============================================================================
// Within-day acquisition (sections 3 "NEW"/"LEARNING", 10, 11, 12)
// =============================================================================

/**
 * Section 3 "NEW" / invariant 34.1: "becomes LEARNING only when first
 * presented" -- entering the Active Pool while still NEW does NOT trigger
 * this transition; only an actual presentation does.
 *
 * NEW -> LEARNING, stage null -> FRESH.
 */
export function applyFirstPresentation(state: LearningEngineCardState): LearningEngineCardState {
  invariant(state.cardStatus === "NEW", `applyFirstPresentation requires cardStatus NEW, got ${state.cardStatus}`);

  return {
    ...state,
    cardStatus: "LEARNING",
    learningStage: "FRESH",
  };
}

/**
 * Section 10/11.2: a normal (non-repair) stage-advancing Correct. Also
 * implements "acquisition graduation" -- see the module header for why
 * that is not a separate function.
 *
 * FRESH -> LEARNING_1
 * LEARNING_1 -> LEARNING_2
 * LEARNING_2 -> ACQUIRED (learning_stage = null, pool_status = OUTSIDE)
 *
 * Requires repairPending === false: this function is specifically the
 * NON-repair path (section 12.3 defines a separate, different outcome
 * for a repair-origin Correct -- see applyRepairCorrect). A caller
 * sitting on a pending repair must call applyRepairCorrect instead; this
 * is a caller sequencing error, not a state this function should guess
 * its way through.
 */
export function applyNormalCorrect(state: LearningEngineCardState): LearningEngineCardState {
  invariant(state.cardStatus === "LEARNING", `applyNormalCorrect requires cardStatus LEARNING, got ${state.cardStatus}`);
  invariant(state.learningStage !== null, "applyNormalCorrect requires a non-null learningStage");
  invariant(!state.repairPending, "applyNormalCorrect requires repairPending === false (this is a repair-origin Correct; call applyRepairCorrect instead)");

  if (state.learningStage === "FRESH") {
    return { ...state, learningStage: "LEARNING_1" };
  }
  if (state.learningStage === "LEARNING_1") {
    return { ...state, learningStage: "LEARNING_2" };
  }

  // LEARNING_2 -> ACQUIRED ("acquisition graduation", section 11.2).
  return {
    ...state,
    cardStatus: "ACQUIRED",
    learningStage: null,
    poolStatus: "OUTSIDE",
  };
}

/**
 * Section 12.1-12.2: the immediate response to a within-day Wrong on an
 * Active-pool card. Creates a repair obligation; does not change
 * card_status or learning_stage (no stage regression -- the spec never
 * describes one).
 *
 * Requires repairPending === false: a second within-day Wrong on a card
 * that already owes a repair should never reach this function under
 * correct scheduler operation (the repair scheduler must not let the
 * card be redrawn before its reserved repair slot) -- surfaced as a
 * thrown invariant violation rather than silently coalesced.
 */
export function applyWrong(state: LearningEngineCardState): LearningEngineCardState {
  invariant(state.cardStatus === "LEARNING", `applyWrong requires cardStatus LEARNING, got ${state.cardStatus}`);
  invariant(state.learningStage !== null, "applyWrong requires a non-null learningStage");
  invariant(!state.repairPending, "applyWrong requires repairPending === false (a repair is already pending for this card)");

  return { ...state, repairPending: true };
}

/**
 * Section 12.3-12.4: the successful repair retrieval that resolves a
 * within-day Wrong.
 *
 * For LEARNING_1/LEARNING_2 (12.3): "remain at same learning stage" --
 * the repair demonstrates the immediate error was fixed, not that a
 * normally spaced new success was demonstrated. card_status stays
 * LEARNING either way; a repair never reaches ACQUIRED by itself.
 *
 * For FRESH (12.4, the Fresh exception): the first successful retrieval
 * is enough to leave Fresh even on a repair retry, so this advances to
 * LEARNING_1 -- the one case where a Repair Correct DOES change stage.
 */
export function applyRepairCorrect(state: LearningEngineCardState): LearningEngineCardState {
  invariant(state.cardStatus === "LEARNING", `applyRepairCorrect requires cardStatus LEARNING, got ${state.cardStatus}`);
  invariant(state.learningStage !== null, "applyRepairCorrect requires a non-null learningStage");
  invariant(state.repairPending, "applyRepairCorrect requires repairPending === true (no repair is pending for this card)");

  const learningStage = state.learningStage === "FRESH" ? "LEARNING_1" : state.learningStage;

  return { ...state, learningStage, repairPending: false };
}

// =============================================================================
// Relearning after a long-term failure (sections 13, 16.3, 25.2, 34.3)
// =============================================================================

/**
 * Section 16.3/34.3: a Wrong on a card currently under long-term FSRS
 * scheduling (pool_status OUTSIDE -- i.e. card_status ACQUIRED or
 * LEARNED). Covers both an ordinary FSRS_DUE Wrong and a Near-Due Wrong:
 * the spec describes identical mechanics for both (section 16.3's title
 * is "Near-Due Wrong", but a plain scheduled-due Wrong is never given a
 * separately-described rule, and section 13 opens relearning with the
 * same "card_status = FORGOTTEN" trigger) -- which source produced the
 * Wrong is for the caller/telemetry to record, not something this
 * transition's outcome depends on.
 *
 * card_status -> FORGOTTEN; fsrs_review_correct_streak resets to 0;
 * fsrs_review_correct_count is PRESERVED (cumulative evidence is never
 * erased by a lapse); relearning_phase -> REPAIR_PENDING, starting the
 * relearning repair path (section 13).
 *
 * pool_status -> ACTIVE: a documented modeling decision, not stated
 * verbatim in the spec as a field assignment. Section 6.2 defines ACTIVE
 * as "concentrated within-day acquisition/relearning area" (relearning
 * named explicitly), and section 13's relearning mechanics (a 3-6-card
 * repair window, then a 5-card spaced-confirmation gap) are the same
 * shape as the ordinary within-day Active-pool repair mechanics -- so a
 * FORGOTTEN card needs to be selectable from the same rotation the
 * repair scheduler (Phase 4) already serves, which is what pool_status =
 * ACTIVE signals to that scheduler. Flagged here for review rather than
 * silently assumed.
 */
export function applyLongTermWrong(state: LearningEngineCardState): LearningEngineCardState {
  invariant(
    state.cardStatus === "ACQUIRED" || state.cardStatus === "LEARNED",
    `applyLongTermWrong requires cardStatus ACQUIRED or LEARNED, got ${state.cardStatus}`,
  );
  invariant(state.poolStatus === "OUTSIDE", `applyLongTermWrong requires poolStatus OUTSIDE, got ${state.poolStatus}`);

  return {
    ...state,
    cardStatus: "FORGOTTEN",
    poolStatus: "ACTIVE",
    relearningPhase: "REPAIR_PENDING",
    fsrsReviewCorrectStreak: 0,
    // fsrsReviewCorrectCount is deliberately NOT touched -- preserved verbatim (section 34.3).
  };
}

/**
 * Section 13: the first successful retrieval after a long-term failure
 * ("Wrong -> corrective feedback -> Repair Correct within 3-6 cards").
 * This resolves the REPAIR_PENDING phase but does NOT complete
 * relearning by itself -- it only advances to awaiting the mandatory
 * 5-intervening-card spaced confirmation (SPACED_CONFIRMATION_PENDING).
 * card_status remains FORGOTTEN until applySpacedCorrect completes the
 * episode.
 *
 * Distinct from applyRepairCorrect (the within-day Active-pool repair,
 * which touches learning_stage and can never apply to a FORGOTTEN card)
 * -- see the module header for why these are two separate functions.
 */
export function applyRelearningRepairCorrect(state: LearningEngineCardState): LearningEngineCardState {
  invariant(state.cardStatus === "FORGOTTEN", `applyRelearningRepairCorrect requires cardStatus FORGOTTEN, got ${state.cardStatus}`);
  invariant(
    state.relearningPhase === "REPAIR_PENDING",
    `applyRelearningRepairCorrect requires relearningPhase REPAIR_PENDING, got ${state.relearningPhase}`,
  );

  return { ...state, relearningPhase: "SPACED_CONFIRMATION_PENDING" };
}

/**
 * Section 13 (final step) + section 25.2 (dispatch by prior-mastery
 * history) -- also implements "short restoration" from the spec's own
 * Phase 2 function list; see the module header for why these are one
 * function, not two. Requires that the mandatory 5-intervening-card gap
 * since the Repair Correct has already elapsed -- confirming that is
 * Phase 4's job, not this function's; it only applies the state
 * consequence once the event is known to have occurred.
 *
 * Never-before-mastered card (hasEverBeenMastered === false): relearning
 * complete -> ACQUIRED. It must re-satisfy first-time long-term Mastery
 * from here (applyQualifyingFsrsCorrect), exactly as if freshly acquired.
 *
 * Previously-mastered card (hasEverBeenMastered === true): relearning
 * complete -> LEARNED, "MASTERED RESTORED" -- the short-restoration path,
 * available precisely because mastery was historically demonstrated once
 * already and that history (hasEverBeenMastered) is never erased by a
 * lapse.
 *
 * Neither branch touches fsrs_review_correct_count/streak: section 15
 * excludes repair Corrects from mastery-counter evidence, and the
 * relearning-completion event is exactly that -- not a qualifying
 * scheduled FSRS review.
 */
export function applySpacedCorrect(state: LearningEngineCardState): LearningEngineCardState {
  invariant(state.cardStatus === "FORGOTTEN", `applySpacedCorrect requires cardStatus FORGOTTEN, got ${state.cardStatus}`);
  invariant(
    state.relearningPhase === "SPACED_CONFIRMATION_PENDING",
    `applySpacedCorrect requires relearningPhase SPACED_CONFIRMATION_PENDING, got ${state.relearningPhase}`,
  );

  return {
    ...state,
    cardStatus: state.hasEverBeenMastered ? "LEARNED" : "ACQUIRED",
    relearningPhase: null,
    poolStatus: "OUTSIDE",
  };
}

// =============================================================================
// Long-term Mastery evidence (section 15)
// =============================================================================

/**
 * Section 15.1-15.2: a Correct answer on a qualifying, scheduled FSRS
 * long-term review (FSRS_DUE source only -- never a same-day Active
 * Correct, a within-day or relearning repair Correct, a Near-Due Correct,
 * or a Random Mastered free-play Correct; the caller is responsible for
 * only invoking this function for a genuinely qualifying review).
 *
 * Increments both the cumulative count and the recency streak
 * unconditionally. Once both meet their thresholds
 * (MASTERY_CORRECT_COUNT_REQUIRED=3, MASTERY_CORRECT_STREAK_REQUIRED=2)
 * AND the card is not already LEARNED, this is the one transition that
 * sets card_status = LEARNED and has_ever_been_mastered = true for the
 * first time (invariant 34.1: LEARNED implies has_ever_been_mastered).
 * An already-LEARNED card's counters still keep incrementing on further
 * qualifying reviews -- the spec never caps them, they are cumulative
 * evidence (section 15.2: "The count represents cumulative long-term
 * evidence").
 */
export function applyQualifyingFsrsCorrect(state: LearningEngineCardState): LearningEngineCardState {
  invariant(
    state.cardStatus === "ACQUIRED" || state.cardStatus === "LEARNED",
    `applyQualifyingFsrsCorrect requires cardStatus ACQUIRED or LEARNED, got ${state.cardStatus}`,
  );
  invariant(state.poolStatus === "OUTSIDE", `applyQualifyingFsrsCorrect requires poolStatus OUTSIDE, got ${state.poolStatus}`);

  const fsrsReviewCorrectCount = state.fsrsReviewCorrectCount + 1;
  const fsrsReviewCorrectStreak = state.fsrsReviewCorrectStreak + 1;

  const reachesFirstTimeMastery =
    state.cardStatus === "ACQUIRED" &&
    fsrsReviewCorrectCount >= MASTERY_CORRECT_COUNT_REQUIRED &&
    fsrsReviewCorrectStreak >= MASTERY_CORRECT_STREAK_REQUIRED;

  return {
    ...state,
    cardStatus: reachesFirstTimeMastery ? "LEARNED" : state.cardStatus,
    hasEverBeenMastered: state.hasEverBeenMastered || reachesFirstTimeMastery,
    fsrsReviewCorrectCount,
    fsrsReviewCorrectStreak,
  };
}
