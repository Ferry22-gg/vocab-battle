/**
 * Read-only Daily Goal progress for Home (docs/DATABASE_SCHEMA.md 4.9,
 * "daily_user_stats" + the `daily_goal_progress`/`daily_goal_completed`
 * derivation documented alongside `start_or_resume_session()`: `least(
 * today's daily_user_stats.enemies_defeated, 5)` / today's
 * `daily_user_stats.daily_goal_completed`, or the zero/false default when
 * no row exists yet today). This module mirrors that exact read for a
 * context where no session is necessarily active -- it does not change or
 * reimplement the Daily Goal rule itself, which remains owned entirely by
 * commit_answer_transaction() in Postgres.
 *
 * Uses the caller's ordinary authenticated/RLS-scoped Supabase client --
 * never service-role. `daily_user_stats` is SELECT-only for `authenticated`
 * at the grant level, RLS-scoped to `user_id = auth.uid() or is_admin()`
 * (grants_and_rls.sql); no explicit `user_id` filter is added here, same
 * convention as every other DAL in this codebase.
 */

import { createClient } from "@/lib/supabase/server";

/** Daily Goal = defeat 5 enemies (MVP_UI_SPEC.md section 9). Mirrors the same literal already used in the `daily_goal_progress` derivation, not a new rule. */
export const DAILY_GOAL_TARGET = 5;

export interface DailyGoalProgress {
  readonly enemiesDefeated: number;
  readonly completed: boolean;
}

/**
 * `YYYY-MM-DD` for "today" in Asia/Tokyo, matching `daily_user_stats.stat_date`'s
 * documented calendar. Exported so other modules sharing this exact
 * day-boundary convention (e.g. lib/stats/dal.ts's weekly activity window)
 * reuse this single implementation rather than re-deriving it.
 */
export function todayInTokyo(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
}

/**
 * Reads the caller's own Daily Goal progress for the current Asia/Tokyo
 * calendar day. Returns the zero/false default (no thrown error) when no
 * `daily_user_stats` row exists yet today -- that is the documented normal
 * case for a tester who hasn't defeated an enemy yet today, not a failure.
 */
export async function getTodayDailyGoalProgress(): Promise<DailyGoalProgress> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("daily_user_stats")
    .select("enemies_defeated, daily_goal_completed")
    .eq("stat_date", todayInTokyo())
    .maybeSingle<{ enemies_defeated: number; daily_goal_completed: boolean }>();

  if (error) {
    throw new Error("Failed to load today's Daily Goal progress", { cause: error });
  }

  if (!data) {
    return { enemiesDefeated: 0, completed: false };
  }

  return {
    enemiesDefeated: Math.min(data.enemies_defeated, DAILY_GOAL_TARGET),
    completed: data.daily_goal_completed,
  };
}
