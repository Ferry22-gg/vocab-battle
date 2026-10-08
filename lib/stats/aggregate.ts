/**
 * Pure calculation helpers for the Stats screen (P3, docs/MVP_SPEC_FOR_CLAUDE.md
 * section 29 / docs/DATABASE_SCHEMA.md 4.9). Mirrors the split already used by
 * lib/home/level-progress.ts: this module contains no I/O and no Supabase
 * calls at all -- lib/stats/dal.ts owns every read, then hands the raw rows
 * here for date-window/aggregation math so that math is unit-testable without
 * a database.
 *
 * All day-boundary math uses Asia/Tokyo calendar dates (`YYYY-MM-DD` strings,
 * matching `daily_user_stats.stat_date`'s own type and the app's existing
 * convention in lib/learning/daily-goal-dal.ts's `todayInTokyo()`), never
 * server-local/UTC day boundaries.
 */

import type { CardStatus } from "@/lib/learning-engine/state";

export interface DailyStatsRow {
  readonly stat_date: string;
  readonly total_answers: number;
  readonly correct_answers: number;
  readonly longest_combo: number;
  readonly xp_gained: number;
}

export interface WeeklyActivityDay {
  /** `YYYY-MM-DD` (Asia/Tokyo calendar date). */
  readonly date: string;
  /** Narrow weekday label (e.g. "M", "T", "W") for a compact 7-column display. */
  readonly label: string;
  /** Answers committed that day -- the Alpha Stats redesign's chosen "This Week" metric (simple, always meaningful even for a tester who hasn't yet defeated an enemy that day). */
  readonly answers: number;
}

/**
 * Returns the 7 Asia/Tokyo calendar dates of the CURRENT Monday->Sunday
 * week containing `todayIso` (Stats Alpha polish A1: "This Week" means the
 * literal calendar week, not a rolling last-7-days window) -- Monday
 * first, Sunday last, as `YYYY-MM-DD` strings. A date later in the week
 * than `todayIso` (a future day within the same calendar week) is still
 * included -- `buildWeeklyActivity` below renders it as a zero/empty bar,
 * since no `daily_user_stats` row can exist for a day that hasn't
 * happened yet.
 *
 * `todayIso` is parsed as plain Y/M/D components and re-expressed via
 * `Date.UTC` -- since a `DATE` column (and `todayInTokyo()`'s own output)
 * carries no time-of-day or timezone information, treating it as a
 * UTC-midnight instant for pure calendar-day arithmetic is safe and
 * introduces no additional timezone conversion (the Asia/Tokyo offset was
 * already resolved once, by whoever produced `todayIso`).
 *
 * Monday is computed via `getUTCDay()` (0=Sunday..6=Saturday) by
 * subtracting `(dayOfWeek + 6) % 7` days -- Monday itself maps to 0 days
 * back, Sunday to 6 days back, correctly handling a month/year boundary
 * anywhere in the week since the subtraction operates on the millisecond
 * instant, not the calendar fields directly.
 */
export function currentTokyoWeekDates(todayIso: string): string[] {
  const [year, month, day] = todayIso.split("-").map(Number);
  const todayUtcMs = Date.UTC(year, month - 1, day);
  const oneDayMs = 24 * 60 * 60 * 1000;

  const dayOfWeek = new Date(todayUtcMs).getUTCDay(); // 0=Sunday..6=Saturday
  const daysSinceMonday = (dayOfWeek + 6) % 7; // Monday=0, Tuesday=1, ..., Sunday=6
  const mondayUtcMs = todayUtcMs - daysSinceMonday * oneDayMs;

  return Array.from({ length: 7 }, (_, i) => new Date(mondayUtcMs + i * oneDayMs).toISOString().slice(0, 10));
}

const WEEKDAY_LABEL_FORMATTER = new Intl.DateTimeFormat("en-US", { weekday: "narrow", timeZone: "UTC" });

