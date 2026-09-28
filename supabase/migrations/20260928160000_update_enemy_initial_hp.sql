-- Rebalance the canonical enemy initial HP values:
--   enemy_a (Moss Slime):     90 -> 90   (unchanged)
--   enemy_b (Mushroom Goblin): 105 -> 110
--   enemy_c (Root Golem):     120 -> 160
--
-- Battle formula, damage range, critical rate, combo logic, and
-- enemy-selection (uniform random among the three) are all unchanged --
-- only the HP literals below move.
--
-- This migration does not edit the committed
-- 20260923201000_session_initial_enemy_and_daily_goal_snapshot.sql
-- migration -- it CREATE OR REPLACEs start_or_resume_session() again, the
-- normal way to evolve a Postgres function across migrations. Every other
-- branch of the function (resume behavior, tester-only guard, deck
-- validation, review-queue seeding, Daily Goal snapshot) is copied
-- unchanged from that migration; only the "Initial enemy" CASE literals
-- differ.
--
-- commit_answer_transaction() is intentionally NOT touched by this
-- migration: it has never hard-coded the enemy_id -> HP mapping (see its
-- own header, 20260923200000_commit_answer_transaction.sql) -- it only
-- validates that a caller-supplied next-enemy type is one of the three
-- canonical IDs and that the supplied max HP is positive, then trusts the
-- TypeScript-config-owned value the caller (lib/learning/battle.ts, via
-- lib/learning/config.ts's ENEMY_CONFIG) actually supplies. That config
-- change is what makes an enemy *respawned after defeat* use the new HP;
-- this migration only updates the *brand-new session* spawn path.
--
-- Existing active sessions that already have an enemy spawned with the
-- old max HP (105 or 120) are deliberately left untouched by this
-- migration -- there is no UPDATE against public.sessions here. Rewriting
-- a tester's already-in-progress battle state on deploy is not this
-- migration's job; the old HP value simply plays out for that one
-- in-flight enemy, and the next enemy (on defeat, or on the next new
-- session) uses the new value.

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

  -- Initial enemy: uniform random among the three canonical types.
  -- HP values updated by this migration: enemy_a 90 (unchanged),
  -- enemy_b 105 -> 110, enemy_c 120 -> 160.
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
    daily_goal_progress, daily_goal_completed
  )
  values (
    v_user_id, v_deck_id, 'active',
    case when v_due_count > 0 then 'review' else 'learning' end,
    v_due_count > 0,
    v_enemy_type, v_enemy_max_hp, v_enemy_max_hp,
    v_snapshot_progress, v_snapshot_completed
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
  'SECURITY DEFINER trusted workflow (DATABASE_SCHEMA.md 10.2), initializes a valid random initial enemy (enemy_a/b/c, 90/110/160 HP -- updated by the 20260928160000 follow-up) and an accurate Daily Goal snapshot (carried forward from today''s Asia/Tokyo daily_user_stats, not reset) on every newly created session. Resumes the caller''s existing active session unchanged in queue/enemy/goal terms. Derives the acting user from auth.uid() only. search_path pinned to empty; all references schema-qualified.';

revoke all on function public.start_or_resume_session(uuid) from public;
grant execute on function public.start_or_resume_session(uuid) to authenticated;
