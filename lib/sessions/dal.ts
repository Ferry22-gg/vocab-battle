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

// =============================================================================
// getNextSessionCard() -- Phase F0 (docs/DATABASE_SCHEMA.md 4.4/4.6/4.7/9.1/
// 10.3/11)
// =============================================================================

const NO_CARD_REASONS = [
  "REVIEW_QUEUE_EMPTY_PENDING_TRANSITION",
  "LEARNING_NO_ELIGIBLE_CARDS",
  "LEARNING_ALL_ON_COOLDOWN",
] as const;

const ERROR_REASONS = [
  "SESSION_MISSING_BATTLE_STATE",
  "LEARNING_FORCED_CARD_INELIGIBLE",
  "INVALID_SESSION_MODE",
] as const;

export type NextSessionCardNoCardReason = (typeof NO_CARD_REASONS)[number];
export type NextSessionCardErrorReason = (typeof ERROR_REASONS)[number];

/**
 * The full result contract of `get_next_session_card()`
 * (supabase/migrations/20260924010000_get_next_session_card.sql). Every
 * variant is a normal, expected outcome the Session UI must handle -- none
 * of them indicate a thrown/RPC-level failure (that remains a thrown
 * Error from this function, per the pattern below).
 */
export type NextSessionCard =
  | {
      readonly status: "ok";
      readonly sessionId: string;
      readonly sessionMode: "review" | "learning";
      readonly cardId: string;
      readonly front: string;
      readonly back: string;
      readonly enemyType: EnemyId;
      readonly enemyHp: number;
      readonly enemyMaxHp: number;
      readonly combo: number;
    }
  | { readonly status: "not_found" }
  | { readonly status: "no_card"; readonly reason: NextSessionCardNoCardReason }
  | { readonly status: "error"; readonly reason: NextSessionCardErrorReason };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const ENEMY_IDS = ["enemy_a", "enemy_b", "enemy_c"] as const;
function isEnemyId(value: unknown): value is EnemyId {
  return typeof value === "string" && (ENEMY_IDS as readonly string[]).includes(value);
}

/**
 * Validates/normalizes the RPC's raw `jsonb` result into `NextSessionCard`
 * -- deliberately does not use a bare `as` cast (unlike `startOrResumeSession`/
 * `finishSession` above, which trust a `returns public.sessions` Postgres row
 * type). This RPC returns a hand-built `jsonb` envelope with several
 * possible shapes (docs/DATABASE_SCHEMA.md-style: see the migration's own
 * header comment), so malformed/unexpected output must be caught here
 * rather than silently reaching the Session UI as if it were a valid
 * `"ok"` card. Throws on anything that does not match a known shape --
 * exactly like the "genuine database failure" case elsewhere in this
 * module, not a normal application-level outcome.
 */
function parseNextSessionCard(data: unknown): NextSessionCard {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("getNextSessionCard: malformed RPC result (not a JSON object)");
  }

  const row = data as Record<string, unknown>;
  const status = row.status;

  if (status === "not_found") {
    return { status: "not_found" };
  }

  if (status === "no_card") {
    if (!NO_CARD_REASONS.includes(row.reason as NextSessionCardNoCardReason)) {
      throw new Error(`getNextSessionCard: unrecognized no_card reason: ${JSON.stringify(row.reason)}`);
    }
    return { status: "no_card", reason: row.reason as NextSessionCardNoCardReason };
  }

  if (status === "error") {
    if (!ERROR_REASONS.includes(row.reason as NextSessionCardErrorReason)) {
      throw new Error(`getNextSessionCard: unrecognized error reason: ${JSON.stringify(row.reason)}`);
    }
    return { status: "error", reason: row.reason as NextSessionCardErrorReason };
  }

  if (status !== "ok") {
    throw new Error(`getNextSessionCard: unrecognized status: ${JSON.stringify(status)}`);
  }

  if (
    !isNonEmptyString(row.session_id) ||
    (row.session_mode !== "review" && row.session_mode !== "learning") ||
    !isNonEmptyString(row.card_id) ||
    typeof row.front !== "string" ||
    typeof row.back !== "string" ||
    !isEnemyId(row.enemy_type) ||
    !isFiniteNumber(row.enemy_hp) ||
    !isFiniteNumber(row.enemy_max_hp) ||
    !isFiniteNumber(row.combo)
  ) {
    throw new Error(`getNextSessionCard: malformed "ok" result: ${JSON.stringify(row)}`);
  }

  return {
    status: "ok",
    sessionId: row.session_id,
    sessionMode: row.session_mode,
    cardId: row.card_id,
    front: row.front,
    back: row.back,
    enemyType: row.enemy_type,
    enemyHp: row.enemy_hp,
    enemyMaxHp: row.enemy_max_hp,
    combo: row.combo,
  };
}

/**
 * Reads the authoritative next answerable card for the caller's own
 * active session via `get_next_session_card()` -- a read-only SECURITY
 * INVOKER RPC (never service-role) that replicates
 * `commit_answer_transaction()`'s exact Review/Learning eligibility rules
 * in Postgres, so this module never re-implements queue-selection logic
 * in TypeScript. Like every other function in this file, identity comes
 * entirely from the caller's own authenticated Supabase session -- there
 * is no `userId` parameter for a caller to pass, and none is forwarded to
 * the RPC either (`get_next_session_card(p_session_id)` derives the
 * caller from `auth.uid()` internally).
 *
 * Never throws for a "normal" outcome (not_found / no_card / error) --
 * only for a genuine RPC failure or a malformed result shape. Callers must
 * branch on `.status`.
 */
export async function getNextSessionCard(sessionId: string): Promise<NextSessionCard> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_next_session_card", {
    p_session_id: sessionId,
  });

  if (error) {
    throw new Error("Failed to load next session card", { cause: error });
  }

  return parseNextSessionCard(data);
}
