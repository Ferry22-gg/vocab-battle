/**
 * Trusted read-side helpers used by submitAnswer()
 * (lib/learning/submit-answer.ts, docs/DATABASE_SCHEMA.md 10.3). Uses the
 * caller's ordinary authenticated/RLS-scoped Supabase client
 * (lib/supabase/server.ts) -- never service-role: `user_card_progress`,
 * `answer_events`, and `xp_events` are all SELECT-only for `authenticated`
 * at the grant level, scoped by RLS to `user_id = auth.uid() or
 * is_admin()` (grants_and_rls.sql), which is sufficient for every read
 * this module performs. No function here accepts or forwards a user id --
 * identity always comes from the authenticated request's own Supabase
 * session via RLS.
 *
 * Deliberately does not use React's `cache()`: most of these reads feed
 * commit_answer_transaction()'s stale-snapshot comparison (10.3), whose
 * entire purpose is to catch state that changed since it was read.
 *
 * ---
 *
 * Browser trust boundary: the browser sends only `client_event_id`,
 * `session_id`, `card_id`, `correct`, and `response_time_ms`
 * (submit-answer.ts's SubmitAnswerInput). Every other value
 * submitAnswer() needs -- the card's current progress and recent answer
 * history, an existing answer_event/xp_events for an early replay lookup
 * (this module), the session/battle snapshot
 * (lib/sessions/dal.ts's getActiveSessionById), the FSRS Card
 * (lib/learning/fsrs.ts), the estimated rating (lib/learning/rating.ts),
 * and the battle result (lib/learning/battle.ts) -- must come from
 * authenticated server reads or server-side computation, never from the
 * browser. commit_answer_transaction() then independently re-validates
 * ownership and re-derives the deterministic, concurrency-sensitive state
 * itself regardless of what submitAnswer() computed (10.3); this module
 * only supplies the *inputs* to that computation, not the source of
 * truth for it.
 */

import { createClient } from "@/lib/supabase/server";
import { RATING_CONFIG } from "@/lib/learning/config";
import type { UserCardProgressFsrsRow } from "@/lib/learning/fsrs";
import type { CommittedAnswerEventRow, CommittedXpEventRow } from "@/lib/learning/commit-answer";

const PROGRESS_COLUMNS =
  "card_status, seen_count, correct_streak, wrong_streak, " +
  "fsrs_due_at, fsrs_stability, fsrs_difficulty, fsrs_elapsed_days, " +
  "fsrs_scheduled_days, fsrs_reps, fsrs_lapses, fsrs_learning_steps, " +
  "fsrs_state, fsrs_last_review_at";

/**
 * One user_card_progress row's fields relevant to answering one card:
 * card-lifecycle state (for commit_answer_transaction()'s p_expected_*
 * snapshot arguments) plus every fsrs_* column (structurally a
 * UserCardProgressFsrsRow, so it can be passed directly into
 * progressToFsrsCard() with no remapping). Deliberately excludes
 * unrelated columns this phase has no use for (last_seen_at,
 * last_answer_correct, first_mastered_at, last_mastered_at,
 * created_at/updated_at, id).
 *
 * `seen_count` here is the PRE-answer value (as stored). rating.ts's
 * `RatingEstimatorInput.seenCount` is POST-increment by contract (locked
 * in Phase C3) -- commit_answer_transaction() always computes
 * `seen_count_after = seen_count_before + 1` unconditionally, regardless
 * of correct/wrong or session mode (see the migration's card-lifecycle
 * section), so the future submitAnswer() must pass
 * `progress.seen_count + 1` to estimateRating(), not this raw value
 * as-is.
 */
export interface CardProgressRow extends UserCardProgressFsrsRow {
  card_status: "NEW" | "LEARNING" | "LEARNED" | "FORGOTTEN";
  seen_count: number;
  correct_streak: number;
  wrong_streak: number;
}

/**
 * `CardProgressRow` as it actually arrives over the wire: PostgREST/
 * supabase-js never parses `timestamptz` columns into JS `Date` objects --
 * they come back as ISO 8601 strings (or `null`). This is the honest
 * runtime shape of one `.select(PROGRESS_COLUMNS)` row, before
 * `toCardProgressRow` normalizes it into the genuinely-Date-typed
 * `CardProgressRow` the rest of the Learning Engine (progressToFsrsCard,
 * the future submitAnswer()) actually relies on.
 */
type RawCardProgressRow = Omit<CardProgressRow, "fsrs_due_at" | "fsrs_last_review_at"> & {
  fsrs_due_at: string | null;
  fsrs_last_review_at: string | null;
};

/**
 * Parses one PostgREST timestamp string into a `Date`, or passes through
 * `null`. Throws rather than returning an `Invalid Date` or silently
 * forwarding an unparseable string -- a malformed timestamp here means
 * something is structurally wrong (not a normal "empty" state, which is
 * `null`), and this module's contract (docs above) is that downstream
 * code can trust `fsrs_due_at`/`fsrs_last_review_at` are genuine Dates.
 */
function parseTimestamp(value: string | null, field: string): Date | null {
  if (value === null) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`getCardProgress: ${field} is not a valid timestamp: ${JSON.stringify(value)}`);
  }
  return date;
}

