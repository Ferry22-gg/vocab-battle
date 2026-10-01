/**
 * Learning Engine v1 -- scheduler position primitives (Phase 6A of the
 * implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section
 * 22.2 ("Critical Due"), and architecture decision 1 ("per-user-deck
 * monotonic scheduler position... one position step = one successfully
 * committed answered question").
 *
 * Pure: no database access, no clock reads (every function here takes
 * whatever position values it needs as plain numbers).
 */

import { CRITICAL_DUE_GLOBAL_QUESTION_WINDOW } from "@/lib/learning-engine/config";

/**
 * Decision 1: "one position step = one successfully committed answered
 * question." The trusted commit path (a later phase) is the only place
 * this is ever actually applied to persisted state -- this function
 * exists so that relationship is named and testable rather than an
 * inline `+ 1` scattered wherever position needs to advance, matching
 * the same-shaped applyCorrectCooldown precedent in
 * lib/learning-engine/active-priority.ts.
 */
export function advanceSchedulerPosition(position: number): number {
  return position + 1;
}

/**
 * Section 22.2: "no Critical Due card has been presented in the last 5
 * global questions."
 *
 * `persistedSchedulerPosition` is the PERSISTED scheduler_position value
 * -- decision 1's "position/count of the most recently committed
 * answered question" (DeckSchedulerState.schedulerPosition, read
 * directly from a snapshot) -- NOT "the position about to be decided".
 * This is deliberate: every real caller (lib/learning-engine/scheduler/
 * snapshot.ts's DeckSchedulerState, and the eventual Phase 6D interrupt
 * orchestration) has the persisted last-completed value on hand, never a
 * pre-incremented "next position" value -- a contract requiring the
 * latter would be an off-by-one footgun baked into the function's own
 * signature, which is exactly what a review caught here (see below).
 * `lastCriticalDuePosition` is the position a Critical Due card was last
 * force-selected at (null if never, for this deck).
 *
 * ---------------------------------------------------------------------
 * Off-by-one, derived explicitly from the persisted-position contract
 * (caught in review; an earlier version of this function took "the
 * position about to be decided" instead, which is mathematically
 * equivalent only if every caller remembers to pre-add 1 -- a trap
 * exactly as dangerous as the bug it would have hidden)
 * ---------------------------------------------------------------------
 * If Critical Due was presented at position P, and the persisted
 * scheduler_position is S, the "5 most recently completed questions" are
 * positions {S-4, S-3, S-2, S-1, S} (S itself is a completed question).
 * P counts as "in the last 5" exactly when S-4 <= P <= S, i.e. when
 * S - P <= 4 -- NOT <= 5. Concretely, with P=10:
 *   S = P+4 = 14: diff=4 <= 4 -> still within the last 5 -> do not force yet.
 *   S = P+5 = 15: diff=5 <= 4 is false -> P is no longer within the last
 *                 5 completed questions -> the NEXT question (S+1 = 16)
 *                 must be eligible for the Critical Due interrupt.
 * The threshold is therefore CRITICAL_DUE_GLOBAL_QUESTION_WINDOW - 1
 * (4), not the window size itself (5) -- the asymmetry from
 * lib/learning-engine/active-priority.ts's applyCorrectCooldown (whose
 * "+1" correction this function's docstring previously, incorrectly,
 * assumed would carry over unchanged) comes from that function computing
 * a FUTURE target position from a trigger event, whereas this function
 * compares a PERSISTED-AS-OF-NOW position against a trigger event that
 * already happened -- same underlying inclusive-counting principle,
 * different placement of the "+1" because the two functions' inputs
 * sit on opposite sides of the comparison.
 */
export function hasCriticalDueAppearedRecently(
  persistedSchedulerPosition: number,
  lastCriticalDuePosition: number | null,
): boolean {
  if (lastCriticalDuePosition === null) {
    return false;
  }
  return persistedSchedulerPosition - lastCriticalDuePosition <= CRITICAL_DUE_GLOBAL_QUESTION_WINDOW - 1;
}
