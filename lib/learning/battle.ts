/**
 * Pure battle-result calculator (docs/MVP_SPEC_FOR_CLAUDE.md sections 19-21).
 *
 * Computes one answer's damage/combo/critical/respawn result from trusted
 * server-side inputs. Pure and side-effect free: no database access, no
 * FSRS/rating logic, no mutation of its input, no direct `Math.random()`
 * call -- randomness is injected (see RandomSource below) so results are
 * fully deterministic and testable.
 *
 * Output field -> commit_answer_transaction() RPC parameter mapping
 * (supabase/migrations/20260923200000_commit_answer_transaction.sql),
 * confirmed by cross-check before implementing this module:
 *   baseDamage    -> p_base_damage
 *   speedBonus    -> p_speed_bonus
 *   critical      -> p_critical
 *   comboAfter    -> p_combo_after
 *   damage        -> p_damage
 *   enemyHpAfter  -> p_enemy_hp_after
 *   enemyDefeated -> p_enemy_defeated
 *   newEnemyType   -> p_new_enemy_type
 *   newEnemyMaxHp  -> p_new_enemy_max_hp
 *   newEnemyHp     -> p_new_enemy_hp
 * `comboBonus` has no RPC parameter of its own -- it is an intermediate
 * value folded into `damage`, exposed here for transparency/testability
 * only. The RPC independently re-derives/validates the arithmetic
 * consistency of these fields; it does not trust them blindly.
 */

import {
  BATTLE_CONFIG,
  COMBO_BONUS_TIERS,
  ENEMY_CONFIG,
  SPEED_BONUS_DEFAULT,
  SPEED_BONUS_TIERS,
  type EnemyId,
} from "@/lib/learning/config";

/**
 * Injectable randomness source. Contract matches `Math.random()`: called
 * with no arguments, returns a float in [0, 1). Production callers may
 * pass `Math.random` directly; tests supply a deterministic stub/queue to
 * force specific rolls.
 */
export type RandomSource = () => number;

export interface BattleCalculationInput {
  /** Whether the user judged this answer Correct or Wrong. */
  readonly correct: boolean;

  /**
   * Milliseconds from front display to "Show Answer" (same measurement as
   * the rating estimator). Assumed >= 0, mirroring the
   * `answer_events.response_time_ms >= 0` DB check -- not validated or
   * clamped here; enforce at the input boundary if that assumption can be
   * violated.
   */
  readonly responseTimeMs: number;

  /**
   * The session's combo value going into this answer (`sessions.current_combo`
   * before this answer). Assumed to be an integer in
   * `[0, BATTLE_CONFIG.MAX_COMBO]`, mirroring the `current_combo >= 0` DB
   * check and the fact that combo is always capped on write. Not
   * defensively clamped here -- the `min(comboBefore + 1, MAX_COMBO)` step
   * below is core game logic, not input sanitization.
   */
  readonly comboBefore: number;

  /**
   * The enemy's HP going into this answer (`sessions.current_enemy_hp`
   * before this answer). Assumed to be a positive integer; not validated
   * here.
   */
  readonly enemyHpBefore: number;

  /**
   * Randomness source. Called zero times for a Wrong answer (Wrong must
   * never consume RNG). Called exactly twice for a Correct answer that
   * does not defeat the enemy, in this fixed order:
   *   1. base damage roll
   *   2. critical roll
   * Called exactly three times for a Correct answer that defeats the
   * enemy -- the two calls above, plus:
   *   3. next-enemy selection roll
   */
  readonly random: RandomSource;
}

export interface BattleCalculationResult {
  readonly baseDamage: number;
  readonly speedBonus: number;
  readonly comboBonus: number;
  readonly critical: boolean;
  readonly comboAfter: number;
  readonly damage: number;
  readonly enemyHpAfter: number;
  readonly enemyDefeated: boolean;
  /** Canonical ID of the newly spawned enemy, or null when enemyDefeated is false. */
  readonly newEnemyType: EnemyId | null;
  /** Full HP of the newly spawned enemy, or null when enemyDefeated is false. */
  readonly newEnemyMaxHp: number | null;
  /** Current HP of the newly spawned enemy -- always equal to newEnemyMaxHp, or null when enemyDefeated is false. */
  readonly newEnemyHp: number | null;
}

