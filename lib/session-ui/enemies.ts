/**
 * Enemy visual mapping for the Session UI (P2 Session UX Polish).
 *
 * Pure, dependency-free data + lookup -- no React, no fetch. The three
 * canonical enemy identifiers (lib/learning/config.ts's EnemyId /
 * docs/DATABASE_SCHEMA.md 4.5) are internal-only; this module is the ONE
 * place that maps each one to its Beta forest art asset, display label,
 * and a footprint size used to give the Root Golem a slightly heavier
 * presence than the Moss Slime while keeping every enemy within a
 * consistent visual footprint (P2 spec, "Enemies" section). Do not
 * duplicate this mapping in a component.
 */

import type { EnemyId } from "@/lib/learning/config";

export interface EnemyVisual {
  readonly id: EnemyId;
  readonly label: string;
  readonly src: string;
  /** Rendered square footprint in px. Intentionally graduated (not equal) per P2: "allow the Root Golem to read slightly heavier/larger than the Moss Slime." */
  readonly sizePx: number;
}

const ENEMY_VISUALS: Record<EnemyId, EnemyVisual> = {
  enemy_a: { id: "enemy_a", label: "Moss Slime", src: "/enemies/forest/moss-slime.png", sizePx: 160 },
  enemy_b: { id: "enemy_b", label: "Mushroom Goblin", src: "/enemies/forest/mushroom-goblin.png", sizePx: 185 },
  enemy_c: { id: "enemy_c", label: "Root Golem", src: "/enemies/forest/root-golem.png", sizePx: 215 },
};

const ENEMY_IDS = Object.keys(ENEMY_VISUALS) as readonly EnemyId[];

function isEnemyId(value: string): value is EnemyId {
  return (ENEMY_IDS as readonly string[]).includes(value);
}

/**
 * Returns the visual for a known enemy id, or `null` for anything else --
 * the caller decides how to render an unknown enemy (there are exactly
 * three in the current MVP forest stage; this must never throw on
 * unexpected server data).
 */
export function getEnemyVisual(enemyType: string): EnemyVisual | null {
  return isEnemyId(enemyType) ? ENEMY_VISUALS[enemyType] : null;
}
