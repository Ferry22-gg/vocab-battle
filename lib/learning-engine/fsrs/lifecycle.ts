/**
 * Learning Engine v1 -- FSRS lifecycle integration and mastery-counter
 * orchestration (Phase 5 of the implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 15
 * (first-time Mastery), 16.2-16.3 (Near-Due Correct/Wrong), 34.3 (mastery
 * invariants).
 *
 * This module composes, but never duplicates:
 *   - lib/learning-engine/fsrs/rating.ts's binary grade mapping;
 *   - lib/learning-engine/fsrs/adapter.ts's retention-aware FSRS advance;
 *   - lib/learning-engine/transitions.ts's Phase 2 pure state transitions
 *     (applyQualifyingFsrsCorrect, applyLongTermWrong) -- the mastery-
 *     counter math and card_status/pool_status/relearning_phase
 *     transitions live there, unchanged, and are not reimplemented here.
 *
 * Every result keeps the FSRS numeric update (D/S/due/etc.) and the
 * lifecycle state transition as separate named fields, not merged into
 * one object -- the same "keep scheduler/FSRS state and memory state
 * conceptually separate" discipline Phase 4's RepairCorrectResolution
 * established (lib/learning-engine/repair-scheduler.ts).
 *
 * Does not call lib/learning-engine/repair-scheduler.ts's
 * createRepairObligation itself: that needs a session position and an
 * injected RNG, neither of which is an FSRS concern (section 5: "Keep
 * FSRS math separate from Learning Engine lifecycle decisions"). A caller
 * resolving a long-term Wrong is expected to call createRepairObligation
 * separately with its own position/RNG context -- see
 * tests/unit/learning-engine-fsrs-lifecycle.test.ts for a worked
 * composition proving the two compose correctly.
 */

import type { Card, Grade } from "ts-fsrs";

import { advanceFsrsWithRetention, type UserCardProgressFsrsUpdate } from "@/lib/learning-engine/fsrs/adapter";
import { mapAnswerToFsrsGrade } from "@/lib/learning-engine/fsrs/rating";
import { applyLongTermWrong, applyQualifyingFsrsCorrect } from "@/lib/learning-engine/transitions";
import type { LearningEngineCardState } from "@/lib/learning-engine/state";

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`fsrs lifecycle: ${message}`);
  }
}

function requireOutsidePool(cardState: LearningEngineCardState, fnName: string): void {
  invariant(
    cardState.cardStatus === "ACQUIRED" || cardState.cardStatus === "LEARNED",
    `${fnName} requires cardStatus ACQUIRED or LEARNED, got ${cardState.cardStatus}`,
  );
  invariant(cardState.poolStatus === "OUTSIDE", `${fnName} requires poolStatus OUTSIDE, got ${cardState.poolStatus}`);
}

export interface ResolveFsrsAnswerInput {
  readonly card: Card;
  readonly cardState: LearningEngineCardState;
  readonly now: Date;
  readonly desiredRetention: number;
}

/**
 * The combined result of resolving one FSRS-scheduled answer: the FSRS
 * numeric update, the resulting lifecycle state, and the grade actually
 * sent to FSRS (exposed for telemetry/logging call sites, not consumed
 * internally by this module).
 */
export interface FsrsAnswerResolution {
  readonly fsrsUpdate: UserCardProgressFsrsUpdate;
  readonly cardState: LearningEngineCardState;
  readonly grade: Grade;
}

/**
 * Section 15.1-15.2/34.3: a Correct answer on a qualifying, scheduled
 * FSRS_DUE review. Only the caller may decide a review is "qualifying"
 * (i.e. drawn from the FSRS_DUE source, not Active/repair/Near-Due/
 * Random-Mastered -- a Phase 6 scheduler concern this module has no
 * visibility into); once it has, this is the single entry point: Good is
 * sent to FSRS, and lib/learning-engine/transitions.ts's
 * applyQualifyingFsrsCorrect (unchanged) increments the mastery counters
 * and promotes to LEARNED exactly once the thresholds are met.
 */
