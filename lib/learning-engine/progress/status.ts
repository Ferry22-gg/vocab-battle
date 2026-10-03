/**
 * Pure user-facing card-status mapping (spec section 4, "User-facing status
 * mapping"). The ONLY place this derivation may happen -- every caller that
 * needs to show a learner a status label must go through
 * toUserFacingCardStatus() rather than branching on CardStatus directly, so
 * ACQUIRED/FORGOTTEN never leak to the UI as literal backend names (spec
 * section 4's rationale: ACQUIRED isn't intuitive learner-facing language,
 * and FORGOTTEN reads as a punitive static label where RELEARNING reads as
 * an active recovery process).
 *
 * This derives a label from authoritative backend state on every call -- it
 * is not a second persisted display-state machine (spec section 4: "Do not
 * persist a second independent display-state machine. Derive the label
 * from backend state.").
 *
 * card_status is already live, authoritative data today (the CHECK
 * constraint was widened to allow 'ACQUIRED' by
 * supabase/migrations/20261001000000_learning_engine_v1_additive_schema.sql,
 * but the column itself is the same one the legacy runtime has always
 * written) -- this mapping is safe to wire into the UI now, even though the
 * live legacy runtime never actually produces 'ACQUIRED' until Runtime
 * Cutover (see docs/LEARNING_ENGINE_V1_RUNTIME_CUTOVER_TODO.md).
 */

import type { CardStatus } from "@/lib/learning-engine/state";

export type UserFacingCardStatus = "NEW" | "LEARNING" | "LEARNED" | "MASTERED" | "RELEARNING";

/** Spec section 4's exact table. */
const USER_FACING_CARD_STATUS = {
  NEW: "NEW",
  LEARNING: "LEARNING",
  ACQUIRED: "LEARNED",
  LEARNED: "MASTERED",
  FORGOTTEN: "RELEARNING",
} as const satisfies Record<CardStatus, UserFacingCardStatus>;

export function toUserFacingCardStatus(cardStatus: CardStatus): UserFacingCardStatus {
  return USER_FACING_CARD_STATUS[cardStatus];
}
