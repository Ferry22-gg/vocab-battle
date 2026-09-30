/**
 * Pure XP-progress display math for Home's header (docs/DATABASE_SCHEMA.md
 * "Level calculation"): `cumulative(L) = 200*(L-1) + 25*(L-1)*(L-2)` is the
 * exact formula `commit_answer_transaction()` uses, in Postgres, to derive
 * `profiles.level` from `profiles.total_xp`. This module never re-derives
 * `level` itself -- that always comes directly from the trusted
 * `profiles.level` column -- it only re-splits `total_xp` into "earned
 * within the current level" / "needed for the next level" for display,
 * using the same formula against the already-trusted `level`.
 */
function cumulativeXpForLevel(level: number): number {
  return 200 * (level - 1) + 25 * (level - 1) * (level - 2);
}

export interface LevelProgress {
  /** XP earned since reaching the current level. */
  readonly currentLevelXp: number;
  /** Total XP required to go from the current level to the next one. */
  readonly xpForNextLevel: number;
}

export function computeLevelProgress(totalXp: number, level: number): LevelProgress {
  const floor = cumulativeXpForLevel(level);
  const ceiling = cumulativeXpForLevel(level + 1);
  return {
    currentLevelXp: Math.max(0, totalXp - floor),
    xpForNextLevel: ceiling - floor,
  };
}

/** Percent width for the XP progress bar, clamped like lib/session-ui/hp.ts's clampHpPercent. */
export function xpProgressPercent(currentLevelXp: number, xpForNextLevel: number): number {
  if (xpForNextLevel <= 0) return 0;
  return Math.max(0, Math.min(100, (currentLevelXp / xpForNextLevel) * 100));
}