export function resolveQualifyingFsrsCorrect(input: ResolveFsrsAnswerInput): FsrsAnswerResolution {
  requireOutsidePool(input.cardState, "resolveQualifyingFsrsCorrect");

  const grade = mapAnswerToFsrsGrade(true);
  const fsrsUpdate = advanceFsrsWithRetention(input.card, input.now, grade, input.desiredRetention);
  const cardState = applyQualifyingFsrsCorrect(input.cardState);

  return { fsrsUpdate, cardState, grade };
}

/**
 * Sections 16.3/34.3 (Near-Due Wrong) and, equivalently, "qualifying
 * scheduled FSRS Wrong" (Phase 5 brief section 10): the spec describes
 * identical mechanics for both -- card_status -> FORGOTTEN, pool_status
 * -> ACTIVE, relearning_phase -> REPAIR_PENDING, streak reset, count
 * preserved, FSRS receives Again. There is deliberately only ONE
 * function here for both cases (the Phase 4 brief's own
 * applyLongTermWrong already made this same call for the identical
 * reason -- "do not create a second Relearning implementation", Phase 5
 * brief section 12). Which source (FSRS_DUE vs NEAR_DUE) produced the
 * Wrong is a fact for telemetry, not a fork in this function's behavior.
 *
 * Does not itself create the repair obligation the resulting
 * relearning_phase = REPAIR_PENDING implies is coming -- see this
 * module's header and the worked composition test for why, and how a
 * caller completes it with lib/learning-engine/repair-scheduler.ts's
 * createRepairObligation.
 */
export function resolveLongTermWrong(input: ResolveFsrsAnswerInput): FsrsAnswerResolution {
  requireOutsidePool(input.cardState, "resolveLongTermWrong");

  const grade = mapAnswerToFsrsGrade(false);
  const fsrsUpdate = advanceFsrsWithRetention(input.card, input.now, grade, input.desiredRetention);
  const cardState = applyLongTermWrong(input.cardState);

  return { fsrsUpdate, cardState, grade };
}

/** Section 16.3's title names "Near-Due Wrong" specifically; this alias documents that resolveLongTermWrong is exactly that function, not a near-miss -- see resolveLongTermWrong's own doc comment for the full rationale. Prefer calling resolveLongTermWrong directly; this exists for call-site readability where "this is a Near-Due event" is the relevant fact being recorded. */
export const resolveNearDueWrong = resolveLongTermWrong;

/**
 * Section 16.2: Near-Due Correct. FSRS still updates with Good (the
 * schedule/interval genuinely changes), but this is explicitly WEAKER
 * evidence than a scheduled review (section 16.2: "The early success is
 * treated as weaker mastery evidence than a scheduled long-term
 * success") -- mastery count/streak must NOT increment, and current
 * mastery status must not change beyond whatever FSRS's own
 * rescheduling does.
 *
 * There is no Phase 2 transition function for this because the spec
 * requires NO lifecycle state change at all beyond FSRS's own timing
 * update: cardState is returned byte-for-byte identical to the input
 * (section 16.2's "keep current mastery status unless FSRS update
 * changes schedule only" / Phase 5 brief section 11: "if ACQUIRED: do
 * not promote to LEARNED from a Near-Due success", "if LEARNED: keep
 * LEARNED"). Reusing applyQualifyingFsrsCorrect here would be WRONG, not
 * merely redundant -- it would incorrectly increment the counters this
 * function must not touch. This is the deliberate absence of logic the
 * spec calls for, not an oversight.
 */
export function resolveNearDueCorrect(input: ResolveFsrsAnswerInput): FsrsAnswerResolution {
  requireOutsidePool(input.cardState, "resolveNearDueCorrect");

  const grade = mapAnswerToFsrsGrade(true);
  const fsrsUpdate = advanceFsrsWithRetention(input.card, input.now, grade, input.desiredRetention);

  return { fsrsUpdate, cardState: input.cardState, grade };
}
