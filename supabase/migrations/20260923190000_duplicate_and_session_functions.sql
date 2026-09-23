-- Phase 6A trusted database functions: duplicate_starter_deck(),
-- start_or_resume_session(), finish_session().
-- Source of truth: docs/DATABASE_SCHEMA.md sections 5, 10.1, 10.2, 10.6.
--
-- Scope for this migration only: these three SECURITY DEFINER functions and
-- their EXECUTE grants. commit_answer_transaction() is explicitly deferred
-- to a later phase (10.3) and is NOT implemented here.
--
-- All three are callable by `authenticated` (10.6) and derive the acting
-- user exclusively from auth.uid() -- never from a client-supplied
-- parameter -- then re-validate ownership/state inside the function body,
-- since SECURITY DEFINER bypasses the caller's own RLS policies (same
-- pattern as public.is_admin() in the grants/RLS migration). Each function
-- pins search_path = '' and schema-qualifies every reference.
--
-- Atomicity note: a PL/pgSQL function body already executes as a single
-- statement from the caller's perspective -- any exception raised inside
-- unwinds every write the function made, satisfying the "rollback
-- everything on any failure" requirement in 10.1/10.2 without any explicit
-- transaction control (which plain functions cannot use anyway).
--
-- Concurrency note: duplicate_starter_deck() and start_or_resume_session()
-- each take `SELECT ... FOR UPDATE` on the caller's own public.profiles
-- row before their idempotency-sensitive checks, so two concurrent calls
-- for the same user serialize on that row lock instead of racing (the
-- second caller blocks until the first transaction commits or rolls
-- back). finish_session() instead locks the target public.sessions row
-- (scoped to caller ownership) before validating/updating it. Because
-- every lock is scoped to a single row owned by a single user, there is
-- no cross-user contention and no possibility of a lock-ordering
-- deadlock between these functions.
--
-- Tester-only persistence note: all three functions require BOTH
-- account_status = 'active' AND role = 'tester' on the caller's profile.
-- Admin accounts (role = 'admin') cannot persist learner state through
-- these functions, per the admin-preview restriction in 4.1/6.3.

-- =========================================================================
-- duplicate_starter_deck()
-- =========================================================================

