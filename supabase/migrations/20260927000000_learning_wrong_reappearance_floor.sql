-- Follow-up to Phase 6B: CREATE OR REPLACE commit_answer_transaction() so
-- a Learning-mode Wrong answer also sets a cooldown FLOOR, not only the
-- forced-reappearance guarantee it already set.
--
-- This migration does not edit the committed Phase 6B migration
-- (20260923200000_commit_answer_transaction.sql) -- it replaces the
-- function definition in place via CREATE OR REPLACE FUNCTION, the normal
-- way to evolve a Postgres function across migrations (see
-- 20260923201000_session_initial_enemy_and_daily_goal_snapshot.sql for
-- the identical precedent against start_or_resume_session()).
--
-- ---------------------------------------------------------------------
-- Product rule change (explicit, requested)
-- ---------------------------------------------------------------------
-- Previously documented/implemented behavior: a Learning-mode Wrong
-- answer at draw N scheduled forced_reappear_draw_index = N + gap(6..9)
-- (after collision-shift) as a CEILING only -- a guarantee the card would
-- reappear by that draw -- but left next_eligible_draw_index unset, so
-- nothing prevented the same card from being redrawn on the very next
-- draw if it happened to be the highest-priority eligible Learning-tier
-- card (verified live: a just-Wronged card reappeared 8 draws before its
-- own reserved slot in a real F1 browser smoke test).
--
-- New, explicit invariant:
--   After a Wrong answer at Learning draw N, the card must not be
--   selected again before its reserved forced-reappearance draw
--   (N + gap(6..9), after collision-shifting). At that reserved draw, it
--   must be selected.
--
-- Implementation: the collision-shifted final position (v_forced_pos) is
-- now written to BOTH forced_reappear_draw_index AND
-- next_eligible_draw_index -- no new queue field, no new concept. This is
-- the "preferred semantics... unless the existing schema requires a
-- slightly different but equivalent representation" case explicitly
-- named in the request: the existing schema requires no change at all,
-- since session_learning_queue already has both fields and
-- next_eligible_draw_index was simply never populated on the Wrong path.
--
-- Why this alone is sufficient (no other function needs to change):
--   - The pre-existing Learning-mode eligibility check in THIS function
--     ("if v_learning_row_exists and next_eligible_draw_index is not null
--     and current_draw_number < next_eligible_draw_index then reject",
--     unchanged below) already rejects early resubmission of ANY card
--     with a populated next_eligible_draw_index, regardless of whether a
--     Correct or a Wrong answer set it. Populating it on Wrong is
--     therefore sufficient on its own to make direct-commit validation
--     (item 3 of the request) reject an early resubmission -- no
--     additional check needed.
--   - get_next_session_card()'s Gate 2 cooldown predicate
--     (`not (next_eligible_draw_index is not null and current_draw_number
--     < next_eligible_draw_index)`, supabase/migrations/
--     20260924010000_get_next_session_card.sql) already excludes any card
--     with a populated next_eligible_draw_index -- it needs no change to
--     start excluding a just-Wronged card too.
--   - get_next_session_card()'s Gate 1 (forced-reappearance override)
--     runs BEFORE Gate 2 and is keyed on forced_reappear_draw_index alone
--     -- unaffected by next_eligible_draw_index -- so at the exact
--     reserved draw, Gate 1 still forces the card regardless of its now
--     also-matching next_eligible_draw_index. get_next_session_card() is
--     therefore unchanged by this migration; it is included here only as
--     the trace/confirmation the request asked for.
--
-- Collision-shift is untouched: it still only checks other cards'
-- forced_reappear_draw_index (the "is this exact Gate-1 slot already
-- claimed by a different card" question) -- next_eligible_draw_index is a
-- personal cooldown expiry, not a claimed slot, so two cards sharing a
-- next_eligible_draw_index value creates no Gate-1 ambiguity and needs no
-- new collision check.
--
-- Everything else in this function (Correct-answer cooldown, Review-mode
-- handling, battle validation, XP/level/Daily-Goal logic, idempotency/
-- replay) is copied byte-for-byte from 20260923200000_commit_answer_
-- transaction.sql -- only the Wrong-branch UPDATE/INSERT statements below
-- (search "next_eligible_draw_index = v_forced_pos") differ.

create or replace function public.commit_answer_transaction(
  -- identity / idempotency
  p_client_event_id uuid,
  p_user_id uuid,
  p_session_id uuid,
  p_card_id uuid,

  -- pre-answer snapshot: staleness baseline, compared only for a new
  -- event (never for a replay), after basic ownership/session/card/queue
  -- validation and before any write
  p_expected_card_status_before text,
  p_expected_seen_count_before integer,
  p_expected_correct_streak_before integer,
  p_expected_wrong_streak_before integer,
  p_expected_fsrs_due_before timestamptz,
  p_expected_session_enemy_hp_before integer,
  p_expected_session_combo_before integer,
  p_expected_session_learning_draw_index integer,

  -- answer/card-state result
  p_correct boolean,
  p_response_time_ms integer,
  p_session_mode text,

  -- FSRS result (ts-fsrs output; never recomputed here)
  p_fsrs_rating text,
  p_fsrs_due_at timestamptz,
  p_fsrs_stability double precision,
  p_fsrs_difficulty double precision,
  p_fsrs_elapsed_days integer,
  p_fsrs_scheduled_days integer,
  p_fsrs_reps integer,
  p_fsrs_lapses integer,
  p_fsrs_learning_steps integer,
  p_fsrs_state integer,
  p_fsrs_last_review_at timestamptz,

  -- battle result (TypeScript-owned; validated for structural
  -- consistency only -- the damage formula itself is not reimplemented)
  p_base_damage integer,
  p_speed_bonus integer,
  p_critical boolean,
  p_combo_after integer,
  p_damage integer,
  p_enemy_hp_after integer,
  p_enemy_defeated boolean,
  p_new_enemy_type text default null,
  p_new_enemy_max_hp integer default null,
  p_new_enemy_hp integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Constants mirroring docs/MVP_SPEC_FOR_CLAUDE.md section 24/25/35.
  c_xp_correct_answer constant integer := 2;
  c_xp_card_learned constant integer := 15;
  c_xp_card_relearned constant integer := 15;
  c_xp_enemy_defeated constant integer := 20;
  c_xp_daily_goal constant integer := 30;
  c_daily_goal_enemies constant integer := 5;
  c_combo_cap constant integer := 10;
  c_mastery_streak constant integer := 4;
  c_mastery_seen constant integer := 5;
  c_learning_cooldown constant integer := 11;
  c_forced_min_gap constant integer := 6;
  c_forced_max_gap constant integer := 9;

  v_profile public.profiles;
  v_session public.sessions;

  v_progress_id uuid;
  v_card_status_before text;
  v_seen_count_before integer;
  v_correct_streak_before integer;
  v_wrong_streak_before integer;
  v_last_answer_correct_before boolean;
  v_last_seen_at_before timestamptz;
  v_fsrs_due_before timestamptz;
  v_fsrs_scheduled_days_before integer;
  v_progress_after public.user_card_progress;

  v_existing_event public.answer_events;

  v_stat_date date;
  v_daily public.daily_user_stats;

  v_review_row public.session_review_cards;
  v_review_wrong_count integer;
  v_review_queue_order integer;
  v_reviews_now_empty boolean;

  v_learning_row public.session_learning_queue;
  v_learning_row_exists boolean := false;
  v_current_draw_number integer;
  v_forced_pos integer;

  v_seen_count_after integer;
  v_correct_streak_after integer;
  v_wrong_streak_after integer;
  v_card_status_after text;
  v_time_since_last_seen bigint;

  v_cards_mastered_delta integer := 0;
  v_cards_forgotten_delta integer := 0;
  v_reviews_completed_delta integer := 0;
  v_enemy_defeated_delta integer := 0;

  v_daily_goal_was_completed boolean;
  v_daily_goal_now_completed boolean := false;
  v_post_goal_answer boolean := false;

  v_answer_xp integer := 0;
  v_mastery_xp integer := 0;
  v_mastery_xp_reason text;
  v_enemy_xp integer := 0;
  v_daily_goal_xp integer := 0;
  v_total_answer_xp integer;

  v_answer_event public.answer_events;
  v_xp_row public.xp_events;
  v_xp_rows public.xp_events[] := array[]::public.xp_events[];

  v_new_total_xp integer;
  v_new_level integer;
  v_next_threshold integer;
  v_new_streak integer;

  v_new_current_mode text;
  v_new_reviews_completed_at timestamptz;
begin
  if p_user_id is null then
    raise exception 'commit_answer_transaction: p_user_id is required'
      using errcode = '22023';
  end if;

  -- Lock the caller's profile row first, unconditionally -- both for
  -- concurrency serialization per user (Phase 6A pattern) and because it
  -- is needed regardless of which branch (replay or new event) follows.
  select * into v_profile
  from public.profiles
  where id = p_user_id
  for update;

  if not found then
    raise exception 'commit_answer_transaction: no profile for user %', p_user_id
      using errcode = '28000';
  end if;

  -- =========================================================================
  -- Idempotency check FIRST -- before tester/session/card/queue validation
  -- and before any stale-snapshot comparison -- so a legitimate delayed
  -- retry can never be rejected merely because the original processing
  -- already advanced state, switched mode, or completed a review card.
  -- =========================================================================
  select * into v_existing_event
  from public.answer_events
  where client_event_id = p_client_event_id;

  if found then
    if v_existing_event.user_id <> p_user_id
       or v_existing_event.session_id <> p_session_id
       or v_existing_event.card_id <> p_card_id then
      raise exception 'commit_answer_transaction: client_event_id % already recorded for a different user/session/card', p_client_event_id
        using errcode = '42501';
    end if;

    return jsonb_build_object(
      'is_replay', true,
      'answer_event', to_jsonb(v_existing_event),
      'xp_events', (
        select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb)
        from public.xp_events x
        where x.source_answer_event_id = v_existing_event.id
      ),
      'daily_goal_just_completed', exists (
        select 1 from public.xp_events x
        where x.source_answer_event_id = v_existing_event.id
          and x.reason = 'daily_goal_completed'
      ),
      'user_card_progress', null,
      'session', null,
      'profile', null
    );
  end if;

  -- =========================================================================
  -- New event: full ownership/state validation, then persistence.
  -- =========================================================================

  if v_profile.account_status <> 'active' or v_profile.role <> 'tester' then
    raise exception 'commit_answer_transaction: caller is not an active tester account'
      using errcode = '28000';
  end if;

  select * into v_session
  from public.sessions
  where id = p_session_id
  for update;

  if not found or v_session.user_id <> p_user_id or v_session.status <> 'active' then
    raise exception 'commit_answer_transaction: session % is not an active session owned by %', p_session_id, p_user_id
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.cards
    where id = p_card_id
      and deck_id = v_session.deck_id
      and deleted_at is null
  ) then
    raise exception 'commit_answer_transaction: card % does not belong to session %''s deck', p_card_id, p_session_id
      using errcode = '42501';
  end if;

  select id, card_status, seen_count, correct_streak, wrong_streak,
         last_answer_correct, last_seen_at, fsrs_due_at, fsrs_scheduled_days
  into v_progress_id, v_card_status_before, v_seen_count_before, v_correct_streak_before, v_wrong_streak_before,
       v_last_answer_correct_before, v_last_seen_at_before, v_fsrs_due_before, v_fsrs_scheduled_days_before
  from public.user_card_progress
  where user_id = p_user_id and card_id = p_card_id
  for update;

  if not found then
    raise exception 'commit_answer_transaction: no user_card_progress for user % card %', p_user_id, p_card_id
      using errcode = '42501';
  end if;

  if p_session_mode <> v_session.current_mode then
    raise exception 'commit_answer_transaction: p_session_mode (%) does not match session %''s current_mode (%)', p_session_mode, p_session_id, v_session.current_mode
      using errcode = '22023';
  end if;

  -- Mode-specific queue lock + eligibility validation.
  if p_session_mode = 'review' then
    select * into v_review_row
    from public.session_review_cards
    where session_id = p_session_id and card_id = p_card_id
    for update;

    if not found or v_review_row.completed then
      raise exception 'commit_answer_transaction: card % is not an active review-queue entry for session %', p_card_id, p_session_id
        using errcode = '22023';
    end if;

  elsif p_session_mode = 'learning' then
    if v_card_status_before not in ('NEW', 'LEARNING', 'FORGOTTEN') then
      raise exception 'commit_answer_transaction: card % (status %) is not eligible for a Learning-mode answer', p_card_id, v_card_status_before
        using errcode = '22023';
    end if;

    v_current_draw_number := v_session.learning_draw_index + 1;

    select * into v_learning_row
    from public.session_learning_queue
    where session_id = p_session_id and card_id = p_card_id
    for update;

    v_learning_row_exists := found;

    -- Cooldown check: covers BOTH a Correct-set cooldown (N+11) and, as of
    -- this migration, a Wrong-set floor (the collision-shifted forced
    -- draw) -- this check itself is unchanged; it already rejects any
    -- card with a populated next_eligible_draw_index in the future,
    -- regardless of which branch below populated it.
    if v_learning_row_exists and v_learning_row.next_eligible_draw_index is not null
       and v_current_draw_number < v_learning_row.next_eligible_draw_index then
      raise exception 'commit_answer_transaction: card % is still in Learning cooldown until draw % (attempted at draw %)',
        p_card_id, v_learning_row.next_eligible_draw_index, v_current_draw_number
        using errcode = '22023';
    end if;

    if exists (
      select 1 from public.session_learning_queue slq
      where slq.session_id = p_session_id
        and slq.card_id <> p_card_id
        and slq.forced_reappear_draw_index = v_current_draw_number
    ) then
      raise exception 'commit_answer_transaction: draw % is reserved for a different card''s forced reappearance', v_current_draw_number
        using errcode = '22023';
    end if;
  else
    raise exception 'commit_answer_transaction: invalid p_session_mode %', p_session_mode
      using errcode = '22023';
  end if;

  -- Ensure today's (Asia/Tokyo) daily_user_stats row exists and is
  -- locked before it is read/compared/incremented below. Locked last,
  -- per the fixed order: profiles -> sessions -> user_card_progress ->
  -- queue row -> daily_user_stats.
  v_stat_date := (now() at time zone 'Asia/Tokyo')::date;

  insert into public.daily_user_stats (user_id, stat_date, first_activity_at, last_activity_at)
  values (p_user_id, v_stat_date, now(), now())
  on conflict (user_id, stat_date) do nothing;

  select * into v_daily
  from public.daily_user_stats
  where user_id = p_user_id and stat_date = v_stat_date
  for update;

  -- =========================================================================
  -- Stale-snapshot comparison -- only reached for a genuinely new event,
  -- after ownership/session/card/queue validation. NULL-safe throughout
  -- (IS DISTINCT FROM) so a NULL baseline (e.g. no prior FSRS due date)
  -- never breaks the comparison.
  -- =========================================================================
  if p_expected_card_status_before is distinct from v_card_status_before
     or p_expected_seen_count_before is distinct from v_seen_count_before
     or p_expected_correct_streak_before is distinct from v_correct_streak_before
     or p_expected_wrong_streak_before is distinct from v_wrong_streak_before
     or p_expected_fsrs_due_before is distinct from v_fsrs_due_before
     or p_expected_session_enemy_hp_before is distinct from v_session.current_enemy_hp
     or p_expected_session_combo_before is distinct from v_session.current_combo
     or (p_session_mode = 'learning'
         and p_expected_session_learning_draw_index is distinct from v_session.learning_draw_index)
  then
    raise exception 'commit_answer_transaction: stale pre-answer snapshot for card % in session %', p_card_id, p_session_id
      using errcode = '40001';
  end if;

  -- =========================================================================
  -- Battle-result structural invariants. TS config ranges (base damage
  -- 24-28, speed bonus 0-3, combo bonus tiers, critical multiplier) are
  -- deliberately NOT duplicated here -- the TS config module is the sole
  -- source of truth for those. Only fixed game mechanics and arithmetic
  -- consistency are checked.
  -- =========================================================================
  if p_base_damage < 0 or p_speed_bonus < 0 or p_damage < 0 then
    raise exception 'commit_answer_transaction: negative battle value'
      using errcode = '22023';
  end if;

  if p_combo_after < 0 or p_combo_after > c_combo_cap then
    raise exception 'commit_answer_transaction: p_combo_after % out of range', p_combo_after
      using errcode = '22023';
  end if;

  if not p_correct then
    if p_damage <> 0 or p_combo_after <> 0 or p_critical then
      raise exception 'commit_answer_transaction: a Wrong answer must have zero damage, zero combo, and no critical'
        using errcode = '22023';
    end if;
    if p_enemy_hp_after <> v_session.current_enemy_hp then
      raise exception 'commit_answer_transaction: a Wrong answer must not change enemy HP'
        using errcode = '22023';
    end if;
  else
    if p_combo_after <> least(v_session.current_combo + 1, c_combo_cap) then
      raise exception 'commit_answer_transaction: p_combo_after % is not a valid combo progression from %', p_combo_after, v_session.current_combo
        using errcode = '22023';
    end if;
    if p_enemy_hp_after <> greatest(0, v_session.current_enemy_hp - p_damage) then
      raise exception 'commit_answer_transaction: p_enemy_hp_after is inconsistent with the reported damage'
        using errcode = '22023';
    end if;
  end if;

  if p_enemy_defeated <> (p_enemy_hp_after = 0) then
    raise exception 'commit_answer_transaction: p_enemy_defeated is inconsistent with p_enemy_hp_after'
      using errcode = '22023';
  end if;

  if p_enemy_defeated then
    if p_new_enemy_type is null
       or p_new_enemy_type not in ('enemy_a', 'enemy_b', 'enemy_c')
       or p_new_enemy_max_hp is null or p_new_enemy_max_hp <= 0
       or p_new_enemy_hp is distinct from p_new_enemy_max_hp then
      raise exception 'commit_answer_transaction: invalid next-enemy fields on defeat'
        using errcode = '22023';
    end if;
  else
    if p_new_enemy_type is not null or p_new_enemy_max_hp is not null or p_new_enemy_hp is not null then
      raise exception 'commit_answer_transaction: next-enemy fields must be null when the enemy is not defeated'
        using errcode = '22023';
    end if;
  end if;

  -- =========================================================================
  -- Card lifecycle + queue mechanics: deterministic and concurrency-
  -- sensitive, recomputed here rather than trusted from the caller.
  -- =========================================================================
  v_seen_count_after := v_seen_count_before + 1;
  v_correct_streak_after := case when p_correct then v_correct_streak_before + 1 else 0 end;
  v_wrong_streak_after := case when p_correct then 0 else v_wrong_streak_before + 1 end;

  if p_session_mode = 'review' then
    if p_correct then
      update public.session_review_cards
      set completed = true, completed_at = now()
      where id = v_review_row.id
      returning * into v_review_row;

      v_card_status_after := 'LEARNED';
      v_reviews_completed_delta := 1;
    else
      v_review_wrong_count := v_review_row.wrong_count + 1;

      if v_review_wrong_count >= 2 then
        update public.session_review_cards
        set wrong_count = v_review_wrong_count, completed = true, completed_at = now()
        where id = v_review_row.id
        returning * into v_review_row;

        v_card_status_after := 'FORGOTTEN';
        v_reviews_completed_delta := 1;
      else
        select coalesce(max(queue_order), -1) + 1 into v_review_queue_order
        from public.session_review_cards
        where session_id = p_session_id;

        update public.session_review_cards
        set wrong_count = v_review_wrong_count, queue_order = v_review_queue_order
        where id = v_review_row.id
        returning * into v_review_row;

        -- First Wrong in this review portion: card stays LEARNED (11.2).
        v_card_status_after := 'LEARNED';
      end if;
    end if;

  else -- learning
    if v_card_status_before in ('NEW', 'LEARNING') then
      v_card_status_after := case
        when v_correct_streak_after >= c_mastery_streak and v_seen_count_after >= c_mastery_seen then 'LEARNED'
        else 'LEARNING'
      end;
    else -- FORGOTTEN: never converts to LEARNING while being relearned (item 4)
      v_card_status_after := case
        when v_correct_streak_after >= c_mastery_streak and v_seen_count_after >= c_mastery_seen then 'LEARNED'
        else 'FORGOTTEN'
      end;
    end if;

    if p_correct then
      if v_learning_row_exists then
        update public.session_learning_queue
        set last_draw_index = v_current_draw_number,
            times_shown_in_session = times_shown_in_session + 1,
            last_result = 'correct',
            next_eligible_draw_index = v_current_draw_number + c_learning_cooldown,
            forced_reappear_draw_index = null
        where id = v_learning_row.id
        returning * into v_learning_row;
      else
        insert into public.session_learning_queue (
          session_id, card_id, last_draw_index, times_shown_in_session,
          last_result, next_eligible_draw_index, forced_reappear_draw_index
        )
        values (
          p_session_id, p_card_id, v_current_draw_number, 1,
          'correct', v_current_draw_number + c_learning_cooldown, null
        )
        returning * into v_learning_row;
      end if;
    else
      v_forced_pos := v_current_draw_number + c_forced_min_gap
        + floor(random() * (c_forced_max_gap - c_forced_min_gap + 1))::integer;

      -- Collision-shift applies only among Learning forced-reappearance
      -- positions -- never conflated with the Review queue. Unchanged by
      -- this migration: it only needs to avoid two cards claiming the
      -- same Gate-1 slot (forced_reappear_draw_index), which is
      -- orthogonal to next_eligible_draw_index (a personal cooldown
      -- expiry, not a claimed slot -- see this file's header comment).
      while exists (
        select 1 from public.session_learning_queue slq
        where slq.session_id = p_session_id
          and slq.card_id <> p_card_id
          and slq.forced_reappear_draw_index = v_forced_pos
      ) loop
        v_forced_pos := v_forced_pos + 1;
      end loop;

      -- v_forced_pos (the final, collision-shifted position) is now the
      -- source of truth for BOTH fields: forced_reappear_draw_index (the
      -- Gate-1 guarantee -- the card MUST be selected at this draw) and
      -- next_eligible_draw_index (the floor -- the card must NOT be
      -- selected before this draw). This is the one substantive change
      -- in this migration; see the file header for the full rationale.
      if v_learning_row_exists then
        update public.session_learning_queue
        set last_draw_index = v_current_draw_number,
            times_shown_in_session = times_shown_in_session + 1,
            last_result = 'wrong',
            forced_reappear_draw_index = v_forced_pos,
            next_eligible_draw_index = v_forced_pos
        where id = v_learning_row.id
        returning * into v_learning_row;
      else
        insert into public.session_learning_queue (
          session_id, card_id, last_draw_index, times_shown_in_session,
          last_result, forced_reappear_draw_index, next_eligible_draw_index
        )
        values (
          p_session_id, p_card_id, v_current_draw_number, 1,
          'wrong', v_forced_pos, v_forced_pos
        )
        returning * into v_learning_row;
      end if;
    end if;
  end if;

  if v_card_status_after = 'LEARNED' and v_card_status_before <> 'LEARNED' then
    v_cards_mastered_delta := 1;
  end if;
  if v_card_status_after = 'FORGOTTEN' and v_card_status_before <> 'FORGOTTEN' then
    v_cards_forgotten_delta := 1;
  end if;

  v_time_since_last_seen := case
    when v_last_seen_at_before is null then null
    else (extract(epoch from (now() - v_last_seen_at_before)) * 1000)::bigint
  end;

  update public.user_card_progress
  set
    card_status = v_card_status_after,
    seen_count = v_seen_count_after,
    correct_streak = v_correct_streak_after,
    wrong_streak = v_wrong_streak_after,
    last_seen_at = now(),
    last_answer_correct = p_correct,
    first_mastered_at = case
      when v_card_status_after = 'LEARNED' and first_mastered_at is null then now()
      else first_mastered_at
    end,
    last_mastered_at = case
      when v_card_status_after = 'LEARNED' and v_card_status_before <> 'LEARNED' then now()
      else last_mastered_at
    end,
    fsrs_due_at = p_fsrs_due_at,
    fsrs_stability = p_fsrs_stability,
    fsrs_difficulty = p_fsrs_difficulty,
    fsrs_elapsed_days = p_fsrs_elapsed_days,
    fsrs_scheduled_days = p_fsrs_scheduled_days,
    fsrs_reps = p_fsrs_reps,
    fsrs_lapses = p_fsrs_lapses,
    fsrs_learning_steps = p_fsrs_learning_steps,
    fsrs_state = p_fsrs_state,
    fsrs_last_review_at = p_fsrs_last_review_at
  where id = v_progress_id
  returning * into v_progress_after;

  insert into public.answer_events (
    client_event_id, user_id, card_id, deck_id, session_id,
    correct, response_time_ms, session_mode,
    card_seen_count_at_answer, correct_streak_before, wrong_streak_before,
    previous_answer, card_status_before, time_since_last_seen, previous_review_interval,
    card_status_after, correct_streak_after, wrong_streak_after,
    fsrs_rating, fsrs_due_before, fsrs_due_after,
    base_damage, speed_bonus, combo, damage, critical,
    enemy_hp_before, enemy_hp_after
  )
  values (
    p_client_event_id, p_user_id, p_card_id, v_session.deck_id, p_session_id,
    p_correct, p_response_time_ms, p_session_mode,
    v_seen_count_before, v_correct_streak_before, v_wrong_streak_before,
    v_last_answer_correct_before, v_card_status_before, v_time_since_last_seen, v_fsrs_scheduled_days_before,
    v_card_status_after, v_correct_streak_after, v_wrong_streak_after,
    p_fsrs_rating, v_fsrs_due_before, p_fsrs_due_at,
    p_base_damage, p_speed_bonus, p_combo_after, p_damage, p_critical,
    v_session.current_enemy_hp, p_enemy_hp_after
  )
  returning * into v_answer_event;

  -- =========================================================================
  -- Daily Goal crossing detection (pre-update daily_user_stats values) +
  -- XP amounts (Postgres-derived constants only -- never caller-supplied).
  -- =========================================================================
  v_daily_goal_was_completed := v_daily.daily_goal_completed;
  v_enemy_defeated_delta := case when p_enemy_defeated then 1 else 0 end;

  if not v_daily_goal_was_completed
     and (v_daily.enemies_defeated + v_enemy_defeated_delta) >= c_daily_goal_enemies then
    v_daily_goal_now_completed := true;
  end if;

  -- The answer that completes the Daily Goal does not itself count as
  -- post-goal; only answers submitted while it was ALREADY complete do.
  v_post_goal_answer := v_daily_goal_was_completed;

  if p_correct then
    v_answer_xp := c_xp_correct_answer;
  end if;

  if v_cards_mastered_delta = 1 then
    v_mastery_xp := case when v_card_status_before = 'FORGOTTEN' then c_xp_card_relearned else c_xp_card_learned end;
    v_mastery_xp_reason := case when v_card_status_before = 'FORGOTTEN' then 'card_relearned' else 'card_learned' end;
  end if;

  if p_enemy_defeated then
    v_enemy_xp := c_xp_enemy_defeated;
  end if;

  if v_daily_goal_now_completed then
    v_daily_goal_xp := c_xp_daily_goal;
  end if;

  v_total_answer_xp := v_answer_xp + v_mastery_xp + v_enemy_xp + v_daily_goal_xp;

  if v_answer_xp > 0 then
    insert into public.xp_events (user_id, session_id, card_id, source_answer_event_id, amount, reason)
    values (p_user_id, p_session_id, p_card_id, v_answer_event.id, v_answer_xp, 'correct_answer')
    returning * into v_xp_row;
    v_xp_rows := array_append(v_xp_rows, v_xp_row);
  end if;

  if v_mastery_xp > 0 then
    insert into public.xp_events (user_id, session_id, card_id, source_answer_event_id, amount, reason)
    values (p_user_id, p_session_id, p_card_id, v_answer_event.id, v_mastery_xp, v_mastery_xp_reason)
    returning * into v_xp_row;
    v_xp_rows := array_append(v_xp_rows, v_xp_row);
  end if;

  if v_enemy_xp > 0 then
    insert into public.xp_events (user_id, session_id, card_id, source_answer_event_id, amount, reason)
    values (p_user_id, p_session_id, p_card_id, v_answer_event.id, v_enemy_xp, 'enemy_defeated')
    returning * into v_xp_row;
    v_xp_rows := array_append(v_xp_rows, v_xp_row);
  end if;

  if v_daily_goal_xp > 0 then
    insert into public.xp_events (user_id, session_id, card_id, source_answer_event_id, amount, reason)
    values (p_user_id, p_session_id, p_card_id, v_answer_event.id, v_daily_goal_xp, 'daily_goal_completed')
    returning * into v_xp_row;
    v_xp_rows := array_append(v_xp_rows, v_xp_row);
  end if;

  update public.daily_user_stats
  set
    last_activity_at = now(),
    total_answers = total_answers + 1,
    correct_answers = correct_answers + (case when p_correct then 1 else 0 end),
    wrong_answers = wrong_answers + (case when p_correct then 0 else 1 end),
    cards_mastered = cards_mastered + v_cards_mastered_delta,
    cards_forgotten = cards_forgotten + v_cards_forgotten_delta,
    reviews_completed = reviews_completed + v_reviews_completed_delta,
    enemies_defeated = enemies_defeated + v_enemy_defeated_delta,
    critical_hits = critical_hits + (case when p_critical then 1 else 0 end),
    longest_combo = greatest(longest_combo, p_combo_after),
    xp_gained = xp_gained + v_total_answer_xp,
    daily_goal_completed = daily_goal_completed or v_daily_goal_now_completed,
    daily_goal_completed_at = case when v_daily_goal_now_completed then now() else daily_goal_completed_at end,
    continued_after_daily_goal = continued_after_daily_goal or v_post_goal_answer,
    post_goal_answers = post_goal_answers + (case when v_post_goal_answer then 1 else 0 end)
  where id = v_daily.id
  returning * into v_daily;

  -- Review -> Learning transition, exactly once, guarded by
  -- reviews_completed_at being unset.
  v_new_current_mode := v_session.current_mode;
  v_new_reviews_completed_at := v_session.reviews_completed_at;

  if p_session_mode = 'review' and v_session.reviews_completed_at is null then
    select not exists (
      select 1 from public.session_review_cards
      where session_id = p_session_id and completed = false
    ) into v_reviews_now_empty;

    if v_reviews_now_empty then
      v_new_current_mode := 'learning';
      v_new_reviews_completed_at := now();
    end if;
  end if;

  update public.sessions
  set
    current_enemy_type = case when p_enemy_defeated then p_new_enemy_type else current_enemy_type end,
    current_enemy_max_hp = case when p_enemy_defeated then p_new_enemy_max_hp else current_enemy_max_hp end,
    current_enemy_hp = case when p_enemy_defeated then p_new_enemy_hp else p_enemy_hp_after end,
    current_combo = p_combo_after,
    total_answers = total_answers + 1,
    correct_answers = correct_answers + (case when p_correct then 1 else 0 end),
    wrong_answers = wrong_answers + (case when p_correct then 0 else 1 end),
    enemies_defeated = enemies_defeated + v_enemy_defeated_delta,
    longest_combo = greatest(longest_combo, p_combo_after),
    critical_hits = critical_hits + (case when p_critical then 1 else 0 end),
    xp_gained = xp_gained + v_total_answer_xp,
    daily_goal_progress = least(v_daily.enemies_defeated, c_daily_goal_enemies),
    daily_goal_completed = v_daily.daily_goal_completed,
    continued_after_daily_goal = continued_after_daily_goal or v_post_goal_answer,
    learning_draw_index = case when p_session_mode = 'learning' then v_current_draw_number else learning_draw_index end,
    current_mode = v_new_current_mode,
    reviews_completed_at = v_new_reviews_completed_at,
    last_active_at = now()
  where id = p_session_id
  returning * into v_session;

  v_new_total_xp := v_profile.total_xp + v_total_answer_xp;

  v_new_level := v_profile.level;
  loop
    v_next_threshold := 200 * v_new_level + 25 * v_new_level * (v_new_level - 1);
    exit when v_new_total_xp < v_next_threshold;
    v_new_level := v_new_level + 1;
  end loop;

  if v_daily_goal_now_completed then
    if v_profile.last_daily_goal_completed_on = v_stat_date - 1 then
      v_new_streak := v_profile.current_streak + 1;
    elsif v_profile.last_daily_goal_completed_on = v_stat_date then
      -- Defensive no-op: unreachable given the daily_user_stats guard above.
      v_new_streak := v_profile.current_streak;
    else
      v_new_streak := 1;
    end if;
  else
    v_new_streak := v_profile.current_streak;
  end if;

  update public.profiles
  set
    total_xp = v_new_total_xp,
    level = v_new_level,
    total_enemies_defeated = total_enemies_defeated + v_enemy_defeated_delta,
    current_streak = v_new_streak,
    longest_streak = greatest(longest_streak, v_new_streak),
    last_daily_goal_completed_on = case when v_daily_goal_now_completed then v_stat_date else last_daily_goal_completed_on end,
    last_active_at = now()
  where id = p_user_id
  returning * into v_profile;

  return jsonb_build_object(
    'is_replay', false,
    'answer_event', to_jsonb(v_answer_event),
    'xp_events', (
      select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
      from unnest(v_xp_rows) x
    ),
    'daily_goal_just_completed', v_daily_goal_now_completed,
    'user_card_progress', to_jsonb(v_progress_after),
    'session', to_jsonb(v_session),
    'profile', jsonb_build_object(
      'total_xp', v_profile.total_xp,
      'level', v_profile.level,
      'current_streak', v_profile.current_streak,
      'longest_streak', v_profile.longest_streak,
      'last_daily_goal_completed_on', v_profile.last_daily_goal_completed_on
    )
  );
end;
$$;

comment on function public.commit_answer_transaction(
  uuid, uuid, uuid, uuid,
  text, integer, integer, integer, timestamptz, integer, integer, integer,
  boolean, integer, text,
  text, timestamptz, double precision, double precision, integer, integer, integer, integer, integer, integer, timestamptz,
  integer, integer, boolean, integer, integer, integer, boolean, text, integer, integer
) is
  'SECURITY DEFINER trusted workflow (DATABASE_SCHEMA.md 10.3-10.6). Atomically persists one already-computed answer (FSRS + battle result supplied by the trusted Next.js/ts-fsrs layer, never recomputed here). Recomputes deterministic card lifecycle, review/learning queue mechanics, XP, level, and Daily Goal/streak in Postgres. client_event_id idempotency is checked before any other validation so a delayed retry always replays safely. A Learning-mode Wrong answer sets BOTH forced_reappear_draw_index and next_eligible_draw_index to the same collision-shifted draw (20260927000000 follow-up): the card cannot be redrawn before that reserved draw, and must be drawn at it. Callable only by service_role -- p_user_id is a trusted caller-supplied parameter, independently re-verified against session/card/progress ownership on every call. search_path pinned to empty; all references schema-qualified.';

revoke all on function public.commit_answer_transaction(
  uuid, uuid, uuid, uuid,
  text, integer, integer, integer, timestamptz, integer, integer, integer,
  boolean, integer, text,
  text, timestamptz, double precision, double precision, integer, integer, integer, integer, integer, integer, timestamptz,
  integer, integer, boolean, integer, integer, integer, boolean, text, integer, integer
) from public, anon, authenticated;

grant execute on function public.commit_answer_transaction(
  uuid, uuid, uuid, uuid,
  text, integer, integer, integer, timestamptz, integer, integer, integer,
  boolean, integer, text,
  text, timestamptz, double precision, double precision, integer, integer, integer, integer, integer, integer, timestamptz,
  integer, integer, boolean, integer, integer, integer, boolean, text, integer, integer
) to service_role;
