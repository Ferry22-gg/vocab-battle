-- Learning Engine v1 -- Runtime Cutover RC-A: additive schema.
-- Source of truth: the approved Runtime Cutover Architecture plan
-- (sections 5/6/8/9/11/13 -- selection claims, cards_since_last_seen,
-- first-pass-queue persistence, engine_version rollout gate, the
-- learning_engine_v1_rollout table) and docs/
-- LEARNING_ENGINE_V1_RUNTIME_CUTOVER_TODO.md.
--
-- Scope for this migration: schema only (tables, columns, constraints,
-- indexes, RLS, grants). No trusted write/normalization function lives
-- here (see 20261008000000_learning_engine_v1_cutover_normalization_functions.sql).
-- Strictly additive, same discipline as every prior Learning Engine v1
-- migration: no existing column/constraint is narrowed, nothing here is
-- read or written by any legacy trusted function
-- (get_next_session_card()/commit_answer_transaction()/
-- start_or_resume_session()/finish_session() are completely untouched),
-- and no live Session UI, Server Action, or chooseNextCard() call is
-- wired to any of this yet.
--
-- ---------------------------------------------------------------------
-- selection_claims
-- ---------------------------------------------------------------------
-- The retry-idempotency anchor for a future trusted selection-claim
-- transaction (RC-B, not built by this migration). A claim ties one
-- chooseNextCard() decision's persisted SelectionTrace to the session
-- that is currently "holding" it, with a lifecycle of exactly three
-- states:
--
--   OPEN      -- a card has been claimed for this session and not yet
--                answered. At most one OPEN claim may exist per session
--                (enforced below by a partial unique index) -- this is
--                what makes a lost-response retry safe: a retry that
--                finds an existing OPEN claim returns it unchanged
--                rather than minting a second one.
--   ANSWERED  -- a future trusted answer-commit transaction closed this
--                claim because its card was successfully answered.
--                Terminal.
--   ABANDONED -- the session ended (or was superseded) while this claim
--                was still OPEN and unanswered. Terminal. The claim's
--                SelectionTrace is never deleted -- abandonment means
--                "selected but never answered", not "never happened".
--
-- `user_id` is denormalized onto this table (not reached only via
-- session_id) so RLS can scope it the same direct way every other
-- trusted-state table does (sessions, user_card_progress, ...) without
-- an extra join, and so a future trusted function can validate caller
-- ownership with one row lookup.
create table public.selection_claims (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references public.profiles (id) on delete restrict,
  deck_id uuid not null
    references public.decks (id) on delete restrict,
  session_id uuid not null
    references public.sessions (id) on delete restrict,
  card_id uuid not null
    references public.cards (id) on delete restrict,
  selection_trace_id uuid not null
    references public.learning_engine_selection_traces (id) on delete restrict,

  -- The scheduler_position/scheduler_revision this claim was created
  -- against (supabase/migrations/20261002000000_learning_engine_v1_scheduler_position.sql)
  -- -- i.e. the PRE-answer-commit values, mirroring exactly what the
  -- linked selection_trace itself recorded. A future answer-commit
  -- transaction compares its own live read of these against the values
  -- here before advancing scheduler_position (approved Runtime Cutover
  -- plan section 8: scheduler_position advances only at answer-commit
  -- time, never at claim time).
  scheduler_position integer not null
    check (scheduler_position >= 0),
  scheduler_revision integer not null
    check (scheduler_revision >= 0),

  status text not null default 'OPEN'
    check (status in ('OPEN', 'ANSWERED', 'ABANDONED')),

  created_at timestamptz not null default now(),
  -- NULL while OPEN; set exactly once, when the claim transitions to
  -- ANSWERED or ABANDONED. No CHECK ties this to `status` directly
  -- (Postgres CHECK constraints cannot reference "was this column ever
  -- previously non-null", so enforcing the one-way OPEN -> terminal
  -- transition is a future trusted function's job, not a declarative
  -- constraint) -- consistent with how has_achieved_full_mastery's
  -- "never becomes false" monotonicity is documented as a function-level
  -- obligation, not a schema-level one (20261001000000's own comment).
  closed_at timestamptz
);

-- At most one OPEN claim per session -- the core idempotency invariant
-- (approved Runtime Cutover plan section 6): a retried "give me the next
-- card" request that already has an OPEN claim for this session must
-- observe this same row, never create a second one. A concurrent race to
-- create two OPEN claims for the same session collides on this index;
-- the loser's transaction fails with a unique_violation (23505) and must
-- re-read rather than retry the insert blindly.
create unique index selection_claims_one_open_per_session_idx
  on public.selection_claims (session_id)
  where status = 'OPEN';

create index selection_claims_user_id_idx
  on public.selection_claims (user_id);

create index selection_claims_session_id_idx
  on public.selection_claims (session_id);

alter table public.selection_claims enable row level security;

-- Trusted-state table, same design decision as every other Learning
-- Engine v1 table (20261001000000's user_deck_learning_state/
-- user_learning_preferences, grants_and_rls.sql's original seven):
-- `authenticated` gets read-only access scoped by RLS; every write
-- (create, close as ANSWERED, close as ABANDONED) is reserved for a
-- future trusted SECURITY DEFINER function (RC-B/RC-C), never a direct
-- authenticated grant. No INSERT/UPDATE/DELETE grant to `authenticated`
-- or `anon` at all -- an authenticated caller attempting any of the
-- three fails with 42501 (permission denied) before any RLS policy or
-- CHECK constraint is even evaluated, exactly the same shape
-- tests.assert_no_write_grants() already asserts for every other
-- trusted-state table.
revoke all on table public.selection_claims from anon, authenticated;
grant select on table public.selection_claims to authenticated;

create policy selection_claims_select_own_or_admin
  on public.selection_claims
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------
-- user_card_progress.last_presented_scheduler_position
-- ---------------------------------------------------------------------
-- Approved Runtime Cutover plan section 9 / docs/
-- LEARNING_ENGINE_V1_RUNTIME_CUTOVER_TODO.md's `cards_since_last_seen`
-- gap: the authoritative anchor a future answer-commit transaction needs
-- to compute `cards_since_last_seen = new_scheduler_position -
-- last_presented_scheduler_position` for the review event it writes.
-- NULL means "this card has never been presented under the v1 engine" --
-- written ONLY by a future trusted answer-commit transaction, at the
-- same moment it advances scheduler_position itself. This migration
-- does not, and must not, populate it from any legacy history (approved
-- plan section 9: "Do not populate fake legacy values").
alter table public.user_card_progress
  add column last_presented_scheduler_position integer
    check (last_presented_scheduler_position is null or last_presented_scheduler_position >= 0);

-- ---------------------------------------------------------------------
-- user_deck_learning_state.first_pass_queue
-- ---------------------------------------------------------------------
-- Durable backing for the already-pure, already-tested
-- DeckSchedulerState.firstPassQueue (lib/learning-engine/scheduler/
-- snapshot.ts) -- that type's own doc comment states plainly this field
-- has "no Phase 1-6D column or field backing it yet". Mirrors
-- post_mastery_shuffle_bag_state's existing jsonb-array shape exactly
-- (same table, same "opaque to every phase before the one that consumes
-- it" treatment, same "or deterministic equivalent" allowance) rather
-- than inventing a differently-typed representation for what is, at the
-- TypeScript level, the identical shape: `readonly string[] | null`.
-- NULL/empty means no first-pass batch is currently in flight, matching
-- next-card.ts's own normalizeFirstPassQueue (an empty array and NULL
-- are treated identically by every consumer).
alter table public.user_deck_learning_state
  add column first_pass_queue jsonb;

-- ---------------------------------------------------------------------
-- sessions.engine_version
-- ---------------------------------------------------------------------
-- Approved Runtime Cutover plan section 13 (rollout strategy): the
-- runtime source of truth for which engine an ACTIVE session uses,
-- decided exactly once, at session-creation time, by a future
-- start_or_resume_session() update (not made by this migration) that
-- consults learning_engine_v1_rollout for a brand-new session only. A
-- resumed session must never re-evaluate this -- see that table's own
-- comment below. Every session that already exists before this
-- migration runs gets 'legacy' from the column default (Postgres fills
-- the DEFAULT for every existing row on an ADD COLUMN ... DEFAULT, not
-- just future inserts), which is exactly correct: no pre-cutover session
-- was ever created with any v1 awareness.
--
-- No grant change needed: `sessions` is one of the seven original
-- "trusted state" tables (grants_and_rls.sql) with a blanket SELECT-only
-- grant to `authenticated` that already covers every column, present and
-- future -- the same precedent 20261002000000's own header cites for
-- user_deck_learning_state's new columns.
alter table public.sessions
  add column engine_version text not null default 'legacy'
    check (engine_version in ('legacy', 'v1'));

-- ---------------------------------------------------------------------
-- learning_engine_v1_rollout
-- ---------------------------------------------------------------------
-- Approved Runtime Cutover plan section 13/R7: a dedicated, minimal
-- rollout table -- deliberately NOT a `profiles` boolean. Semantics:
--
--   row exists                    -> this tester is currently admitted
--                                     to the v1 rollout (may receive
--                                     engine_version = 'v1' on their NEXT
--                                     brand-new session).
--   first_v1_answer_at IS NULL    -> admitted, but has not yet entered
--                                     the one-way v1 zone (approved plan
--                                     R5) -- safe to remove from rollout.
--   first_v1_answer_at NOT NULL   -> has committed at least one v1
--                                     answer; per R5, automatic rollback
--                                     to legacy is prohibited from this
--                                     point on.
--
-- This table only ever influences which engine a BRAND NEW session is
-- created with -- a resumed session's engine_version (sessions.
-- engine_version, set once at creation) is the sole runtime source of
-- truth for an already-active session and must never be re-derived from
-- this table (approved plan section 13: "a resumed Session must never
-- re-evaluate rollout eligibility"). Deleting a row (removing a tester
-- from rollout) is an operational/admin action -- no function in this
-- migration deletes or inserts rows here; that trusted write path is
-- explicitly out of RC-A's scope (not requested, and this migration does
-- not invent one).
create table public.learning_engine_v1_rollout (
  user_id uuid primary key
    references public.profiles (id) on delete restrict,
  enabled_at timestamptz not null default now(),
  first_v1_answer_at timestamptz
);

alter table public.learning_engine_v1_rollout enable row level security;

-- Trusted-state table, same pattern as every table above: no write grant
-- to `authenticated`/`anon` at all -- "rollout table is not
-- user-self-service" (approved plan). A tester may read their own
-- rollout row (harmless, no UI surfaces it yet); only a future
-- service_role-only trusted path (not built here) may write one.
revoke all on table public.learning_engine_v1_rollout from anon, authenticated;
grant select on table public.learning_engine_v1_rollout to authenticated;

create policy learning_engine_v1_rollout_select_own_or_admin
  on public.learning_engine_v1_rollout
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());
