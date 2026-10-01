/**
 * Learning Engine v1 -- retention-aware FSRS adapter (Phase 5 of the
 * implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 14
 * ("FSRS integration").
 *
 * ---------------------------------------------------------------------
 * Why this wraps, rather than reuses, lib/learning/fsrs.ts's advanceFsrs
 * ---------------------------------------------------------------------
 * lib/learning/fsrs.ts's Card<->row conversion (progressToFsrsCard,
 * fsrsCardToUpdate) is pure structural mapping with no retention
 * dependency at all -- genuinely reusable as-is, and reused directly
 * below ("do not unnecessarily rewrite lib/learning/fsrs.ts if it already
 * provides a clean low-level adapter", Phase 5 brief section 15).
 *
 * Its advanceFsrs, however, calls a SINGLE module-scoped `fsrs(FSRS_
 * CONFIG)` scheduler instance constructed once with a fixed
 * request_retention: 0.9 (lib/learning/config.ts's FSRS_CONFIG) -- the
 * legacy engine's one global retention. Learning Engine v1 needs desired
 * retention resolved per user/deck (0.90 default, 0.92 for pain_point =
 * retention_loss -- lib/learning-engine/fsrs/retention.ts), which cannot
 * be expressed by calling that fixed-retention function. advanceFsrsWithRetention
 * below constructs its own ts-fsrs scheduler per call, with the same base
 * settings (enable_fuzz, enable_short_term) imported from the existing
 * FSRS_CONFIG so the only thing that varies is request_retention, then
 * delegates to the same fsrsCardToUpdate for the result mapping -- no
 * duplicated conversion logic.
 *
 * get_retrievability is unaffected by request_retention (verified against
 * ts-fsrs 5.4.2's own implementation: it derives R purely from elapsed
 * time, stability, and the FSRS decay constant -- request_retention only
 * affects *scheduling* an interval, via FSRS.next(), not retrievability
 * computation), so deriveRetrievability below uses one reusable base-
 * config scheduler regardless of which desiredRetention a card's deck
 * resolves to.
 *
 * Keeps "FSRS math separate from Learning Engine lifecycle decisions"
 * (section 5 of the brief): this module never reads/writes card_status,
 * learning_stage, or mastery counters -- see
 * lib/learning-engine/fsrs/lifecycle.ts for where those compose with this
 * module's output.
 */

import { fsrs, Rating } from "ts-fsrs";
import type { Card, Grade } from "ts-fsrs";

import { FSRS_CONFIG } from "@/lib/learning/config";
import {
  fsrsCardToUpdate,
  progressToFsrsCard,
  type UserCardProgressFsrsRow,
  type UserCardProgressFsrsUpdate,
} from "@/lib/learning/fsrs";

// Re-exported so v1 engine callers have one import path for the full
// Card<->row conversion + advance surface, without needing to also reach
// into lib/learning/fsrs.ts directly for the (unchanged, reused) half of
// it.
export { progressToFsrsCard, fsrsCardToUpdate };
export type { UserCardProgressFsrsRow, UserCardProgressFsrsUpdate };

/**
 * One retention-independent scheduler instance for retrievability
 * derivation (see module header for why request_retention does not
 * affect this). Module-scoped like lib/learning/fsrs.ts's own `scheduler`
 * constant, for the same reason: ts-fsrs's `fsrs()` constructor does
 * nontrivial parameter validation/derivation internally, not free to
 * repeat on every call when the inputs never change.
 */
const retrievabilityScheduler = fsrs(FSRS_CONFIG);

/**
 * Section 14.3: current Retrievability, derived at evaluation time rather
 * than persisted as authoritative state ("R may be derived at selection
 * time rather than stored as authoritative state", section 29.1) -- no
 * new `fsrs_r`-style column was added in Phase 1 for this reason. Thin
 * wrapper over ts-fsrs's own get_retrievability (format=false -> a plain
 * number in [0, 1], not the formatted percentage string).
 */
export function deriveRetrievability(card: Card, now: Date): number {
  return retrievabilityScheduler.get_retrievability(card, now, false);
}

/**
 * Section 14.1-14.3: advances one card by one review using a scheduler
 * constructed for this specific `desiredRetention` -- the v1-correct
 * replacement for lib/learning/fsrs.ts's fixed-retention advanceFsrs
 * (see module header). `grade` must be the output of
 * lib/learning-engine/fsrs/rating.ts's mapAnswerToFsrsGrade (or, for a
 * repair/within-day event this module has no opinion on, whatever grade
 * the caller has already decided on) -- this function performs no rating
 * inference of its own.
 *
 * Same Rating.Manual defense-in-depth as lib/learning/fsrs.ts's
 * advanceFsrs -- Grade's own type already excludes it at every normal
 * call site.
 */
export function advanceFsrsWithRetention(
  card: Card,
  now: Date,
  grade: Grade,
  desiredRetention: number,
): UserCardProgressFsrsUpdate {
  if ((grade as Rating) === Rating.Manual) {
    throw new Error("advanceFsrsWithRetention: Manual is not a valid application-supplied grade");
  }

  const scheduler = fsrs({ ...FSRS_CONFIG, request_retention: desiredRetention });
  const { card: nextCard } = scheduler.next(card, now, grade);
  return fsrsCardToUpdate(nextCard);
}