const ENEMY_IDS = Object.keys(ENEMY_CONFIG) as readonly EnemyId[];

/**
 * Rolls an unbiased integer in `[min, max]` inclusive from one `random()`
 * call: `floor(random() * (max - min + 1)) + min`. Uniform given a uniform
 * `random()` over `[0, 1)` -- e.g. for `[24, 28]` (5 outcomes), `random()`
 * values in `[0, 0.2)` produce 24 and values in `[0.8, 1)` produce 28.
 */
function rollIntInclusive(min: number, max: number, random: RandomSource): number {
  const range = max - min + 1;
  return min + Math.floor(random() * range);
}

function rollCritical(random: RandomSource): boolean {
  return random() < BATTLE_CONFIG.CRITICAL_RATE;
}

function pickEnemyId(random: RandomSource): EnemyId {
  const index = Math.floor(random() * ENEMY_IDS.length);
  return ENEMY_IDS[index];
}

function resolveSpeedBonus(responseTimeMs: number): number {
  for (const tier of SPEED_BONUS_TIERS) {
    if (responseTimeMs <= tier.maxResponseTimeMs) {
      return tier.bonus;
    }
  }
  return SPEED_BONUS_DEFAULT;
}

/**
 * comboAfter is always produced by this module as
 * `min(comboBefore + 1, MAX_COMBO)`, so it always falls inside
 * `COMBO_BONUS_TIERS`' full 1-10 coverage; the `?? 0` fallback exists only
 * for type safety and should be unreachable.
 */
function resolveComboBonus(comboAfter: number): number {
  const tier = COMBO_BONUS_TIERS.find(
    (t) => comboAfter >= t.minCombo && comboAfter <= t.maxCombo,
  );
  return tier?.bonus ?? 0;
}

/**
 * Calculates the full battle result for one answer. See
 * BattleCalculationInput.random for the exact RNG call order/count.
 */
export function calculateBattleResult(
  input: BattleCalculationInput,
): BattleCalculationResult {
  const { correct, responseTimeMs, comboBefore, enemyHpBefore, random } = input;

  if (!correct) {
    return {
      baseDamage: 0,
      speedBonus: 0,
      comboBonus: 0,
      critical: false,
      comboAfter: 0,
      damage: 0,
      enemyHpAfter: enemyHpBefore,
      enemyDefeated: false,
      newEnemyType: null,
      newEnemyMaxHp: null,
      newEnemyHp: null,
    };
  }

  const baseDamage = rollIntInclusive(
    BATTLE_CONFIG.BASE_DAMAGE_MIN,
    BATTLE_CONFIG.BASE_DAMAGE_MAX,
    random,
  );
  const critical = rollCritical(random);

  const comboAfter = Math.min(comboBefore + 1, BATTLE_CONFIG.MAX_COMBO);
  const comboBonus = resolveComboBonus(comboAfter);
  const speedBonus = resolveSpeedBonus(responseTimeMs);

  const preCriticalDamage = baseDamage + comboBonus + speedBonus;
  const damage = critical
    ? preCriticalDamage * BATTLE_CONFIG.CRITICAL_DAMAGE_MULTIPLIER
    : preCriticalDamage;

  const enemyHpAfter = Math.max(0, enemyHpBefore - damage);
  const enemyDefeated = enemyHpAfter === 0;

  if (!enemyDefeated) {
    return {
      baseDamage,
      speedBonus,
      comboBonus,
      critical,
      comboAfter,
      damage,
      enemyHpAfter,
      enemyDefeated,
      newEnemyType: null,
      newEnemyMaxHp: null,
      newEnemyHp: null,
    };
  }

  const newEnemyType = pickEnemyId(random);
  const newEnemyMaxHp = ENEMY_CONFIG[newEnemyType].initialHp;

  return {
    baseDamage,
    speedBonus,
    comboBonus,
    critical,
    comboAfter,
    damage,
    enemyHpAfter,
    enemyDefeated,
    newEnemyType,
    newEnemyMaxHp,
    newEnemyHp: newEnemyMaxHp,
  };
}
