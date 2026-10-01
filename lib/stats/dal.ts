/**
 * Read-only Stats DAL (P3, docs/MVP_SPEC_FOR_CLAUDE.md section 29). Reuses
 * every authoritative source Home already reads rather than inventing
 * parallel counters:
 *
 * - Level / XP / Day Streak / lifetime Enemies Defeated: `profiles`, via
 *   lib/profile/dal.ts's getProfileStats() -- the exact same read Home uses.
 * - Weekly activity / Accuracy / Best Combo: `daily_user_stats`, the
 *   trusted per-day aggregate table commit_answer_transaction() alone
 *   writes (docs/DATABASE_SCHEMA.md 4.9) -- summed/maxed here in
 *   TypeScript rather than re-scanning raw `answer_events`.
 * - Cards Mastered: `user_card_progress.card_status = 'LEARNED'`, the
 *   product's one authoritative mastery definition (DATABASE_SCHEMA.md 4.4,
 *   MVP_SPEC_FOR_CLAUDE.md section 8) -- joined against `cards` to exclude
 *   soft-deleted cards, matching the existing product rule that a
 *   soft-deleted card is excluded from mastery-driven flows even while its
 *   `user_card_progress` row stays LEARNED (see
 *   supabase/tests/012_soft_delete_test.sql's review-queue exclusion case).
 *
 * Total Study Time is deliberately NOT read or computed here: neither
 * `sessions.active_duration_sec` nor `daily_user_stats.active_duration_sec`
 * is ever written by any trusted workflow in this codebase (grep confirms
 * no writer beyond each column's `default 0`), so there is no persisted,
 * trustworthy duration signal for it yet. See the Stats implementation
 * report for the full gap writeup.
 *
 * Uses the caller's ordinary authenticated/RLS-scoped Supabase client
 * (lib/supabase/server.ts) throughout -- never service-role, matching every
 * other DAL in this codebase. No function here accepts or forwards a user
 * id; identity always comes from the authenticated request's own session.
 */

import { createClient } from "@/lib/supabase/server";
import { getProfileStats } from "@/lib/profile/dal";
import { todayInTokyo } from "@/lib/learning/daily-goal-dal";
import {
  lastNTokyoDates,
  buildWeeklyActivity,
  computeAccuracyPercent,
  computeBestCombo,
  type DailyStatsRow,
  type WeeklyActivityDay,
} from "@/lib/stats/aggregate";

/** Rolling window size for the "This Week" activity strip (MVP_SPEC_FOR_CLAUDE.md section 29 / P3 spec section 5). */
export const WEEKLY_ACTIVITY_WINDOW_DAYS = 7;

const DAILY_STATS_COLUMNS = "stat_date, enemies_defeated, total_answers, correct_answers, longest_combo";

/**
 * Reads every `daily_user_stats` row the caller has, unfiltered by date.
 * Scoped entirely by RLS (`daily_user_stats_select_own_or_admin`: `user_id
 * = auth.uid() or is_admin()`) -- no explicit `user_id` filter, same
 * no-client-supplied-identity convention as the rest of this codebase.
 *
 * Deliberately unbounded rather than date-limited: at Alpha/Beta scale
 * (docs/MVP_SPEC_FOR_CLAUDE.md section 33, 3-5 day Alpha / ~14 day Beta)
 * this is at most a few dozen rows per tester, one row per calendar day
 * they were ever active -- fetching them all in one query serves both the
 * 7-day weekly strip and the lifetime accuracy/best-combo sums without a
 * second round trip or any pagination machinery this scale doesn't need.
 */
export async function getDailyStatsHistory(): Promise<DailyStatsRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("daily_user_stats")
    .select(DAILY_STATS_COLUMNS)
    .order("stat_date", { ascending: true });

  if (error) {
    throw new Error("Failed to load daily stats history", { cause: error });
  }

  return data ?? [];
}

/**
 * Counts the caller's mastered (LEARNED) cards, excluding any card the
 * tester has since soft-deleted (`cards.deleted_at`). Fetches the joined
 * `deleted_at` flag and filters/counts in TypeScript rather than a
 * `head: true` count with a nested-relationship filter -- at Alpha/Beta
 * per-tester card-library scale (~100-200 cards) this is simpler and more
 * obviously correct than relying on PostgREST's embedded-resource filter
 * semantics under a `count`-only query, and it is the same "fetch then
 * reduce in TS" shape lib/decks/dal.ts already uses for card counts.
 *
 * The `cards!inner(...)` join is visible under RLS for every row this
 * query can return: a `user_card_progress` row only ever exists for a card
 * the tester's own `cards_select_own_or_official_or_admin` policy already
 * lets them read (their own duplicated copy, or an official template), so
 * the inner join never silently drops a row the count should include.
 */
export async function getMasteredCardCount(): Promise<number> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_card_progress")
    .select("cards!inner(deleted_at)")
    .eq("card_status", "LEARNED");

  if (error) {
    throw new Error("Failed to count mastered cards", { cause: error });
  }

  const rows = (data ?? []) as unknown as readonly { cards: { deleted_at: string | null } }[];
  return rows.filter((row) => row.cards.deleted_at === null).length;
}

export interface StatsSummary {
  readonly level: number;
  readonly totalXp: number;
  readonly currentStreak: number;
  readonly totalEnemiesDefeated: number;
  readonly cardsMastered: number;
  /** Rounded whole-number percent, or `null` if the tester has never submitted a graded answer. */
  readonly accuracyPercent: number | null;
  /** Highest combo ever recorded, or `null` if the tester has no `daily_user_stats` history at all. */
  readonly bestCombo: number | null;
  /** Oldest-first, always exactly `WEEKLY_ACTIVITY_WINDOW_DAYS` entries. */
  readonly weeklyActivity: readonly WeeklyActivityDay[];
}

/**
 * Assembles the full Stats screen's read model from three independent,
 * parallel reads (docs/DATABASE_SCHEMA.md section 14: "prefer one cohesive
 * Stats DAL/read model" -- this is that model; each underlying read is
 * itself a single query, so this is three round trips total, not N+1).
 */
export async function getStatsSummary(): Promise<StatsSummary> {
  const [profileStats, dailyStats, cardsMastered] = await Promise.all([
    getProfileStats(),
    getDailyStatsHistory(),
    getMasteredCardCount(),
  ]);

  const totalAnswers = dailyStats.reduce((sum, row) => sum + row.total_answers, 0);
  const correctAnswers = dailyStats.reduce((sum, row) => sum + row.correct_answers, 0);
  const weeklyDates = lastNTokyoDates(WEEKLY_ACTIVITY_WINDOW_DAYS, todayInTokyo());

  return {
    level: profileStats.level,
    totalXp: profileStats.totalXp,
    currentStreak: profileStats.currentStreak,
    totalEnemiesDefeated: profileStats.totalEnemiesDefeated,
    cardsMastered,
    accuracyPercent: computeAccuracyPercent(totalAnswers, correctAnswers),
    bestCombo: computeBestCombo(dailyStats),
    weeklyActivity: buildWeeklyActivity(weeklyDates, dailyStats),
  };
}
