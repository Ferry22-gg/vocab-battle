/**
 * Read-only Stats DAL (Alpha Stats redesign; P3, docs/MVP_SPEC_FOR_CLAUDE.md
 * section 29). Reuses every authoritative source Home already reads rather
 * than inventing parallel counters:
 *
 * - Level / XP / Current Streak / Longest Streak / lifetime Enemies
 *   Defeated / selected deck: `profiles`, via lib/profile/dal.ts's
 *   getProfileStats() -- the exact same read Home uses.
 * - Today's Answers/XP, This Week, Personal Best (Best Combo/Most
 *   Answers-in-a-Day/Most XP-in-a-Day), Study Days: `daily_user_stats`,
 *   the trusted per-day aggregate table commit_answer_transaction() alone
 *   writes (docs/DATABASE_SCHEMA.md 4.9) -- summed/maxed here in
 *   TypeScript rather than re-scanning raw `answer_events`.
 * - Words Mastered (lifetime) / Words Learned (lifetime):
 *   `user_card_progress.card_status = 'LEARNED'` / `'ACQUIRED'`, joined
 *   against `cards` to exclude soft-deleted cards (DATABASE_SCHEMA.md 4.4,
 *   MVP_SPEC_FOR_CLAUDE.md section 8) -- deck-agnostic, across every deck
 *   the tester has ever owned, matching Enemies Defeated/Total XP's own
 *   account-wide (not per-deck) scope.
 * - Learning Progress (New/Learning/Learned/Mastered + the "Words Known"
 *   headline): the CURRENT `card_status` of every live card in the
 *   tester's presently SELECTED deck only (`profiles.selected_deck_id`) --
 *   a snapshot, not a lifetime/cumulative count, so progressing then
 *   lapsing a card is reflected honestly (see
 *   lib/stats/aggregate.ts's computeLearningProgress doc comment).
 * - Today's Words Studied / Words Learned, and Study Time (Today +
 *   Lifetime): `answer_events.(answered_at, response_time_ms, card_id,
 *   card_status_before, card_status_after)` -- the only per-answer
 *   history this schema has. Never `sessions.active_duration_sec` or
 *   `daily_user_stats.active_duration_sec`: neither is ever written by any
 *   trusted workflow in this codebase (grep confirms no writer beyond
 *   each column's `default 0`), confirmed by this feature's own audit.
 *   Study Time is explicitly an ESTIMATE (card-front-shown -> Reveal-
 *   tapped time, never the full reveal->grade cycle, capped per answer
 *   against idle/backgrounded-tab outliers) -- see
 *   lib/stats/aggregate.ts's own header for the full accounting of why.
 *
 * Accuracy is still computed here (`accuracyPercent`) for internal/
 * telemetry continuity, but the Alpha Stats redesign does not render it
 * anywhere -- no component in app/stats/ reads this field.
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
  buildWeeklyActivity,
  computeAccuracyPercent,
  computeBestCombo,
  computeEstimatedStudyTimeMs,
  computeLearningProgress,
  computeMostAnswersInADay,
  computeMostXpInADay,
  computeStudyDays,
  computeTodayEstimatedStudyTimeMs,
  computeTodayUniqueWordsStudied,
  computeTodayWordsLearned,
  currentTokyoWeekDates,
  type AnswerHistoryRow,
  type DailyStatsRow,
  type LearningProgressCounts,
  type WeeklyActivityDay,
} from "@/lib/stats/aggregate";
import type { CardStatus } from "@/lib/learning-engine/state";

const DAILY_STATS_COLUMNS = "stat_date, total_answers, correct_answers, longest_combo, xp_gained";

/**
 * Reads every `daily_user_stats` row the caller has, unfiltered by date.
 * Scoped entirely by RLS (`daily_user_stats_select_own_or_admin`: `user_id
 * = auth.uid() or is_admin()`) -- no explicit `user_id` filter, same
 * no-client-supplied-identity convention as the rest of this codebase.
 *
 * Deliberately unbounded rather than date-limited: at Alpha/Beta scale
 * (docs/MVP_SPEC_FOR_CLAUDE.md section 33, 3-5 day Alpha / ~14 day Beta)
 * this is at most a few dozen rows per tester, one row per calendar day
 * they were ever active -- fetching them all in one query serves the
 * 7-day weekly strip, Study Days, Personal Best, and the lifetime
 * accuracy/best-combo sums without a second round trip or any pagination
 * machinery this scale doesn't need.
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
 * Counts the caller's cards currently at `card_status`, excluding any card
 * the tester has since soft-deleted (`cards.deleted_at`), across every
 * deck the tester has ever owned (deck-agnostic -- matches Enemies
 * Defeated/Total XP's own account-wide scope, not Learning Progress's
 * single-deck scope). Fetches the joined `deleted_at` flag and
 * filters/counts in TypeScript rather than a `head: true` count with a
 * nested-relationship filter -- at Alpha/Beta per-tester card-library
 * scale (~100-200 cards) this is simpler and more obviously correct than
 * relying on PostgREST's embedded-resource filter semantics under a
 * `count`-only query, and it is the same "fetch then reduce in TS" shape
 * lib/decks/dal.ts already uses for card counts.
 *
 * The `cards!inner(...)` join is visible under RLS for every row this
 * query can return: a `user_card_progress` row only ever exists for a card
 * the tester's own `cards_select_own_or_official_or_admin` policy already
 * lets them read (their own duplicated copy, or an official template), so
 * the inner join never silently drops a row the count should include.
 */
