/**
 * Learning Engine v1 -- Due/Near-Due classification (Phase 5 of the
 * implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 16
 * ("Near-Due layer") and 16.1 ("Eligibility").
 *
 * Pure, unit-agnostic: `computeIntervalProgress` takes `elapsed` and
 * `scheduledInterval` in whatever single consistent unit the caller
 * already has them in (e.g. both in days, matching user_card_progress.
 * fsrs_scheduled_days, or both in milliseconds) -- this module has no
 * opinion on units, only on their ratio.
 */

import type { Card } from "ts-fsrs";

import { NEAR_DUE_END_PROGRESS, NEAR_DUE_START_PROGRESS } from "@/lib/learning-engine/config";

export type DueClassification = "STRONG_OUTSIDE" | "NEAR_DUE" | "FSRS_DUE";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Section 16.1: `interval_progress = elapsed_time_since_last_long_term_
 * review / scheduled_interval`.
 *
 * "Handle invalid/zero interval safely and explicitly" (Phase 5 brief,
 * section 6): a non-positive or non-finite `scheduledInterval`, or a
 * negative/non-finite `elapsed`, has no sensible ratio -- this cannot
 * legitimately occur for a card that has genuinely been through at least
 * one FSRS review (ts-fsrs always produces a positive scheduled
 * interval), but a caller must not get a silent NaN/Infinity, nor a
 * thrown exception that could crash a live selection pass over one bad
 * row. Returns `null` explicitly instead -- the caller (e.g.
 * classifyDueSource) must handle that case explicitly too, not coerce it
 * into a classification that didn't actually apply.
 */
export function computeIntervalProgress(elapsed: number, scheduledInterval: number): number | null {
  if (!Number.isFinite(scheduledInterval) || scheduledInterval <= 0) {
    return null;
  }
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return null;
  }
  return elapsed / scheduledInterval;
}

/**
 * Section 16.1's exact boundaries:
 *
 *   progress < 0.75        -> STRONG_OUTSIDE, not ordinarily selectable
 *   0.75 <= progress < 1.0 -> NEAR_DUE
 *   progress >= 1.0        -> FSRS_DUE
 *
 * `null` (an invalid/zero interval, per computeIntervalProgress) is
 * treated as STRONG_OUTSIDE -- the conservative, safe default: a card
 * this function cannot confidently classify as actually due must not be
 * surfaced as NEAR_DUE/FSRS_DUE, which would make it eligible for Due-
 * weighted selection on the strength of garbage data. This is an
 * explicit choice (per the brief's "do not invent behavior silently"),
 * not a fallthrough default -- a future phase can log/alert on this case
 * distinctly if desired by checking computeIntervalProgress's result
 * directly instead of going through this function.
 */
export function classifyDueSource(intervalProgress: number | null): DueClassification {
  if (intervalProgress === null) {
    return "STRONG_OUTSIDE";
  }
  if (intervalProgress >= NEAR_DUE_END_PROGRESS) {
    return "FSRS_DUE";
  }
  if (intervalProgress >= NEAR_DUE_START_PROGRESS) {
    return "NEAR_DUE";
  }
  return "STRONG_OUTSIDE";
}

/**
 * Bridges a ts-fsrs `Card` (as carried on
 * lib/learning-engine/scheduler/snapshot.ts's SchedulableCardRow.fsrsCard)
 * directly into computeIntervalProgress, in days (matching `scheduled_days`'s
 * own unit) -- added for Phase 6C's per-source selectors
 * (lib/learning-engine/scheduler/due-selection.ts and near-due-
 * selection.ts), which both need this identical conversion and must not
 * each reimplement it.
 *
 * `card.last_review` is `undefined` for a card that has never been
 * through FSRS.next() (ts-fsrs's State.New) -- "elapsed since last
 * review" is meaningless for such a card, so this returns `null` (the
 * same "cannot confidently classify" signal computeIntervalProgress
 * itself uses for an invalid interval) rather than fabricating an
 * elapsed time of 0 or treating it as overdue. In the v1 engine this
 * should not arise for a genuinely OUTSIDE-pool card (ACQUIRED/LEARNED
 * implies at least one real FSRS review), but this function does not
 * assume that invariant holds -- it degrades safely either way.
 */
export function deriveCardIntervalProgress(card: Card, now: Date): number | null {
  if (card.last_review === undefined) {
    return null;
  }
  const elapsedDays = (now.getTime() - card.last_review.getTime()) / MS_PER_DAY;
  return computeIntervalProgress(elapsedDays, card.scheduled_days);
}
