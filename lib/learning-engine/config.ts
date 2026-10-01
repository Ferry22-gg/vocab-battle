/**
 * Learning Engine v1 -- shared policy constants.
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 7
 * ("Core v1 parameters") and section 15 ("First-time Mastery"). Pure data
 * only, mirroring the existing lib/learning/config.ts convention (no
 * inference, no DB access, no scheduling/selection logic).
 *
 * This file intentionally only defines the subset of section 7's
 * parameters that Phase 2's pure transition functions (lib/learning-
 * engine/transitions.ts) actually consume. Every other v1 parameter
 * (active_pool_target, fresh_card_limit, correct_min_gap,
 * wrong_retry_min_gap/hard_cap, stage weights, near_due_*,
 * critical_due_*, active_starvation_max_active_source_draws,
 * streak_minimum_enemy_defeats, daily_goal_enemy_defeats) belongs to
 * later phases (Active Pool, repair scheduler, FSRS/near-due adapter,
 * source scheduler, Daily Goal/streak wiring) and is deliberately NOT
 * duplicated here ahead of the module that will actually use it --
 * adding it now would just be a second, easily-drifting copy with no
 * reader.
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
