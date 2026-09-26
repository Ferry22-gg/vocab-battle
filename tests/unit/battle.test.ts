import { describe, expect, it, vi } from "vitest";

import { BATTLE_CONFIG, ENEMY_CONFIG, type EnemyId } from "@/lib/learning/config";
import {
  calculateBattleResult,
  type BattleCalculationInput,
  type RandomSource,
} from "@/lib/learning/battle";

/** Pops values off a fixed queue, one per random() call; throws if called more times than values supplied. */
function sequenceRandom(values: readonly number[]): RandomSource {
  let index = 0;
  return () => {
    if (index >= values.length) {
      throw new Error(`sequenceRandom exhausted after ${values.length} call(s)`);
    }
    return values[index++];
  };
}

/** Fails the test immediately if random() is ever called -- used to assert Wrong answers never consume RNG. */
const forbiddenRandom: RandomSource = () => {
  throw new Error("random() must not be called");
};

const ENEMY_IDS = Object.keys(ENEMY_CONFIG) as readonly EnemyId[];

describe("calculateBattleResult", () => {
  describe("Wrong answers", () => {
    const input: BattleCalculationInput = {
      correct: false,
      responseTimeMs: 100, // very fast, must not matter
      comboBefore: 7,
      enemyHpBefore: 50,
      random: forbiddenRandom,
    };
    const result = calculateBattleResult(input);

    it("deals zero damage", () => {
      expect(result.damage).toBe(0);
      expect(result.baseDamage).toBe(0);
    });

    it("resets combo to 0", () => {
      expect(result.comboAfter).toBe(0);
      expect(result.comboBonus).toBe(0);
    });

    it("leaves enemy HP unchanged", () => {
      expect(result.enemyHpAfter).toBe(input.enemyHpBefore);
      expect(result.enemyDefeated).toBe(false);
    });

    it("applies zero speed bonus even for a very fast wrong answer", () => {
      expect(result.speedBonus).toBe(0);
    });

    it("is never critical", () => {
      expect(result.critical).toBe(false);
    });

    it("does not consume RNG (forbiddenRandom would have thrown if called)", () => {
      expect(() => calculateBattleResult(input)).not.toThrow();
    });

    it("returns null respawn fields", () => {
      expect(result.newEnemyType).toBeNull();
      expect(result.newEnemyMaxHp).toBeNull();
      expect(result.newEnemyHp).toBeNull();
    });
  });

  describe("speed bonus boundaries", () => {
    const cases: readonly [responseTimeMs: number, expectedBonus: number][] = [
      [2000, 3],
      [2001, 2],
      [4000, 2],
      [4001, 1],
      [6000, 1],
      [6001, 0],
    ];

    it.each(cases)("responseTimeMs=%i -> speedBonus=%i", (responseTimeMs, expectedBonus) => {
      const result = calculateBattleResult({
        correct: true,
        responseTimeMs,
        comboBefore: 0, // comboAfter 1 -> comboBonus 0
        enemyHpBefore: 1000, // never lethal
        random: sequenceRandom([0, 0.9]), // baseDamage=24, non-critical
      });

      expect(result.speedBonus).toBe(expectedBonus);
      expect(result.damage).toBe(24 + expectedBonus);
    });
  });

  describe("combo bonus tiers (keyed by comboAfter)", () => {
    const cases: readonly [comboBefore: number, comboAfter: number, expectedBonus: number][] = [
      [0, 1, 0],
      [2, 3, 2],
      [4, 5, 4],
      [6, 7, 6],
      [8, 9, 8],
      [10, 10, 8], // already at MAX_COMBO -> stays capped
    ];

    it.each(cases)(
      "comboBefore=%i -> comboAfter=%i -> comboBonus=%i",
      (comboBefore, comboAfter, expectedBonus) => {
        const result = calculateBattleResult({
          correct: true,
          responseTimeMs: 9999, // > 6000ms -> speedBonus 0
          comboBefore,
          enemyHpBefore: 1000,
          random: sequenceRandom([0, 0.9]), // baseDamage=24, non-critical
        });

        expect(result.comboAfter).toBe(comboAfter);
        expect(result.comboBonus).toBe(expectedBonus);
        expect(result.damage).toBe(24 + expectedBonus);
      },
    );
  });

  describe("base damage roll", () => {
    it("random()=0 produces the minimum (24)", () => {
      const result = calculateBattleResult({
        correct: true,
        responseTimeMs: 9999,
        comboBefore: 0,
        enemyHpBefore: 1000,
        random: sequenceRandom([0, 0.9]),
      });
      expect(result.baseDamage).toBe(BATTLE_CONFIG.BASE_DAMAGE_MIN);
    });

    it("random() just under 1 produces the maximum (28)", () => {
      const result = calculateBattleResult({
        correct: true,
        responseTimeMs: 9999,
        comboBefore: 0,
        enemyHpBefore: 1000,
        random: sequenceRandom([0.999999, 0.9]),
      });
      expect(result.baseDamage).toBe(BATTLE_CONFIG.BASE_DAMAGE_MAX);
    });

    it("only ever produces integers within [24, 28] across the full RNG input range", () => {
      for (let i = 0; i < 1000; i++) {
        const roll = i / 1000; // [0, 1)
        const result = calculateBattleResult({
          correct: true,
          responseTimeMs: 9999,
          comboBefore: 0,
          enemyHpBefore: 1000,
          random: sequenceRandom([roll, 0.9]),
        });
        expect(Number.isInteger(result.baseDamage)).toBe(true);
        expect(result.baseDamage).toBeGreaterThanOrEqual(BATTLE_CONFIG.BASE_DAMAGE_MIN);
        expect(result.baseDamage).toBeLessThanOrEqual(BATTLE_CONFIG.BASE_DAMAGE_MAX);
      }
    });
  });

  describe("critical", () => {
    it("random() >= CRITICAL_RATE forces non-critical", () => {
      const result = calculateBattleResult({
        correct: true,
        responseTimeMs: 9999,
        comboBefore: 0,
        enemyHpBefore: 1000,
        random: sequenceRandom([0, BATTLE_CONFIG.CRITICAL_RATE]),
      });
      expect(result.critical).toBe(false);
    });

    it("random() < CRITICAL_RATE forces critical", () => {
      const result = calculateBattleResult({
        correct: true,
        responseTimeMs: 9999,
        comboBefore: 0,
        enemyHpBefore: 1000,
        random: sequenceRandom([0, BATTLE_CONFIG.CRITICAL_RATE - 0.001]),
      });
      expect(result.critical).toBe(true);
    });

    it("doubles the full pre-critical damage, including combo + speed bonuses", () => {
      // baseDamage=28, comboBefore 4 -> comboAfter 5 -> +4, responseTimeMs 1500 -> +3
      const result = calculateBattleResult({
        correct: true,
        responseTimeMs: 1500,
        comboBefore: 4,
        enemyHpBefore: 1000,
        random: sequenceRandom([0.999999, 0]), // baseDamage=28, critical=true
      });

      expect(result.baseDamage).toBe(28);
      expect(result.comboBonus).toBe(4);
      expect(result.speedBonus).toBe(3);
      expect(result.critical).toBe(true);
      expect(result.damage).toBe((28 + 4 + 3) * BATTLE_CONFIG.CRITICAL_DAMAGE_MULTIPLIER);
    });
  });

  describe("enemy HP", () => {
    it("subtracts damage normally when non-lethal", () => {
      const result = calculateBattleResult({
        correct: true,
        responseTimeMs: 9999,
        comboBefore: 0,
        enemyHpBefore: 100,
        random: sequenceRandom([0, 0.9]), // damage = 24
      });
      expect(result.damage).toBe(24);
      expect(result.enemyHpAfter).toBe(76);
      expect(result.enemyDefeated).toBe(false);
    });

    it("never takes HP below 0 on overkill", () => {
      const result = calculateBattleResult({
        correct: true,
        responseTimeMs: 9999,
        comboBefore: 0,
        enemyHpBefore: 5, // far less than damage=24
        random: sequenceRandom([0, 0.9, 0]),
      });
      expect(result.enemyHpAfter).toBe(0);
      expect(result.enemyDefeated).toBe(true);
    });

    it("exact lethal damage -> enemyHpAfter 0 and defeated true", () => {
      const result = calculateBattleResult({
        correct: true,
        responseTimeMs: 9999,
        comboBefore: 0,
        enemyHpBefore: 24, // exactly equal to damage=24
        random: sequenceRandom([0, 0.9, 0]),
      });
      expect(result.damage).toBe(24);
      expect(result.enemyHpAfter).toBe(0);
      expect(result.enemyDefeated).toBe(true);
    });
  });

  describe("respawn", () => {
    it("does not respawn when the enemy survives", () => {
      const result = calculateBattleResult({
        correct: true,
        responseTimeMs: 9999,
        comboBefore: 0,
        enemyHpBefore: 1000,
        random: sequenceRandom([0, 0.9]), // only 2 values -- a 3rd random() call would throw
      });
      expect(result.enemyDefeated).toBe(false);
      expect(result.newEnemyType).toBeNull();
      expect(result.newEnemyMaxHp).toBeNull();
      expect(result.newEnemyHp).toBeNull();
    });

    it("returns a canonical new enemy id/max HP/current HP on defeat", () => {
      const result = calculateBattleResult({
        correct: true,
        responseTimeMs: 9999,
        comboBefore: 0,
        enemyHpBefore: 1, // guaranteed lethal
        random: sequenceRandom([0, 0.9, 0.5]),
      });
      expect(result.enemyDefeated).toBe(true);
      expect(result.newEnemyType).not.toBeNull();
      expect(ENEMY_IDS).toContain(result.newEnemyType);
      expect(result.newEnemyMaxHp).toBe(ENEMY_CONFIG[result.newEnemyType as EnemyId].initialHp);
      expect(result.newEnemyHp).toBe(result.newEnemyMaxHp);
    });

    it.each(ENEMY_IDS.map((id, i) => [id, i] as const))(
      "deterministic RNG selects %s at enemy index %i",
      (expectedId, index) => {
        // Midpoint of this enemy's [index/3, (index+1)/3) selection band.
        const enemySelectRoll = (index + 0.5) / ENEMY_IDS.length;
        const result = calculateBattleResult({
          correct: true,
          responseTimeMs: 9999,
          comboBefore: 0,
          enemyHpBefore: 1,
          random: sequenceRandom([0, 0.9, enemySelectRoll]),
        });
        expect(result.newEnemyType).toBe(expectedId);
      },
    );
  });

  describe("RNG call count", () => {
    it("calls random() exactly twice for a non-lethal correct answer", () => {
      const random = vi.fn(sequenceRandom([0, 0.9]));
      calculateBattleResult({
        correct: true,
        responseTimeMs: 9999,
        comboBefore: 0,
        enemyHpBefore: 1000,
        random,
      });
      expect(random).toHaveBeenCalledTimes(2);
    });

    it("calls random() exactly three times for a defeating correct answer", () => {
      const random = vi.fn(sequenceRandom([0, 0.9, 0.5]));
      calculateBattleResult({
        correct: true,
        responseTimeMs: 9999,
        comboBefore: 0,
        enemyHpBefore: 1,
        random,
      });
      expect(random).toHaveBeenCalledTimes(3);
    });

    it("calls random() zero times for a Wrong answer", () => {
      const random = vi.fn(forbiddenRandom);
      calculateBattleResult({
        correct: false,
        responseTimeMs: 100,
        comboBefore: 5,
        enemyHpBefore: 50,
        random,
      });
      expect(random).not.toHaveBeenCalled();
    });
  });
});