create or replace function public.duplicate_starter_deck(p_source_deck_id uuid)
returns public.decks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_profile public.profiles;
  v_source_deck public.decks;
  v_existing_deck public.decks;
  v_new_deck public.decks;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'duplicate_starter_deck: no authenticated user'
      using errcode = '28000';
  end if;

  -- Lock the caller's profile row for the lifetime of this transaction so
  -- two concurrent calls for the same user serialize on this SELECT ...
  -- FOR UPDATE: the second caller blocks here until the first commits (and
  -- has therefore already inserted the duplicate deck), so the "detect
  -- existing copy" check below can never race and create two copies.
  select *
  into v_profile
  from public.profiles
  where id = v_user_id
  for update;

  if not found then
    raise exception 'duplicate_starter_deck: no profile for caller'
      using errcode = '28000';
  end if;

  -- Tester-only persistence: admin accounts must not create learner state
  -- through this function (DATABASE_SCHEMA.md 4.1/6.3).
  if v_profile.account_status <> 'active' or v_profile.role <> 'tester' then
    raise exception 'duplicate_starter_deck: caller is not an active tester account'
      using errcode = '28000';
  end if;

  -- validate source deck is an allowed starter/template deck
  select *
  into v_source_deck
  from public.decks
  where id = p_source_deck_id
    and is_template = true
    and is_official = true
    and deleted_at is null;

  if not found then
    raise exception 'duplicate_starter_deck: % is not a valid starter template deck', p_source_deck_id
      using errcode = '22023';
  end if;

  -- detect whether this tester already has the relevant starter copy
  select *
  into v_existing_deck
  from public.decks
  where owner_user_id = v_user_id
    and source_deck_id = p_source_deck_id
    and deleted_at is null
  limit 1;

  if found then
    -- Idempotent path: reuse the existing copy rather than duplicating
    -- again. Unarchive it if needed, then make it the caller's selection
    -- and mark onboarding complete -- this final state must hold whether
    -- the copy already existed or was just created below.
    if v_existing_deck.archived_at is not null then
      update public.decks
      set archived_at = null
      where id = v_existing_deck.id
      returning * into v_existing_deck;
    end if;

    update public.profiles
    set selected_deck_id = v_existing_deck.id,
        onboarding_completed = true
    where id = v_user_id;

    return v_existing_deck;
  end if;

  insert into public.decks (
    name, description, front_language, back_language,
    owner_user_id, source_deck_id, is_template, is_official, visibility, sort_order
  )
  values (
    v_source_deck.name, v_source_deck.description,
    v_source_deck.front_language, v_source_deck.back_language,
    v_user_id, v_source_deck.id, false, false, 'private', 0
  )
  returning * into v_new_deck;

  -- Copy all source cards with new UUIDs, then create one NEW
  -- user_card_progress row per copied card, in a single statement pair so
  -- the id mapping never leaves the database. created_by_user_id is the
  -- duplicating tester, not NULL -- NULL is reserved for official
  -- template cards (DATABASE_SCHEMA.md 4.3).
  with new_cards as (
    insert into public.cards (
      deck_id, front, back, extra_content,
      created_by_user_id, source_card_id, sort_order
    )
    select
      v_new_deck.id, src.front, src.back, src.extra_content,
      v_user_id, src.id, src.sort_order
    from public.cards src
    where src.deck_id = v_source_deck.id
      and src.deleted_at is null
    returning id
  )
  insert into public.user_card_progress (
    user_id, card_id, card_status, seen_count, correct_streak, wrong_streak
  )
  select v_user_id, new_cards.id, 'NEW', 0, 0, 0
  from new_cards;

  update public.profiles
  set selected_deck_id = v_new_deck.id,
      onboarding_completed = true
  where id = v_user_id;

  return v_new_deck;
end;
$$;

comment on function public.duplicate_starter_deck(uuid) is
  'SECURITY DEFINER trusted workflow (DATABASE_SCHEMA.md 10.1). Duplicates an official starter deck into an independent user-owned copy, or returns the caller''s existing copy unchanged if one already exists. Derives the acting user from auth.uid() only. search_path pinned to empty; all references schema-qualified.';

revoke all on function public.duplicate_starter_deck(uuid) from public;
grant execute on function public.duplicate_starter_deck(uuid) to authenticated;

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

  -- look for an existing active session for this user
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

  -- Determine the fixed review queue for this session: cards eligible for
  -- review are the caller's own progress rows, LEARNED, with a due date
  -- that has passed, on a card belonging to this deck and not soft-deleted.
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

  insert into public.sessions (
    user_id, deck_id, status, current_mode, started_with_reviews
  )
  values (
    v_user_id, v_deck_id, 'active',
    case when v_due_count > 0 then 'review' else 'learning' end,
    v_due_count > 0
  )
  returning * into v_session;

  if v_due_count > 0 then
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
  'SECURITY DEFINER trusted workflow (DATABASE_SCHEMA.md 10.2). Resumes the caller''s existing active session unchanged in queue terms, or starts a new one and seeds its fixed session_review_cards queue from currently-due cards. Derives the acting user from auth.uid() only. search_path pinned to empty; all references schema-qualified.';

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
  -- rejects it as no longer active.
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
  'SECURITY DEFINER trusted workflow (DATABASE_SCHEMA.md 10.2). Completes the caller''s own active session with end_reason = ''user_finished'' only, after independently re-validating ownership and active state under a row lock. Derives the acting user from auth.uid() only. search_path pinned to empty; all references schema-qualified.';

revoke all on function public.finish_session(uuid) from public;
grant execute on function public.finish_session(uuid) to authenticated;
