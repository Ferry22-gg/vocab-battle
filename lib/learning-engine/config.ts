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
