/**
 * Session DAL: thin wrappers around the trusted session RPCs
 * (docs/DATABASE_SCHEMA.md 10.2) plus a narrow, RLS-scoped read of a
 * session by id. Uses the caller's ordinary authenticated/RLS-scoped
 * Supabase client (lib/supabase/server.ts) throughout -- never
 * service-role. `sessions` is SELECT-only for `authenticated` at the grant
 * level (grants_and_rls.sql), so this module never attempts a direct
 * INSERT/UPDATE on it; starting, resuming, and finishing a session only
 * ever happens through start_or_resume_session()/finish_session(), which
 * derive the acting user from `auth.uid()` inside the function body (never
 * a parameter) and independently re-validate ownership/state regardless
 * of what RLS would otherwise allow a SECURITY DEFINER function to bypass.
 *
 * No function here accepts or forwards a user id -- there is deliberately
 * no such parameter on any exported function. Identity always comes from
 * the authenticated request's own Supabase session.
 *
 * Deliberately does not use React's `cache()` (unlike lib/decks/dal.ts,
 * lib/auth/dal.ts): the future submitAnswer() feeds these reads into
 * commit_answer_transaction()'s stale-snapshot comparison, which exists
 * specifically to catch state that changed since it was read. Memoizing
 * a read within that flow would work against the exact staleness check
 * this data supports.
 */

import { createClient } from "@/lib/supabase/server";
import type { EnemyId } from "@/lib/learning/config";

const SESSION_COLUMNS =
  "id, deck_id, status, current_mode, current_combo, current_enemy_type, current_enemy_hp, current_enemy_max_hp, learning_draw_index";

/**
 * Narrow view of one `sessions` row -- only the columns the future
 * submitAnswer() needs (current battle/queue-mode snapshot for its
 * calculations and for commit_answer_transaction()'s p_expected_* /
 * p_session_mode arguments), not the full row. `current_enemy_type`/
 * `current_enemy_hp`/`current_enemy_max_hp` are typed nullable to match
 * the actual column nullability (docs/DATABASE_SCHEMA.md 4.5) even though
 * start_or_resume_session() always populates a valid enemy for a newly
 * created session -- this DAL does not assert a stricter guarantee than
 * the schema itself makes.
 *
 * Both trusted RPCs below (`returns public.sessions`) return the full
 * table row; this type only names the subset this phase's callers use,
 * discarding the rest at the type boundary rather than fetching a second,
 * narrower query (there is only one round trip either way).
 */
export interface SessionRow {
  id: string;
  deck_id: string;
  status: "active" | "completed";
  current_mode: "review" | "learning";
  current_combo: number;
  current_enemy_type: EnemyId | null;
  current_enemy_hp: number | null;
  current_enemy_max_hp: number | null;
  learning_draw_index: number;
}

/**
 * Starts a new session for the caller (in `deckId`, or their
 * `profiles.selected_deck_id` if omitted), or resumes their existing
 * active one unchanged, via `start_or_resume_session()`. That function
 * derives the acting user from `auth.uid()` and re-validates deck
 * ownership/tester-only access itself -- this wrapper adds no logic of
 * its own beyond the call and a server-safe error on failure.
 */
export async function startOrResumeSession(deckId?: string): Promise<SessionRow> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("start_or_resume_session", {
    p_deck_id: deckId ?? null,
  });

  if (error) {
    throw new Error("Failed to start or resume session", { cause: error });
  }

  return data as SessionRow;
}

/**
 * Completes the caller's own active session (`end_reason = 'user_finished'`)
 * via `finish_session()`, which independently re-validates that
 * `sessionId` belongs to the caller and is still active.
 */
export async function finishSession(sessionId: string): Promise<SessionRow> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("finish_session", {
    p_session_id: sessionId,
  });

  if (error) {
    throw new Error("Failed to finish session", { cause: error });
  }

  return data as SessionRow;
}

/**
 * Reads one active session by id, scoped entirely by RLS
 * (`sessions_select_own_or_admin`: `user_id = auth.uid() or is_admin()`)
 * -- no explicit ownership filter is added here, since there is no
 * client-supplied user id to filter by. For an ordinary tester caller,
 * a `sessionId` belonging to another user is indistinguishable from a
 * nonexistent one: both come back as `null`, never a distinct
 * "forbidden" error, so this never confirms or denies another user's
 * session's existence. (An admin caller legitimately sees more sessions
 * than their own, per that same RLS policy -- an intentional, pre-existing
 * admin-dashboard allowance this DAL does not alter.)
 *
 * `status = 'active'` is filtered at the query level (matching this
 * function's name) rather than left to the caller to check -- a completed
 * session and a nonexistent/inaccessible one both simply come back `null`.
 * This is a convenience/pre-flight read only: commit_answer_transaction()
 * independently re-validates active status itself regardless of what this
 * returns.
 *
 * Uses `maybeSingle()`, not `single()`, so a genuine zero-row result
 * (not found / not accessible / not active) returns `null` instead of
 * throwing -- only an actual database failure throws.
 */
export async function getActiveSessionById(sessionId: string): Promise<SessionRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .eq("status", "active")
    .maybeSingle();

  if (error) {
    throw new Error("Failed to load session", { cause: error });
  }

  return data as SessionRow | null;
}