function toCardProgressRow(raw: RawCardProgressRow): CardProgressRow {
  return {
    ...raw,
    fsrs_due_at: parseTimestamp(raw.fsrs_due_at, "fsrs_due_at"),
    fsrs_last_review_at: parseTimestamp(raw.fsrs_last_review_at, "fsrs_last_review_at"),
  };
}

/**
 * Reads the caller's current progress for one card, scoped entirely by
 * RLS (`user_card_progress_select_own_or_admin`) plus `card_id` --
 * `user_card_progress` has a `UNIQUE (user_id, card_id)` constraint, so at
 * most one row can match. Returns `null` if the caller has no progress
 * row for this card (never created, e.g. the card doesn't belong to one
 * of their decks) or it isn't RLS-visible -- both indistinguishable from
 * each other, so this never confirms another user's card-progress data
 * exists. Throws on a genuine database failure, or on an unparseable
 * `fsrs_due_at`/`fsrs_last_review_at` (see parseTimestamp).
 */
export async function getCardProgress(cardId: string): Promise<CardProgressRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_card_progress")
    .select(PROGRESS_COLUMNS)
    .eq("card_id", cardId)
    .maybeSingle();

  if (error) {
    throw new Error("Failed to load card progress", { cause: error });
  }

  if (!data) {
    return null;
  }

  return toCardProgressRow(data as unknown as RawCardProgressRow);
}

/**
 * Reads the caller's most recent committed answers for one card, for
 * rating.ts's Easy-eligibility "recent history is stable" gate. Returns
 * only the correctness facts rating.ts needs -- structurally a
 * `RatingEstimatorInput.recentAnswerHistory` value: most-recent-first,
 * excluding whatever answer submitAnswer() is currently processing (this
 * only ever reads already-committed rows), limited to
 * `RATING_CONFIG.EASY_STABLE_HISTORY_LENGTH` entries. A card never
 * answered before returns `[]`, which rating.ts already treats as "not
 * stable" (fewer than the required history length).
 *
 * Ordered by `answered_at desc` -- the field docs/DATABASE_SCHEMA.md
 * itself indexes `answer_events` on for this exact per-user access
 * pattern (`INDEX (user_id, answered_at)`, section 8), not an invented
 * ordering. `id desc` is an additional deterministic tiebreaker only
 * (total ordering in the vanishingly unlikely case two events share an
 * `answered_at` instant) -- it does not change which field is primary.
 *
 * Scoped by RLS (`answer_events_select_own_or_admin`) plus `card_id`; no
 * explicit `user_id` filter is added since there is no client-supplied
 * user id to filter by.
 */
export async function getRecentAnswerHistory(cardId: string): Promise<readonly boolean[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("answer_events")
    .select("correct")
    .eq("card_id", cardId)
    .order("answered_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(RATING_CONFIG.EASY_STABLE_HISTORY_LENGTH);

  if (error) {
    throw new Error("Failed to load recent answer history", { cause: error });
  }

  return (data ?? []).map((row) => row.correct as boolean);
}

/**
 * Early replay lookup (added in the D3b hardening pass) for the future
 * submitAnswer(): `answer_events.client_event_id` is globally `UNIQUE`
 * (not scoped per user at the schema level), but this read is still safely
 * scoped to the authenticated tester through RLS
 * (`answer_events_select_own_or_admin`: `user_id = auth.uid() or
 * is_admin()`) alone -- if a row with this `client_event_id` exists and
 * belongs to a different user, RLS makes it invisible here, so this
 * returns `null` exactly as if it didn't exist. No explicit `user_id`
 * filter is added, consistent with every other read in this module.
 *
 * Returns the full row (`select("*")`), matching exactly the columns
 * `commit_answer_transaction()`'s own `to_jsonb(answer_events row)`
 * returns in its replay branch (10.3) -- same shape, so this can feed the
 * same `CommittedAnswerEventRow`-consuming result-shaping code as a fresh
 * RPC response. Callers must independently confirm `session_id`/`card_id`
 * match the answer they're about to (re)submit before treating this as a
 * usable replay -- this function only looks the row up, it does not
 * validate identity (that mirrors how the RPC's own replay branch treats
 * a `client_event_id` reused for a different logical answer as an error,
 * not a valid replay).
 */
export async function getAnswerEventByClientEventId(
  clientEventId: string,
): Promise<CommittedAnswerEventRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("answer_events")
    .select("*")
    .eq("client_event_id", clientEventId)
    .maybeSingle();

  if (error) {
    throw new Error("Failed to load answer event by client_event_id", { cause: error });
  }

  return data as CommittedAnswerEventRow | null;
}

/**
 * The XP events linked to one answer_event, for reconstructing a replay
 * result's `xp_events` (and, by checking for a `daily_goal_completed`
 * reason among them, `daily_goal_just_completed` -- the same derivation
 * commit_answer_transaction()'s own replay branch uses). Scoped by RLS
 * (`xp_events_select_own_or_admin`) plus `source_answer_event_id`; no
 * explicit `user_id` filter, same reasoning as above.
 */
export async function getXpEventsForAnswerEvent(
  answerEventId: string,
): Promise<readonly CommittedXpEventRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("xp_events")
    .select("*")
    .eq("source_answer_event_id", answerEventId);

  if (error) {
    throw new Error("Failed to load xp events for answer event", { cause: error });
  }

  return (data ?? []) as CommittedXpEventRow[];
}
