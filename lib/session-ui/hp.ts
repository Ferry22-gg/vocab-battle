/**
 * Pure HP-bar math for the Session UI (P2 spec, "Enemy HP" -- bar only,
 * never a number/percentage in the UI copy itself; this value only drives
 * the bar's width and an aria-valuenow for assistive tech).
 */
export function clampHpPercent(hp: number, maxHp: number): number {
  if (maxHp <= 0) return 0;
  return Math.max(0, Math.min(100, (hp / maxHp) * 100));
}