async function getCardStatusCount(cardStatus: CardStatus): Promise<number> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_card_progress")
    .select("cards!inner(deleted_at)")
    .eq("card_status", cardStatus);

  if (error) {
    throw new Error(`Failed to count cards at status ${cardStatus}`, { cause: error });
  }

  const rows = (data ?? []) as unknown as readonly { cards: { deleted_at: string | null } }[];
  return rows.filter((row) => row.cards.deleted_at === null).length;
}

/** Lifetime "Words Mastered": the product's one authoritative mastery definition (`card_status = 'LEARNED'`), deck-agnostic. */
export async function getMasteredCardCount(): Promise<number> {
  return getCardStatusCount("LEARNED");
}

/** Lifetime "Words Learned": cards currently at `card_status = 'ACQUIRED'` (the user-facing "Learned" tier -- see computeLearningProgress's doc comment), deck-agnostic. */
export async function getAcquiredCardCount(): Promise<number> {
  return getCardStatusCount("ACQUIRED");
}

/**
 * The CURRENT `card_status` of every live (non-soft-deleted) card in one
 * deck -- feeds Learning Progress's New/Learning/Learned/Mastered tiles
 * and the "Words Known" headline. Fetches the tester's full card-progress
 * library (RLS-scoped, same as getCardStatusCount above) and filters to
 * `deckId` in TypeScript rather than an embedded-relationship query filter
 * -- same "simpler, obviously correct at this scale" choice this file
 * already makes elsewhere; at Alpha/Beta scale a tester has at most a
 * couple of decks' worth of rows (~100-200) to filter through.
 */
export async function getLearningProgressForDeck(deckId: string): Promise<CardStatus[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("user_card_progress").select("card_status, cards!inner(deck_id, deleted_at)");

  if (error) {
    throw new Error("Failed to load learning progress", { cause: error });
  }

  const rows = (data ?? []) as unknown as readonly {
    card_status: CardStatus;
    cards: { deck_id: string; deleted_at: string | null };
  }[];

  return rows.filter((row) => row.cards.deck_id === deckId && row.cards.deleted_at === null).map((row) => row.card_status);
}

const ANSWER_HISTORY_COLUMNS = "answered_at, response_time_ms, card_id, card_status_before, card_status_after";

/**
 * Reads `(answered_at, response_time_ms, card_id, card_status_before,
 * card_status_after)` for every answer the caller has ever submitted --
 * the smallest query that can feed Today's Answers/Words-Studied/Words-
 * Learned and both Study Time figures from ONE round trip. Scoped
 * entirely by RLS (`answer_events_select_own_or_admin`: `user_id =
 * auth.uid() or is_admin()`), same no-client-supplied-identity convention
 * as every other read in this file -- never another tester's rows.
 *
 * Deliberately unbounded, same Alpha/Beta-scale reasoning as
 * getDailyStatsHistory() above: at most a few hundred rows per tester for
 * the project's documented Alpha/Beta duration, fetched once rather than
 * paginated or date-limited.
 */
export async function getAnswerHistory(): Promise<AnswerHistoryRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("answer_events").select(ANSWER_HISTORY_COLUMNS);

  if (error) {
    throw new Error("Failed to load answer history", { cause: error });
  }

  return data ?? [];
}

