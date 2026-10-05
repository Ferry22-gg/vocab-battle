-- Learning Engine v1 -- Runtime Cutover RC-D: Live Session Routing /
-- Cutover Wiring.
-- Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md and
-- docs/LEARNING_ENGINE_V1_RUNTIME_CUTOVER_TODO.md, plus the approved
-- Runtime Cutover Architecture plan RC-A/B/C already implement.
--
-- Forward-only. Does not edit any RC-A/B/C migration, or any Phase 0/F0
-- migration's already-applied body in place -- every function changed
-- below is evolved the established way (CREATE OR REPLACE for a same-
-- signature change), exactly how 20260928160000 already evolved
-- start_or_resume_session() past its own originating migration.
--
-- Scope:
--   1. start_or_resume_session(): assign engine_version exactly once, for
--      a genuinely NEW session only (never re-evaluated on resume).
--      Non-enrolled users are completely unaffected (engine_version
--      remains 'legacy' via the existing column default path -- same
--      bytes on the wire as before this migration for that case).
--   2. finish_session(): abandon a v1 session's OPEN selection claim
--      (if any) atomically with the session completion, under the same
--      row lock finish_session() already takes.
--   3. admit_user_to_learning_engine_v1(): the minimal trusted,
--      service_role-only rollout-admission primitive RC-A intentionally
--      left unbuilt (RC-A's own header: "no function in this migration
--      deletes or inserts rows here; that trusted write path is
--      explicitly out of RC-A's scope"). Writes the row ONLY -- the
--      required legacy-state normalization that must happen BEFORE this
--      is called is TypeScript orchestration
--      (lib/learning-engine/cutover/enroll.ts), reusing RC-A's existing
--      normalize_card_progress_for_learning_engine_v1() /
--      recompute_user_deck_learning_state_for_v1(), never duplicated
--      here. Still service_role-only -- no normal authenticated tester
--      can ever call this directly (RC-A's "rollout table is not
--      user-self-service" is unchanged).
--
-- ---------------------------------------------------------------------
-- Why "rollout row exists" alone is a sufficient v1-readiness check here
-- ---------------------------------------------------------------------
-- The approved readiness principle is "'eligible for v1' must imply
-- 'safe for chooseNextCard() right now.'" This migration deliberately
-- does NOT re-derive or re-check per-deck normalization completeness
-- inside start_or_resume_session() -- it trusts that invariant entirely
-- because of how the row is created (see point 3 above): the ONLY
-- trusted write path that can ever insert a learning_engine_v1_rollout
-- row (admit_user_to_learning_engine_v1(), service_role-only) is never
-- called except via lib/learning-engine/cutover/enroll.ts's
-- enrollUserInLearningEngineV1(), which normalizes every one of that
-- user's (user, deck) pairs that has pre-existing legacy progress FIRST,
-- and only writes the rollout row after that succeeds. A deck created
-- AFTER enrollment needs no separate normalization step at all:
-- duplicate_starter_deck() already seeds a card_status = 'NEW' progress
-- row (learning_stage/pool_status/relearning_phase all NULL) for every
-- card in the new deck, which lib/learning-engine/runtime/snapshot-mapper.ts's
-- validateCardInvariants() accepts without modification (NEW triggers no
-- structural invariant at all), and
-- get_learning_engine_v1_scheduler_snapshot() already lazily upserts a
-- correctly-defaulted user_deck_learning_state row for any (user, deck)
-- pair that doesn't have one yet (RC-B precedent). So "rollout row
-- exists" -> "every one of this user's decks, past and future, is safe
-- for chooseNextCard()" by construction, without start_or_resume_session()
-- needing to re-verify it on every call.
--
-- ---------------------------------------------------------------------
-- One-way routing (R5)
-- ---------------------------------------------------------------------
-- A rollout row's mere EXISTENCE (regardless of first_v1_answer_at) is
-- the eligibility signal for a brand-new session -- never
-- first_v1_answer_at IS NOT NULL (that would wrongly exclude a tester
-- admitted to rollout who simply hasn't started their first v1 session
-- yet). Since 20261015000000_learning_engine_v1_rollout_one_way_guard.sql
-- makes a rollout row with first_v1_answer_at set permanently
-- undeletable/unmodifiable even against service_role, and RC-A never
-- grants any deletion path for a row that is still pre-commit, there is
-- no scenario in which a user who has ever been routed to v1 can lose
-- their rollout row out from under them -- so this migration does not
-- need a separate "is this user one-way" branch: "rollout row exists"
-- already implies "give this new session engine_version = 'v1'"
-- unconditionally, one-way included. There is deliberately no legacy
-- fallback branch for any rollout-admitted user, satisfying "no automatic
-- legacy fallback for one-way users" by construction rather than by an
-- explicit check.

-- =========================================================================
-- start_or_resume_session()
-- =========================================================================
create or replace function public.start_or_resume_session(p_deck_id uuid default null)
returns public.sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_profile public.profiles;
  v_deck_id uuid;
  v_session public.sessions;
  v_due_count integer;
  v_stat_date date;
  v_enemy_type text;
  v_enemy_max_hp integer;
  v_daily_snapshot public.daily_user_stats;
  v_snapshot_progress integer;
  v_snapshot_completed boolean;
  v_engine_version text;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'start_or_resume_session: no authenticated user'
      using errcode = '28000';
  end if;

  -- Lock the caller's profile row for the lifetime of this transaction so
  -- concurrent start_or_resume_session() calls for the same user
  -- serialize here: the second caller blocks until the first commits (and
  -- has therefore already inserted/resumed the session), so the "existing
  -- active session" check below can never race and create two sessions.
  select *
  into v_profile
  from public.profiles
  where id = v_user_id
  for update;

  if not found then
    raise exception 'start_or_resume_session: no profile for caller'
      using errcode = '28000';
  end if;

  -- Tester-only persistence: admin accounts must not create/advance
  -- learner session state through this function (DATABASE_SCHEMA.md
  -- 4.1/6.3).
  if v_profile.account_status <> 'active' or v_profile.role <> 'tester' then
    raise exception 'start_or_resume_session: caller is not an active tester account'
      using errcode = '28000';
  end if;

  -- Day-boundary logic uses Asia/Tokyo (DATABASE_SCHEMA.md 2.2).
  v_stat_date := (now() at time zone 'Asia/Tokyo')::date;

  -- STEP ORDER (RC-D section 2): look for an existing active session for
  -- this user and resume it FIRST, with its own already-stored
  -- engine_version, BEFORE ever evaluating rollout eligibility. Rollout
  -- state is only ever consulted below, in the "no active session"
  -- branch, for a genuinely NEW session.
  select *
  into v_session
  from public.sessions
  where user_id = v_user_id
    and status = 'active'
  order by started_at desc
  limit 1;

  if found then
    -- Resume behavior (4.5): current enemy, HP, combo, session XP, enemy
    -- count, Daily Goal progress, and learning draw index are all already
    -- persisted columns on this row and are simply returned as-is; the
    -- unanswered card at last close is deliberately not restored (no
    -- session_review_cards/session_learning_queue write happens here).
    -- resume_count/last_active_at are bumped to reflect this resume.
    -- engine_version is untouched -- resuming never re-evaluates or
    -- changes it, regardless of any rollout-state change since this
    -- session was created (RC-D section 1/2).
    update public.sessions
    set resume_count = resume_count + 1,
        last_active_at = now()
    where id = v_session.id
    returning * into v_session;

    -- Activity tracking on RESUME: touch last_active_at/last_activity_at
    -- only. first_active_at and session_count are left untouched -- no
    -- new session was started.
    update public.profiles
    set last_active_at = now()
    where id = v_user_id;

    insert into public.daily_user_stats (
      user_id, stat_date, first_activity_at, last_activity_at, session_count
    )
    values (v_user_id, v_stat_date, now(), now(), 0)
    on conflict (user_id, stat_date) do update
    set last_activity_at = excluded.last_activity_at;

    return v_session;
  end if;

  -- no active session: validate the requested (or selected) deck belongs
  -- to the caller
  v_deck_id := coalesce(p_deck_id, v_profile.selected_deck_id);

  if v_deck_id is null then
    raise exception 'start_or_resume_session: no deck specified and no selected deck on profile'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.decks
    where id = v_deck_id
      and owner_user_id = v_user_id
      and deleted_at is null
  ) then
    raise exception 'start_or_resume_session: deck % does not belong to caller', v_deck_id
      using errcode = '42501';
  end if;

  -- RC-D section 5: engine_version for a brand-new session only. A
  -- learning_engine_v1_rollout row's mere existence is the eligibility
  -- signal -- never first_v1_answer_at IS NOT NULL (see this migration's
  -- own header: that would wrongly exclude an admitted tester who simply
  -- hasn't started their first v1 session yet). There is deliberately no
  -- legacy fallback branch here at all: once a row exists, every
  -- subsequent brand-new session for that user is 'v1', one-way users
  -- included, by construction (see header "One-way routing").
  select case when exists (
    select 1 from public.learning_engine_v1_rollout where user_id = v_user_id
  ) then 'v1' else 'legacy' end
  into v_engine_version;

  -- Determine the fixed review queue for this session: cards eligible for
  -- review are the caller's own progress rows, LEARNED, with a due date
  -- that has passed, on a card belonging to this deck and not soft-deleted.
  -- Computed regardless of engine_version -- current_mode/
  -- started_with_reviews remain populated for schema compatibility (RC-D
  -- section 19/21) even though a v1 session's own selection never reads
  -- them; only the session_review_cards POPULATION below is gated to
  -- legacy.
  select count(*)
  into v_due_count
  from public.user_card_progress ucp
  join public.cards c on c.id = ucp.card_id
  where ucp.user_id = v_user_id
    and ucp.card_status = 'LEARNED'
    and ucp.fsrs_due_at is not null
    and ucp.fsrs_due_at <= now()
    and c.deck_id = v_deck_id
    and c.deleted_at is null;

  -- Initial enemy: uniform random among the three canonical types.
  -- Shared Battle/session initialization -- identical for legacy and v1
  -- (RC-D section 21: "preserve shared Battle/session initialization").
  case floor(random() * 3)::integer
    when 0 then v_enemy_type := 'enemy_a'; v_enemy_max_hp := 90;
    when 1 then v_enemy_type := 'enemy_b'; v_enemy_max_hp := 110;
    else v_enemy_type := 'enemy_c'; v_enemy_max_hp := 160;
  end case;

  -- Daily Goal snapshot: carry forward today's existing progress (if any)
  -- instead of resetting it just because a new session is starting.
  select *
  into v_daily_snapshot
  from public.daily_user_stats
  where user_id = v_user_id
    and stat_date = v_stat_date;

  v_snapshot_progress := least(coalesce(v_daily_snapshot.enemies_defeated, 0), 5);
  v_snapshot_completed := coalesce(v_daily_snapshot.daily_goal_completed, false);

  insert into public.sessions (
    user_id, deck_id, status, current_mode, started_with_reviews,
    current_enemy_type, current_enemy_max_hp, current_enemy_hp,
    daily_goal_progress, daily_goal_completed, engine_version
  )
  values (
    v_user_id, v_deck_id, 'active',
    case when v_due_count > 0 then 'review' else 'learning' end,
    v_due_count > 0,
    v_enemy_type, v_enemy_max_hp, v_enemy_max_hp,
    v_snapshot_progress, v_snapshot_completed, v_engine_version
  )
  returning * into v_session;

  -- RC-D section 20: a v1 session never populates/uses the legacy
  -- session_review_cards queue -- zero dependency. Legacy is completely
  -- unchanged (still seeded exactly as before this migration).
  if v_due_count > 0 and v_engine_version = 'legacy' then
    insert into public.session_review_cards (session_id, card_id, queue_order)
    select
      v_session.id,
      ucp.card_id,
      row_number() over (order by ucp.fsrs_due_at asc, ucp.card_id asc) - 1
    from public.user_card_progress ucp
    join public.cards c on c.id = ucp.card_id
    where ucp.user_id = v_user_id
      and ucp.card_status = 'LEARNED'
      and ucp.fsrs_due_at is not null
      and ucp.fsrs_due_at <= now()
      and c.deck_id = v_deck_id
      and c.deleted_at is null;
  end if;

  -- Activity tracking on a NEW session.
  update public.profiles
  set first_active_at = coalesce(first_active_at, now()),
      last_active_at = now()
  where id = v_user_id;

  insert into public.daily_user_stats (
    user_id, stat_date, first_activity_at, last_activity_at, session_count
  )
  values (v_user_id, v_stat_date, now(), now(), 1)
  on conflict (user_id, stat_date) do update
  set first_activity_at = coalesce(public.daily_user_stats.first_activity_at, excluded.first_activity_at),
      last_activity_at = excluded.last_activity_at,
      session_count = public.daily_user_stats.session_count + 1;

  return v_session;
end;
$$;

comment on function public.start_or_resume_session(uuid) is
  'SECURITY DEFINER trusted workflow (DATABASE_SCHEMA.md 10.2), initializes a valid random initial enemy (enemy_a/b/c, 90/110/160 HP) and an accurate Daily Goal snapshot (carried forward from today''s Asia/Tokyo daily_user_stats, not reset) on every newly created session. Resumes the caller''s existing active session unchanged in queue/enemy/goal/engine_version terms. RC-D: assigns engine_version exactly once for a brand-new session only (''v1'' iff a learning_engine_v1_rollout row exists for the caller, ''legacy'' otherwise; never re-evaluated on resume), and skips legacy session_review_cards seeding for a v1 session. Derives the acting user from auth.uid() only. search_path pinned to empty; all references schema-qualified.';

revoke all on function public.start_or_resume_session(uuid) from public;
grant execute on function public.start_or_resume_session(uuid) to authenticated;

-- =========================================================================
-- finish_session()
-- =========================================================================
create or replace function public.finish_session(p_session_id uuid)
returns public.sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_session public.sessions;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'finish_session: no authenticated user'
      using errcode = '28000';
  end if;

  -- Tester-only persistence: admin accounts must not complete learner
  -- session state through this function (DATABASE_SCHEMA.md 4.1/6.3).
  if not exists (
    select 1
    from public.profiles
    where id = v_user_id
      and account_status = 'active'
      and role = 'tester'
  ) then
    raise exception 'finish_session: caller is not an active tester account'
      using errcode = '28000';
  end if;

  -- Lock the target session row (scoped to the caller's own ownership)
  -- before validating/updating it, so a concurrent finish_session() call
  -- on the same session cannot race: the second caller blocks until the
  -- first commits, then re-reads the now-current status and correctly
  -- rejects it as no longer active. This same lock also serializes
  -- against claim_next_learning_engine_card()'s own "lock sessions row
  -- first" ordering (RC-B), so the OPEN-claim abandonment below can never
  -- race a concurrent claim attempt for this session.
  select *
  into v_session
  from public.sessions
  where id = p_session_id
    and user_id = v_user_id
  for update;

  if not found then
    raise exception 'finish_session: % is not owned by the caller', p_session_id
      using errcode = '42501';
  end if;

  if v_session.status <> 'active' then
    raise exception 'finish_session: % is not an active session (status=%)', p_session_id, v_session.status
      using errcode = '42501';
  end if;

  -- RC-D section 16/17: explicit Session finish (and ONLY explicit finish
  -- -- never a mere page reload/navigation-away, which never calls this
  -- function at all) atomically abandons a v1 session's OPEN selection
  -- claim, if one exists. SelectionTrace is never touched (abandonment
  -- means "selected but never answered", not "never happened" -- RC-A's
  -- own documented claim-lifecycle semantics); scheduler_position/
  -- active-draw/first-pass-queue/shuffle-bag state are untouched because
  -- none of those ever change at claim time in the first place (RC-B:
  -- scheduler_position only ever advances at answer-commit time) -- so
  -- there is nothing to roll back. A session with no OPEN claim (already
  -- answered, already abandoned, or never had one, or a legacy session)
  -- matches zero rows here, a no-op.
  if v_session.engine_version = 'v1' then
    update public.selection_claims
    set status = 'ABANDONED', closed_at = now()
    where session_id = v_session.id
      and status = 'OPEN';
  end if;

  -- MVP: authenticated testers may only explicitly finish a session as
  -- 'user_finished' -- there is no caller-controlled end_reason parameter,
  -- so 'timeout'/'error' cannot be submitted through this function.
  -- Future timeout/error completion will use a separate trusted/system
  -- path.
  update public.sessions
  set status = 'completed',
      ended_at = now(),
      end_reason = 'user_finished'
  where id = v_session.id
  returning * into v_session;

  return v_session;
end;
$$;

comment on function public.finish_session(uuid) is
  'SECURITY DEFINER trusted workflow (DATABASE_SCHEMA.md 10.2). Completes the caller''s own active session with end_reason = ''user_finished'' only, after independently re-validating ownership and active state under a row lock. RC-D: for a v1 session, atomically abandons (OPEN -> ABANDONED) any still-open selection_claims row for this session -- never touching its linked SelectionTrace, scheduler_position, or any other claim-time bookkeeping. Derives the acting user from auth.uid() only. search_path pinned to empty; all references schema-qualified.';

revoke all on function public.finish_session(uuid) from public;
grant execute on function public.finish_session(uuid) to authenticated;

-- =========================================================================
-- admit_user_to_learning_engine_v1()
-- =========================================================================
-- RC-D section 27: the minimal trusted rollout-admission primitive RC-A
-- deliberately left unbuilt. WRITE-ONLY -- performs no normalization
-- computation itself (same "no calculation" discipline as every other
-- trusted DAL/function in this tree). The caller (TypeScript
-- orchestration, lib/learning-engine/cutover/enroll.ts) is responsible
-- for completing the required legacy-state normalization for every one
-- of this user's existing (user, deck) pairs via RC-A's own
-- normalize_card_progress_for_learning_engine_v1()/
-- recompute_user_deck_learning_state_for_v1() BEFORE ever calling this --
-- this function has no way to verify that itself (normalization
-- completeness is not a property any single SQL predicate here could
-- re-derive without duplicating RC-A's own per-row logic) and does not
-- attempt to. Idempotent (ON CONFLICT DO NOTHING): calling this twice for
-- an already-admitted user is a safe no-op, never an error, and never
-- touches first_v1_answer_at.
--
-- service_role-only -- no grant to `authenticated`/`anon` at all, so a
-- normal tester can never self-enroll (RC-A's own "rollout table is not
-- user-self-service" rule, unchanged). Respects the one-way guard trigger
-- (20261015000000) implicitly: this function never UPDATEs or DELETEs an
-- existing row, so it can never violate it.
create function public.admit_user_to_learning_engine_v1(p_user_id uuid)
returns public.learning_engine_v1_rollout
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.learning_engine_v1_rollout;
begin
  if p_user_id is null then
    raise exception 'admit_user_to_learning_engine_v1: p_user_id is required'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = p_user_id
      and account_status = 'active'
      and role = 'tester'
  ) then
    raise exception 'admit_user_to_learning_engine_v1: % is not an active tester account', p_user_id
      using errcode = '28000';
  end if;

  insert into public.learning_engine_v1_rollout (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select * into v_row
  from public.learning_engine_v1_rollout
  where user_id = p_user_id;

  return v_row;
end;
$$;

comment on function public.admit_user_to_learning_engine_v1(uuid) is
  'Runtime Cutover RC-D: the minimal trusted rollout-admission primitive. SECURITY DEFINER, service_role-only. Write-only -- inserts a learning_engine_v1_rollout row for an active tester (ON CONFLICT DO NOTHING, idempotent), never updates or deletes one, and performs no normalization itself. Callers MUST complete per-deck legacy-state normalization (RC-A''s normalize_card_progress_for_learning_engine_v1()/recompute_user_deck_learning_state_for_v1()) before calling this -- see lib/learning-engine/cutover/enroll.ts. Never grants authenticated/anon execute -- no tester can self-enroll.';

revoke all on function public.admit_user_to_learning_engine_v1(uuid) from public, anon, authenticated;
grant execute on function public.admit_user_to_learning_engine_v1(uuid) to service_role;
