/**
 * Learning Engine v1 -- card-state shape shared by every pure transition
 * function in lib/learning-engine/transitions.ts.
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 2
 * ("Terminology and state separation"), 3 ("Backend card states"), 5
 * ("Within-day learning stages"), 6.2 ("pool_status"), and 29.1 ("Per
 * user-card state").
 *
 * This is a plain camelCase TypeScript mirror of the new columns added to
 * `user_card_progress` by
 * supabase/migrations/20261001000000_learning_engine_v1_additive_schema.sql
 * -- it deliberately does NOT import or depend on any DB row type
 * (compare lib/learning/fsrs.ts's UserCardProgressFsrsRow, which plays
 * the equivalent role for the legacy FSRS adapter): mapping this shape to
 * and from actual `user_card_progress` columns is a future DAL's job
 * (Phase 3+), not this module's. Keeping that mapping out of scope here
 * is what makes every function in transitions.ts a pure, database-free,
 * unit-testable function, per the Phase 2 brief ("pure deterministic
 * transition functions").
 *
 * Only fields the Phase 2 transition functions actually read or write are
 * modeled. Fields that exist in the new schema but belong to later phases
 * (correct_cooldown_until_position, repair_wrong_position,
 * repair_target_position, repair_hard_cap_position,
 * active_draws_since_eligible, same_day_seen_count/same_day_wrong_count/
 * same_day_progress_date, first_presented_at) are intentionally NOT part
 * of this type -- they are position/scheduling/calendar bookkeeping for
 * Phase 3/4/6 (the Active Pool, the repair scheduler, the source
 * scheduler), not inputs or outputs of the semantic state transitions
 * this phase implements. A future phase that adds those concerns should
 * compose them alongside this type (e.g. in a wider
 * "SchedulableCardState"), not fold them into it.
 *
 * `repairPending` (section 12.1/29.1) IS included, unlike those position
 * fields: it is a plain boolean semantic flag ("does this card currently
 * owe a repair retrieval"), not a position/RNG computation, and it is a
 * direct consequence of exactly two of this phase's own transitions
 * (applyWrong sets it, applyRepairCorrect clears it) -- modeling it here
 * lets those two functions express their full documented effect without
 * a later phase having to re-derive "a Wrong just happened" from context
 * it would otherwise have discarded.
 */

/** Section 3.1. Five backend values; ACQUIRED is new in v1 (not in the legacy 4-value card_status enum). */
export type CardStatus = "NEW" | "LEARNING" | "ACQUIRED" | "LEARNED" | "FORGOTTEN";

/** Section 5.1. Only meaningful while cardStatus === "LEARNING"; null otherwise. */
export type LearningStage = "FRESH" | "LEARNING_1" | "LEARNING_2" | null;

/** Section 6.2. ACTIVE = concentrated within-day acquisition/relearning area; OUTSIDE = FSRS/Near-Due long-term side; null = still in the NEW reservoir, not yet admitted. */
export type PoolStatus = "ACTIVE" | "OUTSIDE" | null;

/** Section 5.1's normalization. Only meaningful during a FORGOTTEN relearning episode; null otherwise. */
export type RelearningPhase = "REPAIR_PENDING" | "SPACED_CONFIRMATION_PENDING" | null;

/**
 * The subset of one user_card_progress row's Learning Engine v1 state
 * that section 2-15/25 transitions read and write. Every transition
 * function in transitions.ts takes one of these and returns a new one --
 * never mutates its input (consistent with lib/learning/fsrs.ts's
 * advanceFsrs not mutating its input `Card`).
 */
export interface LearningEngineCardState {
  readonly cardStatus: CardStatus;
  readonly learningStage: LearningStage;
  readonly poolStatus: PoolStatus;
  readonly relearningPhase: RelearningPhase;

  /** Section 15.2/25.2/34.1: must never be reset to false once true. */
  readonly hasEverBeenMastered: boolean;

  /** Section 12.1/29.1: true between a within-day Wrong and its Repair Correct. See the class-level doc comment for why this is modeled here but the repair's target/hard-cap position is not. */
  readonly repairPending: boolean;

  /**
   * Section 15.1/34.3: cumulative qualifying-scheduled-FSRS-review
   * evidence and its streak. Only applyQualifyingFsrsCorrect increments
   * either; only applyLongTermWrong resets the streak (count is always
   * preserved).
   */
  readonly fsrsReviewCorrectCount: number;
  readonly fsrsReviewCorrectStreak: number;
}

/**
 * The state of a card that has never been presented: NEW, no stage, no
 * pool membership yet, no mastery history, zeroed FSRS-review counters.
 * Exported as a named starting point for callers/tests rather than
 * leaving every caller to hand-write this object -- it is the one state
 * every card begins in, by construction of duplicate_starter_deck()'s own
 * INSERT (card_status = 'NEW') plus this migration's additive column
 * defaults (every new column defaults to NULL/false/0).
 */
export const INITIAL_CARD_STATE: LearningEngineCardState = {
  cardStatus: "NEW",
  learningStage: null,
  poolStatus: null,
  relearningPhase: null,
  hasEverBeenMastered: false,
  repairPending: false,
  fsrsReviewCorrectCount: 0,
  fsrsReviewCorrectStreak: 0,
};

/**
 * Phase 3 (Active Pool): `LearningEngineCardState` plus the two
 * position/counter fields the Active Pool's eligibility and priority
 * rules need -- exactly the "wider SchedulableCardState" this file's own
 * header comment anticipated, rather than folding these into
 * LearningEngineCardState itself (Phase 2's transition functions still
 * neither read nor write either field).
 */
export interface ActivePoolCardState extends LearningEngineCardState {
  /**
   * Section 11.1/29.1: set by a normal stage-advancing Correct to
   * (the position at that Correct) + CORRECT_MIN_GAP (lib/learning-engine/
   * active-priority.ts's applyCorrectCooldown); null means no cooldown is
   * currently in force. Cleared implicitly once the stored position is
   * reached -- see active-priority.ts's isEligibleForNormalSelection.
   */
  readonly correctCooldownUntilPosition: number | null;

  /**
   * Section 19.1: Active-source selections survived since this card last
   * became eligible (i.e. since it was last selected, or since it was
   * newly admitted to Active -- see active-priority.ts's
   * advanceActiveDrawCounters for why no separate "reset on cooldown
   * clearing" step is needed beyond that). Feeds both the soft aging
   * multiplier (section 19.1) and -- in a later phase -- the hard 40-draw
   * starvation guarantee (section 22.3).
   */
  readonly activeDrawsSinceEligible: number;
}
