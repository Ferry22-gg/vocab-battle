/**
 * Learning Engine v1 -- shared policy constants.
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 7
 * ("Core v1 parameters") and section 15 ("First-time Mastery"). Pure data
 * only, mirroring the existing lib/learning/config.ts convention (no
 * inference, no DB access, no scheduling/selection logic).
 *
 * This file defines the subset of section 7's parameters that Phase 2's
 * pure transition functions and Phase 3's Active Pool functions actually
 * consume. Every other v1 parameter (wrong_retry_min_gap/hard_cap,
 * near_due_*, critical_due_*, active_starvation_max_active_source_draws,
 * streak_minimum_enemy_defeats, daily_goal_enemy_defeats) belongs to
 * later phases (the repair scheduler, FSRS/near-due adapter, source
 * scheduler, Daily Goal/streak wiring) and is deliberately NOT duplicated
 * here ahead of the module that will actually use it -- adding it now
 * would just be a second, easily-drifting copy with no reader.
 */

/**
 * Every row/event this engine produces must be attributable to a policy
 * version (section 7: "All policy values MUST be versioned"). Matches the
 * literal default already written into
 * supabase/migrations/20261001000000_learning_engine_v1_additive_schema.sql's
 * user_deck_learning_state.policy_version column default -- keep both in
 * sync by hand if this ever changes, the same precedent
 * commit_answer_transaction()'s own local constants already set for
 * tunables with no shared config table.
 */
export const LEARNING_ENGINE_POLICY_VERSION = "learning-engine-v1.0";

/**
 * Section 15: first-time long-term Mastery requires both
 * fsrs_review_correct_count >= this AND fsrs_review_correct_streak >= the
 * streak threshold below. Only qualifying scheduled FSRS long-term
 * reviews may increment either counter (never same-day Active Corrects,
 * repair Corrects, Near-Due Corrects, or Random Mastered free-play
 * Corrects) -- enforced by the caller choosing which transition function
 * to invoke (applyQualifyingFsrsCorrect vs. every other Correct-handling
 * function), not by anything in this constants file.
 */
export const MASTERY_CORRECT_COUNT_REQUIRED = 3;
export const MASTERY_CORRECT_STREAK_REQUIRED = 2;

// ---------------------------------------------------------------------------
// Active Pool (section 7, 8, 11.1, 19, 19.1) -- Phase 3
// ---------------------------------------------------------------------------

/** Section 8.1: the saturated Active Pool target. A target, not a requirement that the pool instantly contain this many cards. */
export const ACTIVE_POOL_TARGET_SIZE = 20;

/** Section 8.2: at most this many cards may simultaneously be Fresh (admitted to Active but not yet having achieved a first successful retrieval). */
export const FRESH_CARD_LIMIT = 6;

/** Section 11.1/7 (correct_min_gap): a card is ineligible for this many intervening cards after a normal stage-advancing Correct. */
export const CORRECT_MIN_GAP = 5;

/** Section 19: base weight per within-day learning stage, before the aging multiplier. Only FRESH/LEARNING_1/LEARNING_2 cards participate in ordinary Active-source weighted selection -- see lib/learning-engine/active-priority.ts. */
export const STAGE_BASE_WEIGHT = {
  FRESH: 1.0,
  LEARNING_1: 1.2,
  LEARNING_2: 1.1,
} as const satisfies Record<"FRESH" | "LEARNING_1" | "LEARNING_2", number>;

/**
 * Section 19.1: the soft aging multiplier, keyed by how many Active-source
 * selections this card has survived since it last became eligible. Ordered
 * ascending by `minDraws`; the first bucket whose `minDraws` the draw count
 * meets or exceeds (scanning from the end) applies -- see
 * lib/learning-engine/active-priority.ts's agingMultiplier.
 */
export const AGING_MULTIPLIER_BUCKETS = [
  { minDraws: 0, multiplier: 1.0 },
  { minDraws: 5, multiplier: 1.1 },
  { minDraws: 10, multiplier: 1.2 },
  { minDraws: 15, multiplier: 1.3 },
  { minDraws: 20, multiplier: 1.4 },
] as const;

// ---------------------------------------------------------------------------
// Repair scheduler (section 7, 12.2, 22.1) -- Phase 4
// ---------------------------------------------------------------------------

/** Section 12.2/7 (wrong_retry_min_gap): a repair may never be presented before this many full intervening cards have passed. */
export const WRONG_RETRY_MIN_GAP = 3;

/** Section 12.2/22.1/7 (wrong_retry_hard_cap): a repair may never be delayed beyond this many full intervening cards -- the authoritative ceiling, independent of the sampled target gap. */
export const WRONG_RETRY_HARD_CAP = 6;

/** Section 12.2: "sample a target repair offset uniformly from {3,4,5,6}" -- the literal set, not merely the [MIN_GAP, HARD_CAP] range (they happen to coincide here, but this spells out the spec's own enumerated set rather than relying on that coincidence). */
export const REPAIR_GAP_OPTIONS = [3, 4, 5, 6] as const;

// ---------------------------------------------------------------------------
// FSRS wiring (section 7, 14.3, 16-18, 27.2) -- Phase 5
// ---------------------------------------------------------------------------

/** Section 14.3/7 (desired_retention_default): used unless the user's persisted pain_point overrides it. */
export const DEFAULT_DESIRED_RETENTION = 0.9;

/** Section 14.3/27.2/7 (desired_retention_retention_loss): used only when user_learning_preferences.pain_point = 'retention_loss'. Not an inference that the user has poor memory -- a preference prior (section 14.3). */
export const RETENTION_LOSS_DESIRED_RETENTION = 0.92;

