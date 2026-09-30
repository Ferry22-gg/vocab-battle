/**
 * Read-only Home/progression display data from `profiles`
 * (docs/DATABASE_SCHEMA.md 4.1) -- deliberately separate from
 * lib/auth/dal.ts, which owns only the columns auth/onboarding decisions
 * need. This module owns the opposite slice: display-only progression
 * fields no auth gate ever branches on.
 *
 * Uses the caller's ordinary authenticated/RLS-scoped Supabase client --
 * never service-role. No explicit `id`/`user_id` filter is added: a
 * tester's unfiltered `select` on `profiles` is already scoped to exactly
 * their own row by `profiles_select_own` (grants_and_rls.sql), matching
 * the no-client-supplied-user-id convention used throughout
 * lib/sessions/dal.ts and lib/learning/progress-dal.ts.
 */

import { createClient } from "@/lib/supabase/server";

const PROFILE_STATS_COLUMNS = "total_xp, level, current_streak";

export interface ProfileStats {
  readonly totalXp: number;
  readonly level: number;
  readonly currentStreak: number;
}

/**
 * Reads the caller's own current XP/level/streak. Only ever called after
 * an auth gate (e.g. requireOnboardedTester()) has already established the
 * caller is an authenticated tester with a profile row, so `maybeSingle()`
 * returning `null` here indicates a genuine invariant violation, not a
 * normal "no profile yet" case -- callers should let that surface as a
 * thrown error rather than silently falling back to zeroed stats.
 */
export async function getProfileStats(): Promise<ProfileStats> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_STATS_COLUMNS)
    .maybeSingle<{ total_xp: number; level: number; current_streak: number }>();

  if (error) {
    throw new Error("Failed to load profile stats", { cause: error });
  }

  if (!data) {
    throw new Error("getProfileStats: no profile row for an already-authenticated tester");
  }

  return {
    totalXp: data.total_xp,
    level: data.level,
    currentStreak: data.current_streak,
  };
}