/**
 * Maps the current Monday->Sunday week's dates (currentTokyoWeekDates)
 * onto each date's `total_answers` count, defaulting to 0 for a date with
 * no `daily_user_stats` row (never seen activity that day, including a
 * future day within the same week). Answers is the Alpha Stats redesign's
 * chosen "This Week" metric -- simple, deck-agnostic, and always
 * meaningful even on a day with no enemy defeats. Weekday labels are
 * derived from each date itself (via `Date.UTC`, matching
 * `currentTokyoWeekDates`'s own construction) -- with Monday-first input
 * dates, this naturally produces "M T W T F S S", never relying on a
 * fixed header string.
 */
export function buildWeeklyActivity(dates: readonly string[], rows: readonly DailyStatsRow[]): WeeklyActivityDay[] {
  const answersByDate = new Map(rows.map((row) => [row.stat_date, row.total_answers]));

  return dates.map((date) => {
    const [year, month, day] = date.split("-").map(Number);
    return {
      date,
      label: WEEKDAY_LABEL_FORMATTER.format(new Date(Date.UTC(year, month - 1, day))),
      answers: answersByDate.get(date) ?? 0,
    };
  });
}

/**
 * `correct / total` as a rounded whole-number percent, or `null` when the
 * tester has never submitted a graded answer -- callers must render that as
 * a safe empty state ("No answers yet"/"--"), never a misleading `0%`
 * (MVP_SPEC_FOR_CLAUDE.md section 29's zero/empty-state requirement).
 */
export function computeAccuracyPercent(totalAnswers: number, correctAnswers: number): number | null {
  if (totalAnswers <= 0) {
    return null;
  }
  return Math.round((correctAnswers / totalAnswers) * 100);
}

/**
 * Lifetime "Best Combo" -- the highest `daily_user_stats.longest_combo`
 * (itself a per-day max, updated via `greatest()` in
 * commit_answer_transaction()) across every day the tester has recorded
 * activity. Returns `null` only when there is no `daily_user_stats` history
 * at all (never studied yet) -- a genuine `0` (studied, but never landed two
 * correct answers in a row) is a real value, not an empty state.
 */
export function computeBestCombo(rows: readonly Pick<DailyStatsRow, "longest_combo">[]): number | null {
  if (rows.length === 0) {
    return null;
  }
  return rows.reduce((max, row) => Math.max(max, row.longest_combo), 0);
}

/**
 * "Most Answers in a Day" (Personal Best): `max(daily_user_stats.total_answers)`
 * across every day the tester has recorded activity. Returns `0` (not
 * `null`) for no history at all -- unlike computeBestCombo, the Personal
 * Best UI section wants a sensible zero/empty state for a brand-new
 * tester, not a dash; see app/stats/personal-best-card.tsx.
 */
export function computeMostAnswersInADay(rows: readonly Pick<DailyStatsRow, "total_answers">[]): number {
  return rows.reduce((max, row) => Math.max(max, row.total_answers), 0);
}

/** "Most XP in a Day" (Personal Best): `max(daily_user_stats.xp_gained)` across every day with recorded activity. `0` for no history, same empty-state convention as computeMostAnswersInADay. */
export function computeMostXpInADay(rows: readonly Pick<DailyStatsRow, "xp_gained">[]): number {
  return rows.reduce((max, row) => Math.max(max, row.xp_gained), 0);
}

/** "Study Days" (Lifetime): the number of distinct Asia/Tokyo calendar dates with at least one committed answer -- exactly `rows.length`, since a `daily_user_stats` row is only ever created (`on conflict do nothing` from the trusted commit transaction) the first time a tester answers on a given day. */
export function computeStudyDays(rows: readonly unknown[]): number {
  return rows.length;
}