/** Section 16.1/7 (near_due_start_progress): interval_progress at/above this (and below 1.0) is NEAR_DUE. */
export const NEAR_DUE_START_PROGRESS = 0.75;

/** Section 16.1/7 (near_due_end_progress): interval_progress at/above this is FSRS_DUE, not NEAR_DUE. */
export const NEAR_DUE_END_PROGRESS = 1.0;

/** Section 17: the Due-card weight formula's cap -- "Use: w_due(i) = min(3.0, sqrt((1 - R_i) / (1 - r_d)))". */
export const DUE_WEIGHT_CAP = 3.0;

// ---------------------------------------------------------------------------
// Scheduler (section 7, 20, 22.2) -- Phase 6
// ---------------------------------------------------------------------------

/** Section 7 (critical_due_max_global_gap): "no Critical Due card has been presented in the last 5 global questions" -- see lib/learning-engine/scheduler/position.ts's hasCriticalDueAppearedRecently for the exact (off-by-one-reviewed) boundary this gates. */
export const CRITICAL_DUE_GLOBAL_QUESTION_WINDOW = 5;

/** Section 7/22.2 (critical_due_R_threshold): a FSRS_DUE card with current Retrievability at or below this is a Critical Due candidate -- see lib/learning-engine/scheduler/interrupts.ts's findCriticalDueInterrupt (Phase 6D). */
export const CRITICAL_DUE_R_THRESHOLD = 0.6;

/** Section 20: due_count tier boundaries ("Equivalent with target 20: 1-9 Due cards" / "10+ Due cards"). due_count === 0 is its own tier (ACTIVE_FOCUS, no named constant needed -- it's just zero); this is the review-pressure floor. */
export const DUE_TIER_REVIEW_PRESSURE_THRESHOLD = 10;

/**
 * Section 20.1/20.2: the six Dynamic Source Weight regimes, keyed by due
 * tier, before (section 20.1) and after (section 20.2) Daily Goal
 * completion. Literal spec tables -- do not derive these from a formula;
 * the spec gives exact decimal weights, including the deliberately
 * unchanged Review Pressure row post-goal ("Unchanged").
 */
export const PRE_GOAL_SOURCE_WEIGHTS = {
  ACTIVE_FOCUS: { active: 0.9, due: 0.0, near: 0.1 },
  BALANCED: { active: 0.7, due: 0.25, near: 0.05 },
  REVIEW_PRESSURE: { active: 0.5, due: 0.48, near: 0.02 },
} as const;

export const POST_GOAL_SOURCE_WEIGHTS = {
  ACTIVE_FOCUS: { active: 0.8, due: 0.0, near: 0.2 },
  BALANCED: { active: 0.75, due: 0.15, near: 0.1 },
  // Section 20.2: "Unchanged" from the pre-goal Review Pressure row --
  // "the goal overlay must never suppress a genuinely large review
  // backlog." Written out explicitly rather than referencing
  // PRE_GOAL_SOURCE_WEIGHTS.REVIEW_PRESSURE, so this table reads as a
  // complete, standalone source of truth matching the spec's own layout.
  REVIEW_PRESSURE: { active: 0.5, due: 0.48, near: 0.02 },
} as const;

/** Section 7 (active_starvation_max_active_source_draws): an eligible Active card that survives this many Active-source selections without being chosen must be guaranteed on the next Active slot (section 22.3) -- Phase 6C only exposes the raw candidate structure for this; the guarantee itself is Phase 6D. */
export const ACTIVE_STARVATION_MAX_DRAWS = 40;

// ---------------------------------------------------------------------------
// Post-Mastery source policy (section 25.3) -- Phase 7
// ---------------------------------------------------------------------------

/**
 * Section 25.3's pre-Daily-Goal Post-Mastery regimes, keyed by the SAME
 * due-tier boundaries as ordinary mode (lib/learning-engine/scheduler/
 * source-policy.ts's classifyDueTier, reused unchanged -- due_count === 0
 * / 1-9 / 10+ is not a concept Post-Mastery redefines). Literal spec
 * values, not derived.
 */
export const POST_MASTERY_PRE_GOAL_SOURCE_WEIGHTS = {
  ACTIVE_FOCUS: { randomMastered: 0.8, due: 0.0, near: 0.2 },
  BALANCED: { randomMastered: 0.45, due: 0.4, near: 0.15 },
  REVIEW_PRESSURE: { randomMastered: 0.3, due: 0.6, near: 0.1 },
} as const;

/**
 * Section 25.3's post-Daily-Goal Post-Mastery regimes. The zero-Due row
 * (`ACTIVE_FOCUS`) was clarified to be IDENTICAL to the pre-goal zero-Due
 * row: "intentionally unchanged from the pre-goal zero-Due regime -- it is
 * already sufficiently free-play oriented." (Reviewed correction -- a
 * prior revision of this file treated this combination as an unresolved
 * specification gap and threw rather than guessing; it is now an
 * explicitly confirmed regime, not an invented default.)
 */
export const POST_MASTERY_POST_GOAL_SOURCE_WEIGHTS = {
  ACTIVE_FOCUS: { randomMastered: 0.8, due: 0.0, near: 0.2 },
  BALANCED: { randomMastered: 0.55, due: 0.25, near: 0.2 },
  REVIEW_PRESSURE: { randomMastered: 0.3, due: 0.6, near: 0.1 },
} as const;
