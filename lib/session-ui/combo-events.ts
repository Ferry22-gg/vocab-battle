/**
 * Derives the occasional, non-blocking "combo up" event for the Session UI
 * (P2 spec, "Combo": no permanent combo display -- combo still exists and
 * affects damage exactly as today via lib/learning/config.ts's
 * COMBO_BONUS_TIERS, but the UI only celebrates a *meaningful* tier
 * increase, and never shows a loss event when combo resets to 0).
 *
 * "Meaningful" = the damage bonus tier itself increases (crossing 3, 5, 7,
 * or 9), not merely combo going up by one within the same tier, and not
 * the very first Correct answer (0 -> 1 stays in the zero-bonus tier).
 * Pure, dependency-free -- reuses the existing central combo config rather
 * than inventing new tier boundaries.
 */

import { COMBO_BONUS_TIERS } from "@/lib/learning/config";

export type ComboEvent = { readonly kind: "combo_up" } | null;

function bonusForCombo(combo: number): number {
  const tier = COMBO_BONUS_TIERS.find((t) => combo >= t.minCombo && combo <= t.maxCombo);
  return tier?.bonus ?? 0;
}

/**
 * `comboBefore`/`comboAfter` are the session's combo value immediately
 * before/after one answer (sessions.current_combo semantics -- see
 * lib/learning/battle.ts). A Wrong answer's comboAfter (0) is never greater
 * than comboBefore, so this always returns null for Wrong without needing
 * a separate `correct` flag.
 */
export function deriveComboEvent(comboBefore: number, comboAfter: number): ComboEvent {
  if (comboAfter <= comboBefore) return null;
  return bonusForCombo(comboAfter) > bonusForCombo(comboBefore) ? { kind: "combo_up" } : null;
}