// =============================================================================
// Estimated Study Time (Alpha-safe approximation -- see lib/stats/dal.ts's
// own header for the full audit this implements)
// =============================================================================
//
// `answer_events.response_time_ms` measures card-front-shown -> Reveal
// tapped, client-side (`performance.now()`), for every answer. It is the
// only genuinely live per-answer timing signal in this schema --
// `sessions.active_duration_sec`/`daily_user_stats.active_duration_sec` are
// never written by any trusted workflow (grep confirms no writer beyond
// each column's `default 0`), so they are deliberately not used here.
//
// This is explicitly an ESTIMATE, not a precise timer, for two reasons that
// pull in opposite directions and are NOT compensated for with an
// arbitrary multiplier:
//   - it UNDERCOUNTS: the reveal -> grade ("read the answer") phase is
//     never timed anywhere in this codebase, so true engaged time is
//     always somewhat larger than this number.
//   - it can OVERCOUNT per-answer: `performance.now()` keeps advancing
//     while a tab is backgrounded (no `visibilitychange` handling resets
//     it), so revealing a card and walking away before grading would
//     otherwise report that single answer's full idle duration.
//     STUDY_TIME_PER_ANSWER_CAP_MS bounds the damage a single such event
//     can do, nothing more -- it does not "fix" the number into an
//     accurate measurement.

/** Ceiling on one answer's contribution to Estimated Study Time (ms) -- protects the aggregate against an idle/backgrounded-tab outlier inflating a single `response_time_ms` value. Named/documented per the audit's own explicit requirement; never adjusted to "compensate" for the reveal->grade undercount described above. */
export const STUDY_TIME_PER_ANSWER_CAP_MS = 60_000;

/**
 * The shape Today's Answers/Study-Time/Words-Studied/Words-Learned all
 * need from one `answer_events` row -- one query
 * (lib/stats/dal.ts's getAnswerHistory()) feeds every one of these
 * functions, never a separate round trip per metric.
 */
export interface AnswerHistoryRow {
  readonly answered_at: string;
  readonly response_time_ms: number | null;
  readonly card_id: string;
  readonly card_status_before: string;
  readonly card_status_after: string;
}

/** Defensive per-answer cap: null/undefined/non-finite/negative values contribute 0 (never thrown, never a fabricated positive number) rather than corrupting the sum; a valid value is capped at STUDY_TIME_PER_ANSWER_CAP_MS. */
function cappedAnswerDurationMs(responseTimeMs: number | null | undefined): number {
  if (typeof responseTimeMs !== "number" || !Number.isFinite(responseTimeMs) || responseTimeMs < 0) {
    return 0;
  }
  return Math.min(responseTimeMs, STUDY_TIME_PER_ANSWER_CAP_MS);
}