export interface StatsSummary {
  // Top summary (totalXp doubles as the Lifetime section's "Total XP" tile -- it is already a lifetime-cumulative value, never reset, so no separate field is needed for that reuse).
  readonly level: number;
  readonly totalXp: number;
  readonly currentStreak: number;

  // Today
  readonly todayAnswers: number;
  readonly todayWordsStudied: number;
  readonly todayWordsLearned: number;
  readonly todayXp: number;
  /** Estimated Study Time (ms) for the current Asia/Tokyo calendar day -- see this module's header. */
  readonly todayStudyTimeMs: number;

  // Learning Progress (current deck only) -- `null` only in the edge case
  // of no selected deck at all, which requireOnboardedTester() does not
  // actually permit in practice.
  readonly learningProgress: LearningProgressCounts | null;

  // This Week
  /** Monday-first, Sunday-last, always exactly 7 entries -- the current Asia/Tokyo calendar week (Stats Alpha polish A1), never a rolling last-7-days window. */
  readonly weeklyActivity: readonly WeeklyActivityDay[];

  // Personal Best
  /** Highest combo ever recorded, or `null` if the tester has no `daily_user_stats` history at all. */
  readonly bestCombo: number | null;
  readonly longestStreak: number;
  readonly mostAnswersInADay: number;
  readonly mostXpInADay: number;

  // Lifetime
  readonly totalAnswers: number;
  readonly wordsLearnedLifetime: number;
  readonly wordsMasteredLifetime: number;
  readonly studyDays: number;
  readonly totalEnemiesDefeated: number;
  /** Estimated Study Time (ms) across the caller's full answer history -- see this module's header. */
  readonly lifetimeStudyTimeMs: number;

  // Internal/telemetry only -- never rendered (Accuracy must not be shown to users).
  readonly accuracyPercent: number | null;
}

/**
 * Assembles the full Stats screen's read model. `getProfileStats()` must
 * resolve first (Learning Progress needs its `selectedDeckId`), then every
 * remaining read runs in parallel -- two round-trip "waves" total, not N+1.
 */
export async function getStatsSummary(): Promise<StatsSummary> {
  const profileStats = await getProfileStats();

  const [dailyStats, cardsMastered, cardsAcquired, answerHistory, learningProgressStatuses] = await Promise.all([
    getDailyStatsHistory(),
    getMasteredCardCount(),
    getAcquiredCardCount(),
    getAnswerHistory(),
    profileStats.selectedDeckId ? getLearningProgressForDeck(profileStats.selectedDeckId) : Promise.resolve(null),
  ]);

  const totalAnswers = dailyStats.reduce((sum, row) => sum + row.total_answers, 0);
  const correctAnswers = dailyStats.reduce((sum, row) => sum + row.correct_answers, 0);
  const today = todayInTokyo();
  const todayRow = dailyStats.find((row) => row.stat_date === today);
  const weeklyDates = currentTokyoWeekDates(today);

  return {
    level: profileStats.level,
    totalXp: profileStats.totalXp,
    currentStreak: profileStats.currentStreak,

    todayAnswers: todayRow?.total_answers ?? 0,
    todayWordsStudied: computeTodayUniqueWordsStudied(answerHistory, today),
    todayWordsLearned: computeTodayWordsLearned(answerHistory, today),
    todayXp: todayRow?.xp_gained ?? 0,
    todayStudyTimeMs: computeTodayEstimatedStudyTimeMs(answerHistory, today),

    learningProgress: learningProgressStatuses === null ? null : computeLearningProgress(learningProgressStatuses),

    weeklyActivity: buildWeeklyActivity(weeklyDates, dailyStats),

    bestCombo: computeBestCombo(dailyStats),
    longestStreak: profileStats.longestStreak,
    mostAnswersInADay: computeMostAnswersInADay(dailyStats),
    mostXpInADay: computeMostXpInADay(dailyStats),

    totalAnswers,
    wordsLearnedLifetime: cardsAcquired,
    wordsMasteredLifetime: cardsMastered,
    studyDays: computeStudyDays(dailyStats),
    totalEnemiesDefeated: profileStats.totalEnemiesDefeated,
    lifetimeStudyTimeMs: computeEstimatedStudyTimeMs(answerHistory),

    accuracyPercent: computeAccuracyPercent(totalAnswers, correctAnswers),
  };
}
