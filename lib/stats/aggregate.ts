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

export interface DailyStatsRow {
  readonly stat_date: string;
  readonly enemies_defeated: number;
  readonly total_answers: number;
  readonly correct_answers: number;
  readonly longest_combo: number;
}

export interface WeeklyActivityDay {
  /** `YYYY-MM-DD` (Asia/Tokyo calendar date). */
  readonly date: string;
  /** Narrow weekday label (e.g. "M", "T", "W") for a compact 7-column display. */
  readonly label: string;
  readonly enemiesDefeated: number;
}

/**
 * Returns the last `n` Asia/Tokyo calendar dates ending at `todayIso`
 * (inclusive), oldest first, as `YYYY-MM-DD` strings. `todayIso` is parsed
 * as plain Y/M/D components and re-expressed via `Date.UTC` -- since a
 * `DATE` column (and `todayInTokyo()`'s own output) carries no time-of-day
 * or timezone information, treating it as a UTC-midnight instant for pure
 * calendar-day subtraction is safe and introduces no additional timezone
 * conversion (the Asia/Tokyo offset was already resolved once, by whoever
 * produced `todayIso`).
 */
export function lastNTokyoDates(n: number, todayIso: string): string[] {
  const [year, month, day] = todayIso.split("-").map(Number);
  const todayUtcMs = Date.UTC(year, month - 1, day);
  const oneDayMs = 24 * 60 * 60 * 1000;

  return Array.from({ length: n }, (_, i) => {
    const offsetFromToday = n - 1 - i;
    return new Date(todayUtcMs - offsetFromToday * oneDayMs).toISOString().slice(0, 10);
  });
}

const WEEKDAY_LABEL_FORMATTER = new Intl.DateTimeFormat("en-US", { weekday: "narrow", timeZone: "UTC" });

/**
 * Maps a rolling window of dates onto each date's `enemies_defeated` count,
 * defaulting to 0 for a date with no `daily_user_stats` row (never seen
 * activity that day) -- MVP_SPEC_FOR_CLAUDE.md section 5's "preferred
 * activity measure" (enemies defeated per day, first choice of the
 * documented preference order). Weekday labels are derived from each date
 * itself (via `Date.UTC`, matching `lastNTokyoDates`'s own construction),
 * not a fixed "M T W T F S S" header -- a rolling 7-day window does not
 * necessarily start on a Monday.
 */
export function buildWeeklyActivity(dates: readonly string[], rows: readonly DailyStatsRow[]): WeeklyActivityDay[] {
  const enemiesDefeatedByDate = new Map(rows.map((row) => [row.stat_date, row.enemies_defeated]));

  return dates.map((date) => {
    const [year, month, day] = date.split("-").map(Number);
    return {
      date,
      label: WEEKDAY_LABEL_FORMATTER.format(new Date(Date.UTC(year, month - 1, day))),
      enemiesDefeated: enemiesDefeatedByDate.get(date) ?? 0,
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