/** The Asia/Tokyo calendar date (`YYYY-MM-DD`) a timestamptz string falls on, or `null` for an unparseable value -- matches `todayInTokyo()`'s own `Intl.DateTimeFormat` technique, applied to an arbitrary instant instead of "now". Never throws on a malformed string (an `Invalid Date` would otherwise throw inside `Intl.DateTimeFormat.format`). */
function tokyoCalendarDateOf(answeredAtIso: string): string | null {
  const instant = new Date(answeredAtIso);
  if (Number.isNaN(instant.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(instant);
}

/** Lifetime Estimated Study Time: the capped sum over every row given, regardless of date. Empty input sums to 0. */
export function computeEstimatedStudyTimeMs(rows: readonly Pick<AnswerHistoryRow, "response_time_ms">[]): number {
  return rows.reduce((sum, row) => sum + cappedAnswerDurationMs(row.response_time_ms), 0);
}

/** Today's Estimated Study Time: the same capped sum, restricted to rows whose `answered_at` falls on `todayIso`'s Asia/Tokyo calendar date -- never a previous Tokyo day, regardless of the server's own local timezone. */
export function computeTodayEstimatedStudyTimeMs(
  rows: readonly Pick<AnswerHistoryRow, "answered_at" | "response_time_ms">[],
  todayIso: string,
): number {
  const todaysRows = rows.filter((row) => tokyoCalendarDateOf(row.answered_at) === todayIso);
  return computeEstimatedStudyTimeMs(todaysRows);
}

/**
 * Today's "Words Studied": the number of DISTINCT cards presented/answered
 * during `todayIso`'s Asia/Tokyo calendar day -- a card answered 3 times
 * today still counts once, unlike Today Answers (every commit counts).
 */
export function computeTodayUniqueWordsStudied(rows: readonly Pick<AnswerHistoryRow, "answered_at" | "card_id">[], todayIso: string): number {
  const cardIds = new Set<string>();
  for (const row of rows) {
    if (tokyoCalendarDateOf(row.answered_at) === todayIso) {
      cardIds.add(row.card_id);
    }
  }
  return cardIds.size;
}

/**
 * Today's "Words Learned": the number of DISTINCT cards whose
 * `card_status` transitioned INTO `ACQUIRED` (the user-facing "Learned"
 * tier -- see computeLearningProgress's own doc comment for the full
 * backend->user-facing mapping) during `todayIso`'s Asia/Tokyo calendar
 * day. A card that reaches ACQUIRED more than once today (e.g. lapses back
 * to FORGOTTEN then re-qualifies the same day) still counts once.
 * Reconstructed entirely from `answer_events.card_status_before/after`,
 * which both legacy and v1 commit paths have always populated -- no new
 * historical instrumentation needed.
 */
export function computeTodayWordsLearned(
  rows: readonly Pick<AnswerHistoryRow, "answered_at" | "card_id" | "card_status_before" | "card_status_after">[],
  todayIso: string,
): number {
  const cardIds = new Set<string>();
  for (const row of rows) {
    if (row.card_status_after === "ACQUIRED" && row.card_status_before !== "ACQUIRED" && tokyoCalendarDateOf(row.answered_at) === todayIso) {
      cardIds.add(row.card_id);
    }
  }
  return cardIds.size;
}

/**
 * Formats a millisecond duration for display (Stats Alpha polish A4):
 *   - exactly 0ms: `"0 min"` -- genuinely no estimated study time at all.
 *   - >0ms and <60,000ms: `"<1 min"` -- a real, nonzero duration (e.g. 35s)
 *     that would otherwise floor to "0 min" and misleadingly look
 *     identical to true zero. Never rounds a real nonzero duration up to
 *     "1 min" either -- "<1 min" is the honest middle ground.
 *   - >=60,000ms: unchanged existing minute/hour formatting, always
 *     floored to whole minutes (never rounds up past the number of
 *     minutes actually studied).
 *
 * Applies identically to both Today and Lifetime Estimated Study Time --
 * the underlying capped `response_time_ms` sum (STUDY_TIME_PER_ANSWER_CAP_MS,
 * no multiplier, no reveal->grade estimation) is unchanged by this polish;
 * only the display string changes.
 */
export function formatEstimatedStudyTime(ms: number): string {
  if (ms <= 0) {
    return "0 min";
  }
  if (ms < 60_000) {
    return "<1 min";
  }
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

// =============================================================================
// Learning Progress (current card-state snapshot, for one deck)
// =============================================================================

/**
 * Backend `card_status`/`relearning_phase` -> user-facing Learning Progress
 * tier mapping (Alpha Stats redesign, section 2 of the task brief):
 *
 *   New      = backend NEW
 *   Learning = backend LEARNING, AND backend FORGOTTEN (see below)
 *   Learned  = backend ACQUIRED only
 *   Mastered = backend LEARNED only
 *
 * FORGOTTEN is not one of the four requested tiers, but a FORGOTTEN card
 * is actively being relearned (closer in spirit to "Learning" than to any
 * other tier) -- folding it into `learningCount` keeps the four displayed
 * tiles summing to `totalCards` exactly, rather than silently omitting a
 * real card from every tile (which would look like missing/incorrect
 * counts). This is a presentation-bucket decision, not a scheduler concept
 * change -- nothing about Learning Engine state itself is touched.
 *
 * ---------------------------------------------------------------------
 * `headlineLearnedCount` vs. the "Learned" tile (`learnedCount`) -- DO
 * NOT CONFLATE, and do not "fix" the overlap below; it is intentional
 * (Stats Alpha polish A3)
 * ---------------------------------------------------------------------
 * The progress-bar headline ("X / total Learned") and the "Learned" TILE
 * directly beneath it are DIFFERENT numbers by design:
 *
 *   - `learnedCount` (the "Learned" tile): backend ACQUIRED ONLY.
 *   - `headlineLearnedCount` (the headline numerator): backend
 *     ACQUIRED + LEARNED, i.e. `learnedCount + masteredCount`.
 *
 * Mastered is an ADVANCED state beyond Learned, not a separate,
 * unrelated category -- a Mastered card was learned first, and still
 * counts as "having learned the word" even after it advances further.
 * So the headline is deliberately the BROADER, inclusive count: a tester
 * progressing a card from Learned to Mastered must see the headline STAY
 * THE SAME (never appear to lose progress) while the Learned tile goes
 * down by one and the Mastered tile goes up by one. This is why
 * `headlineLearnedCount` can -- and normally does -- equal
 * `learnedCount + masteredCount` exactly; that equality is the intended
 * behavior, not a bug to reconcile.
 *
 * It can still legitimately DECREASE if a Mastered (or Learned) card
 * lapses back to FORGOTTEN (a real, accepted outcome --
 * lib/learning-engine/progress/deck-progress.ts's own header documents
 * the identical "a lapse may reduce progress; that is allowed" precedent)
 * -- this is correct, not a bug, and is exactly why the headline is
 * framed as a present-tense snapshot ("words you have learned, as of
 * right now"), never a monotonic "total ever learned" counter.
 */
export interface LearningProgressCounts {
  readonly totalCards: number;
  readonly newCount: number;
  readonly learningCount: number;
  /** The "Learned" tile -- backend ACQUIRED ONLY, deliberately NOT the same number as `headlineLearnedCount` below. */
  readonly learnedCount: number;
  /** The "Mastered" tile -- backend LEARNED ONLY. */
  readonly masteredCount: number;
  /**
   * The progress-bar headline numerator ("X / total Learned"):
   * `learnedCount + masteredCount` (backend ACQUIRED + LEARNED). See this
   * interface's own doc comment above for why this is intentionally
   * BROADER than the "Learned" tile alone, and must stay that way.
   */
  readonly headlineLearnedCount: number;
}

/** Builds Learning Progress tile counts from the current `card_status` of every live (non-soft-deleted) card in one deck. Empty input (a deck somehow presented with zero cards) yields all-zero counts, never a divide-by-zero -- callers render the progress bar at 0% in that case. */
export function computeLearningProgress(cardStatuses: readonly CardStatus[]): LearningProgressCounts {
  let newCount = 0;
  let learningCount = 0;
  let learnedCount = 0;
  let masteredCount = 0;

  for (const status of cardStatuses) {
    switch (status) {
      case "NEW":
        newCount += 1;
        break;
      case "LEARNING":
      case "FORGOTTEN":
        learningCount += 1;
        break;
      case "ACQUIRED":
        learnedCount += 1;
        break;
      case "LEARNED":
        masteredCount += 1;
        break;
    }
  }

  return {
    totalCards: cardStatuses.length,
    newCount,
    learningCount,
    learnedCount,
    masteredCount,
    // Deliberately ACQUIRED + LEARNED, not ACQUIRED alone -- see this
    // module's own doc comment on LearningProgressCounts for why Mastered
    // cards must still count toward the headline.
    headlineLearnedCount: learnedCount + masteredCount,
  };
}
