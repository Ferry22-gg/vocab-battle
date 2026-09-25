/**
 * Central Learning Engine configuration.
 *
 * Single source of truth for tunable rating/FSRS/battle/enemy constants
 * (docs/MVP_SPEC_FOR_CLAUDE.md section 35). Pure data only -- no rating
 * inference, no FSRS calls, no damage math. That logic belongs in future
 * modules (e.g. rating.ts, battle.ts) that import these constants instead
 * of hard-coding their own copies.
 *
 * The XP ledger, level curve, Daily Goal, and Active Pool constants listed
 * in section 35 are intentionally NOT included yet -- they are already
 * mirrored as literal constants inside
 * supabase/migrations/20260923200000_commit_answer_transaction.sql, and
 * centralizing them here is deferred to a later phase.
 */

import type { FSRSParameters } from "ts-fsrs";

// ---------------------------------------------------------------------------
// Rating configuration
//
// Feeds the internal Again/Hard/Good/Easy rating estimator
// (docs/MVP_SPEC_FOR_CLAUDE.md section 16). The user never picks a rating
// directly -- these thresholds turn `correct` + `response_time_ms` + recent
// answer history into one of the four FSRS ratings.
//
// The exact millisecond thresholds and the "stable history" length are MVP
// initial tuning values, not scientifically optimal or FSRS-derived
// figures. They are expected to be revisited after Beta response-time data
// is available.
// ---------------------------------------------------------------------------

export const RATING_CONFIG = {
  /**
   * A correct answer with response_time_ms >= this value is rated Hard.
   * MVP initial tuning value -- subject to change after Beta data.
   */
  HARD_RESPONSE_THRESHOLD_MS: 8000,

  /**
   * A correct answer with response_time_ms <= this value is *eligible* for
   * Easy, provided every other Easy eligibility condition also passes
   * (EASY_MIN_SEEN_COUNT, EASY_STABLE_HISTORY_LENGTH, and "previous answer
   * was not Wrong"). It does not by itself force an Easy rating.
   * MVP initial tuning value -- subject to change after Beta data.
   */
  EASY_RESPONSE_THRESHOLD_MS: 3000,

  /**
   * Minimum seen_count required for Easy eligibility.
   */
  EASY_MIN_SEEN_COUNT: 4,

  /**
   * "Recent history is stable" (Easy eligibility only, MVP heuristic): the
   * most recent N committed answers for the card must all be Correct. This
   * must never influence correctness, FSRS directly, XP, battle damage, or
   * card lifecycle rules -- it is scoped to Easy eligibility alone.
   * MVP initial tuning value -- subject to change after Beta data.
   */
  EASY_STABLE_HISTORY_LENGTH: 3,
} as const;

// ---------------------------------------------------------------------------
// FSRS configuration
//
// docs/MVP_SPEC_FOR_CLAUDE.md section 17. Passed into ts-fsrs's
// generatorParameters() by the future FSRS adapter -- fields left unset
// here (e.g. `w`, maximum_interval, learning/relearning steps) take
// ts-fsrs's own defaults. Do not add custom weights unless explicitly
// specified in the project docs.
// ---------------------------------------------------------------------------

export const FSRS_CONFIG = {
  request_retention: 0.9,
  enable_fuzz: true,
  enable_short_term: true,
} as const satisfies Partial<FSRSParameters>;

// ---------------------------------------------------------------------------
// Battle configuration
//
// docs/MVP_SPEC_FOR_CLAUDE.md sections 19-21. Base damage, combo, and
// critical values are the existing MVP specification values, used exactly.
// Speed-bonus and combo-bonus tiers are separate, unrelated systems from
// the rating thresholds above -- do not conflate a "fast recall" rating
// threshold with a "speed bonus" battle threshold.
// ---------------------------------------------------------------------------

export const BATTLE_CONFIG = {
  /** Inclusive minimum of the random base-damage roll for a Correct answer. */
  BASE_DAMAGE_MIN: 24,
  /** Inclusive maximum of the random base-damage roll for a Correct answer. */
  BASE_DAMAGE_MAX: 28,

  /** Combo is capped at this value; a Wrong answer resets combo to 0. */
  MAX_COMBO: 10,

  /** Probability of a critical hit on a Correct answer. */
  CRITICAL_RATE: 0.05,
  /** Final-damage multiplier applied on a critical hit. */
  CRITICAL_DAMAGE_MULTIPLIER: 2,
} as const;

/**
 * Speed bonus tiers for a Correct answer, keyed by response_time_ms.
 * Evaluate in array order and take the first tier whose
 * `maxResponseTimeMs` the response time satisfies; a response time
 * exceeding every tier's `maxResponseTimeMs` gets SPEED_BONUS_DEFAULT.
 * A Wrong answer must always use SPEED_BONUS_DEFAULT regardless of
 * response time.
 * MVP initial tuning values -- subject to change after Beta data.
 */
export const SPEED_BONUS_TIERS = [
  { maxResponseTimeMs: 2000, bonus: 3 },
  { maxResponseTimeMs: 4000, bonus: 2 },
  { maxResponseTimeMs: 6000, bonus: 1 },
] as const;

/** Speed bonus for a response slower than every SPEED_BONUS_TIERS entry, or for any Wrong answer. */
export const SPEED_BONUS_DEFAULT = 0;

/**
 * Combo bonus tiers, keyed by combo_after -- the post-increment combo
 * value (current Correct answer increments combo first, capped at
 * BATTLE_CONFIG.MAX_COMBO, and the resulting value is what's looked up
 * here). Ranges are inclusive of both `minCombo` and `maxCombo`.
 */
export const COMBO_BONUS_TIERS = [
  { minCombo: 1, maxCombo: 2, bonus: 0 },
  { minCombo: 3, maxCombo: 4, bonus: 2 },
  { minCombo: 5, maxCombo: 6, bonus: 4 },
  { minCombo: 7, maxCombo: 8, bonus: 6 },
  { minCombo: 9, maxCombo: 10, bonus: 8 },
] as const;

// ---------------------------------------------------------------------------
// Enemy configuration
//
// Canonical enemy identifiers and initial HP, mirrored from
// docs/DATABASE_SCHEMA.md section 4.5 ("Canonical enemy identifiers") and
// the commit_answer_transaction() migration comment. These IDs are
// internal/stable only, not display names or art labels -- do not rename
// or change these HP values without updating both docs.
// ---------------------------------------------------------------------------

export const ENEMY_CONFIG = {
  enemy_a: { initialHp: 90 },
  enemy_b: { initialHp: 105 },
  enemy_c: { initialHp: 120 },
} as const;

export type EnemyId = keyof typeof ENEMY_CONFIG;
