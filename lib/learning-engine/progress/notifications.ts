/**
 * Pure eligibility predicates for the two non-blocking Phase 9 mastery
 * notifications (spec sections 15/25.1, "Card Mastery Notification" /
 * "Full Mastery Achievement"). Deliberately pure before/after comparisons,
 * not state owners -- the caller must supply both the before and after
 * authoritative values from a single trusted transition, never two
 * independently-fetched reads (which could race against a concurrent
 * answer and produce a false positive/negative).
 *
 * RUNTIME CUTOVER WIRING POINT: nothing in this codebase calls either
 * function yet, and no component renders their matching presentation
 * pieces (app/session/mastery-toast.tsx) yet. Today's live
 * commit_answer_transaction() (legacy, pre-cutover) does not expose:
 *   - a per-answer ACQUIRED -> LEARNED transition (card_status never
 *     becomes 'ACQUIRED' under the live legacy write path at all today), or
 *   - a live has_achieved_full_mastery false -> true transition
 *     (user_deck_learning_state.has_achieved_full_mastery is a write-once
 *     backfilled column today, never updated by any live answer path --
 *     see docs/LEARNING_ENGINE_V1_RUNTIME_CUTOVER_TODO.md).
 * A future trusted v1 answer-commit path must supply both functions with
 * real before/after values from that same transaction before either
 * presentation component is wired into app/session/session-screen.tsx --
 * the same way DailyGoalFx is wired there today from submitAnswer()'s
 * `data.dailyGoalJustCompleted`.
 */

import type { CardStatus } from "@/lib/learning-engine/state";

/**
 * True only on the exact ACQUIRED -> LEARNED transition (spec section
 * 15.2) -- never on any other pair, including LEARNED -> LEARNED (already
 * mastered, no new notification) or a transition into ACQUIRED itself
 * (same-day acquisition is explicitly not long-term mastery, spec section
 * 3.1).
 */
export function shouldShowCardMasteredToast(before: CardStatus, after: CardStatus): boolean {
  return before === "ACQUIRED" && after === "LEARNED";
}

/**
 * True only on the exact false -> true transition (spec section 25.1) --
 * never retriggers once already true, including a later 499/500 -> 500/500
 * recovery (spec section 25.1: "If the deck later drops from 500/500 to
 * 499/500, do not clear the flag").
 */
export function shouldShowFullMasteryToast(
  hasAchievedFullMasteryBefore: boolean,
  hasAchievedFullMasteryAfter: boolean,
): boolean {
  return !hasAchievedFullMasteryBefore && hasAchievedFullMasteryAfter;
}
