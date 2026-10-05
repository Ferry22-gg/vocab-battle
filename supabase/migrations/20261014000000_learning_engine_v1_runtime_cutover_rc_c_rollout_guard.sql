-- Learning Engine v1 -- Runtime Cutover RC-C corrective migration: a
-- fresh v1 answer commit must require an existing learning_engine_v1_rollout
-- row for the caller, never silently no-op when one is missing.
--
-- Forward-only correction. Does not edit, rewrite, or reinterpret
-- 20261013000000_learning_engine_v1_runtime_cutover_rc_c_answer_commit.sql
-- (already applied) -- that migration's schema, its answer-context read
-- function, and every other branch of commit_learning_engine_v1_answer()
-- are left completely untouched. This migration CREATE OR REPLACEs
-- commit_learning_engine_v1_answer() in place (same signature -- no new
-- parameter, no new column) to add exactly one new validation step.
--
-- ---------------------------------------------------------------------
-- The gap (review finding, confirmed)
-- ---------------------------------------------------------------------
-- The original RC-C migration's final `update ... where user_id = p_user_id
-- and first_v1_answer_at is null` is a safe no-op when no
-- learning_engine_v1_rollout row exists for the caller -- correct as far
-- as "never fabricate rollout history" goes, but it means a fresh v1
-- answer could commit successfully for a tester who was never actually
-- admitted to the rollout at all. That silently allows v1-only persisted
-- state (card_status=ACQUIRED, scheduler_position advancing, etc.) to
-- accumulate for a tester with no recorded entry into the approved
-- one-way zone (RC-A's own R5) -- the rollout row is operational
-- authorization/history, not a bookkeeping nicety, and a session legally
-- reaching engine_version='v1' is supposed to already imply that
-- authorization exists.
--
-- ---------------------------------------------------------------------
-- The fix
-- ---------------------------------------------------------------------
-- One new check, placed immediately after the existing engine_version='v1'
-- validation and BEFORE any lock/mutation beyond the profile/session rows
-- already locked for that check -- i.e. strictly inside the "new event"
-- branch, never reached by a genuine client_event_id replay (the existing
-- idempotency-first check above it is completely unchanged, still the
-- very first thing this function does): if no learning_engine_v1_rollout
-- row exists for p_user_id, reject the WHOLE transaction atomically
-- (42501) -- no claim/card/session/XP/Daily-Goal/review-event mutation of
-- any kind occurs. Never auto-creates the row (still exclusively RC-A's
-- documented scope boundary: "no function in this migration deletes or
-- inserts rows here").
create or replace function public.commit_learning_engine_v1_answer(
  p_client_event_id uuid,
  p_user_id uuid,
  p_session_id uuid,
  p_claim_id uuid,
  p_card_id uuid,

  p_expected_scheduler_position integer,
  p_expected_card_before jsonb,
  p_expected_session_combo_before integer,
  p_expected_session_enemy_hp_before integer,

  p_card_after jsonb,
  p_repair_obligation_after jsonb,

  p_correct boolean,
  p_response_time_ms integer,
  p_base_damage integer,
  p_speed_bonus integer,
  p_critical boolean,
  p_combo_after integer,
  p_damage integer,
  p_enemy_hp_after integer,
  p_enemy_defeated boolean,
  p_new_enemy_type text,
  p_new_enemy_max_hp integer,
  p_new_enemy_hp integer,

  p_review_event jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_xp_correct_answer constant integer := 2;
  c_xp_mastery constant integer := 15;
  c_xp_enemy_defeated constant integer := 20;
  c_xp_daily_goal constant integer := 30;
  c_daily_goal_enemies constant integer := 5;
  c_combo_cap constant integer := 10;

  v_profile public.profiles;
  v_session public.sessions;
  v_claim public.selection_claims;
  v_trace public.learning_engine_selection_traces;
  v_card public.user_card_progress;
  v_deck_state public.user_deck_learning_state;
  v_existing_event public.answer_events;

  v_stat_date date;
  v_daily public.daily_user_stats;

  v_new_scheduler_position integer;
  v_new_scheduler_revision integer;
  v_should_update_last_critical_due_position boolean;

  v_fsrs_touched boolean;
  v_repair_after jsonb;

  v_same_day_seen_before integer;
  v_same_day_wrong_before integer;
  v_same_day_seen_after integer;
  v_same_day_wrong_after integer;
  v_seconds_since_last_seen bigint;

  v_card_mastered_just_now boolean;
  v_mastery_xp_reason text;
  v_mastery_xp integer := 0;

  v_mastered_count integer;
  v_total_card_count integer;
  v_has_achieved_full_mastery_after boolean;
  v_full_mastery_just_achieved boolean;

  v_cards_mastered_delta integer := 0;
  v_cards_forgotten_delta integer := 0;
  v_enemy_defeated_delta integer := 0;

  v_daily_goal_was_completed boolean;
  v_daily_goal_now_completed boolean := false;
  v_post_goal_answer boolean := false;

  v_answer_xp integer := 0;
  v_enemy_xp integer := 0;
  v_daily_goal_xp integer := 0;
  v_total_xp integer;

  v_answer_event public.answer_events;
  v_review_event public.answer_events;
  v_xp_row public.xp_events;
  v_xp_rows public.xp_events[] := array[]::public.xp_events[];

  v_new_total_xp integer;
  v_new_level integer;
  v_next_threshold integer;
  v_new_streak integer;
begin
  if p_user_id is null then
    raise exception 'commit_learning_engine_v1_answer: p_user_id is required'
      using errcode = '22023';
  end if;

  -- =========================================================================
  -- Idempotency FIRST -- UNCHANGED from the original RC-C migration. A
  -- genuine replay never reaches the rollout-row check below.
  -- =========================================================================
  select * into v_existing_event from public.answer_events where client_event_id = p_client_event_id;
  if found then
    if v_existing_event.user_id <> p_user_id
       or v_existing_event.session_id <> p_session_id
       or v_existing_event.card_id <> p_card_id then
      raise exception 'commit_learning_engine_v1_answer: client_event_id % already recorded for a different user/session/card', p_client_event_id
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
        where x.source_answer_event_id = v_existing_event.id and x.reason = 'daily_goal_completed'
      ),
      'card_mastered_just_now', exists (
        select 1 from public.xp_events x
        where x.source_answer_event_id = v_existing_event.id and x.reason in ('card_learned', 'card_relearned')
      ),
      'full_mastery_just_achieved', null,
      'user_card_progress', null,
      'session', null,
      'profile', null,
      'deck_state', null
    );
  end if;

  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'commit_learning_engine_v1_answer: no profile for user %', p_user_id
      using errcode = '28000';
  end if;
  if v_profile.account_status <> 'active' or v_profile.role <> 'tester' then
    raise exception 'commit_learning_engine_v1_answer: caller is not an active tester account'
      using errcode = '28000';
  end if;

  select * into v_session from public.sessions where id = p_session_id for update;
  if not found or v_session.user_id <> p_user_id or v_session.status <> 'active' then
    raise exception 'commit_learning_engine_v1_answer: session % is not an active session owned by %', p_session_id, p_user_id
      using errcode = '42501';
  end if;
  if v_session.engine_version <> 'v1' then
    raise exception 'commit_learning_engine_v1_answer: session % is not an engine_version=v1 session', p_session_id
      using errcode = '42501';
  end if;

  -- =========================================================================
  -- RC-C corrective: the rollout invariant (this migration's own header).
  -- A FRESH v1 answer commit (never a replay -- see above) requires an
  -- existing learning_engine_v1_rollout row for this user. Rejects the
  -- WHOLE transaction atomically -- no claim/card/session/XP/Daily-Goal/
  -- review-event mutation has happened yet at this point. Never
  -- auto-creates the row.
  -- =========================================================================
  if not exists (select 1 from public.learning_engine_v1_rollout where user_id = p_user_id) then
    raise exception 'commit_learning_engine_v1_answer: user % has no learning_engine_v1_rollout row -- an engine_version=v1 session must not exist without one', p_user_id
      using errcode = '42501';
  end if;

  -- Claim exactly-once consumption (spec section 30): a non-OPEN claim --
  -- whether already ANSWERED by a prior call or ABANDONED -- is rejected
  -- outright, regardless of client_event_id.
  select * into v_claim from public.selection_claims where id = p_claim_id for update;
  if not found or v_claim.user_id <> p_user_id or v_claim.session_id <> p_session_id then
    raise exception 'commit_learning_engine_v1_answer: claim % does not belong to caller/session', p_claim_id
      using errcode = '42501';
  end if;
  if v_claim.status <> 'OPEN' then
    raise exception 'commit_learning_engine_v1_answer: claim % is not OPEN (status %)', p_claim_id, v_claim.status
      using errcode = '42501';
  end if;
  if v_claim.card_id <> p_card_id then
    raise exception 'commit_learning_engine_v1_answer: p_card_id does not match claim %''s card', p_claim_id
      using errcode = '42501';
  end if;

  select * into v_trace from public.learning_engine_selection_traces where id = v_claim.selection_trace_id;
  if not found then
    raise exception 'commit_learning_engine_v1_answer: claim %''s selection trace not found', p_claim_id
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.cards where id = p_card_id and deck_id = v_session.deck_id and deleted_at is null
  ) then
    raise exception 'commit_learning_engine_v1_answer: card % is not a valid, non-deleted card in session %''s deck', p_card_id, p_session_id
      using errcode = '42501';
  end if;

  select * into v_card from public.user_card_progress where user_id = p_user_id and card_id = p_card_id for update;
  if not found then
    raise exception 'commit_learning_engine_v1_answer: no user_card_progress for user % card %', p_user_id, p_card_id
      using errcode = '42501';
  end if;

  select * into v_deck_state from public.user_deck_learning_state where user_id = p_user_id and deck_id = v_session.deck_id for update;
  if not found then
    raise exception 'commit_learning_engine_v1_answer: no user_deck_learning_state for user % deck %', p_user_id, v_session.deck_id
      using errcode = '42501';
  end if;

  v_stat_date := (now() at time zone 'Asia/Tokyo')::date;
  insert into public.daily_user_stats (user_id, stat_date, first_activity_at, last_activity_at)
  values (p_user_id, v_stat_date, now(), now())
  on conflict (user_id, stat_date) do nothing;
  select * into v_daily from public.daily_user_stats where user_id = p_user_id and stat_date = v_stat_date for update;

  if v_deck_state.scheduler_position <> p_expected_scheduler_position then
    raise exception 'commit_learning_engine_v1_answer: stale expected scheduler_position for user % deck % (expected %, actual %)',
      p_user_id, v_session.deck_id, p_expected_scheduler_position, v_deck_state.scheduler_position
      using errcode = '40001';
  end if;

  if v_card.card_status is distinct from (p_expected_card_before->>'cardStatus')
     or v_card.learning_stage is distinct from (p_expected_card_before->>'learningStage')
     or v_card.pool_status is distinct from (p_expected_card_before->>'poolStatus')
     or v_card.relearning_phase is distinct from (p_expected_card_before->>'relearningPhase')
     or v_card.has_ever_been_mastered is distinct from (p_expected_card_before->>'hasEverBeenMastered')::boolean
     or v_card.repair_pending is distinct from (p_expected_card_before->>'repairPending')::boolean
     or v_card.fsrs_review_correct_count is distinct from (p_expected_card_before->>'fsrsReviewCorrectCount')::integer
     or v_card.fsrs_review_correct_streak is distinct from (p_expected_card_before->>'fsrsReviewCorrectStreak')::integer
     or v_card.correct_cooldown_until_position is distinct from (p_expected_card_before->>'correctCooldownUntilPosition')::integer
     or v_card.repair_wrong_position is distinct from (p_expected_card_before->>'repairWrongPosition')::integer
     or v_card.repair_target_position is distinct from (p_expected_card_before->>'repairTargetPosition')::integer
     or v_card.repair_hard_cap_position is distinct from (p_expected_card_before->>'repairHardCapPosition')::integer
     or v_card.fsrs_due_at is distinct from (p_expected_card_before->>'fsrsDueAt')::timestamptz
     or v_card.fsrs_stability is distinct from (p_expected_card_before->>'fsrsStability')::double precision
     or v_card.fsrs_difficulty is distinct from (p_expected_card_before->>'fsrsDifficulty')::double precision
     or v_card.fsrs_elapsed_days is distinct from (p_expected_card_before->>'fsrsElapsedDays')::integer
     or v_card.fsrs_scheduled_days is distinct from (p_expected_card_before->>'fsrsScheduledDays')::integer
     or v_card.fsrs_reps is distinct from (p_expected_card_before->>'fsrsReps')::integer
     or v_card.fsrs_lapses is distinct from (p_expected_card_before->>'fsrsLapses')::integer
     or v_card.fsrs_learning_steps is distinct from (p_expected_card_before->>'fsrsLearningSteps')::integer
     or v_card.fsrs_state is distinct from (p_expected_card_before->>'fsrsState')::integer
     or v_card.fsrs_last_review_at is distinct from (p_expected_card_before->>'fsrsLastReviewAt')::timestamptz
  then
    raise exception 'commit_learning_engine_v1_answer: stale card-before state for user % card %', p_user_id, p_card_id
      using errcode = '40001';
  end if;

  if v_session.current_combo is distinct from p_expected_session_combo_before
     or v_session.current_enemy_hp is distinct from p_expected_session_enemy_hp_before then
    raise exception 'commit_learning_engine_v1_answer: stale session Battle state for session %', p_session_id
      using errcode = '40001';
  end if;

  if p_base_damage < 0 or p_speed_bonus < 0 or p_damage < 0 then
    raise exception 'commit_learning_engine_v1_answer: negative battle value'
      using errcode = '22023';
  end if;
  if p_combo_after < 0 or p_combo_after > c_combo_cap then
    raise exception 'commit_learning_engine_v1_answer: p_combo_after % out of range', p_combo_after
      using errcode = '22023';
  end if;
  if not p_correct then
    if p_damage <> 0 or p_combo_after <> 0 or p_critical then
      raise exception 'commit_learning_engine_v1_answer: a Wrong answer must have zero damage, zero combo, and no critical'
        using errcode = '22023';
    end if;
    if p_enemy_hp_after <> v_session.current_enemy_hp then
      raise exception 'commit_learning_engine_v1_answer: a Wrong answer must not change enemy HP'
        using errcode = '22023';
    end if;
  else
    if p_combo_after <> least(v_session.current_combo + 1, c_combo_cap) then
      raise exception 'commit_learning_engine_v1_answer: p_combo_after % is not a valid combo progression from %', p_combo_after, v_session.current_combo
        using errcode = '22023';
    end if;
    if p_enemy_hp_after <> greatest(0, v_session.current_enemy_hp - p_damage) then
      raise exception 'commit_learning_engine_v1_answer: p_enemy_hp_after is inconsistent with the reported damage'
        using errcode = '22023';
    end if;
  end if;
  if p_enemy_defeated <> (p_enemy_hp_after = 0) then
    raise exception 'commit_learning_engine_v1_answer: p_enemy_defeated is inconsistent with p_enemy_hp_after'
      using errcode = '22023';
  end if;
  if p_enemy_defeated then
    if p_new_enemy_type is null or p_new_enemy_type not in ('enemy_a', 'enemy_b', 'enemy_c')
       or p_new_enemy_max_hp is null or p_new_enemy_max_hp <= 0
       or p_new_enemy_hp is distinct from p_new_enemy_max_hp then
      raise exception 'commit_learning_engine_v1_answer: invalid next-enemy fields on defeat'
        using errcode = '22023';
    end if;
  else
    if p_new_enemy_type is not null or p_new_enemy_max_hp is not null or p_new_enemy_hp is not null then
      raise exception 'commit_learning_engine_v1_answer: next-enemy fields must be null when the enemy is not defeated'
        using errcode = '22023';
    end if;
  end if;

  v_new_scheduler_position := v_deck_state.scheduler_position + 1;
  v_new_scheduler_revision := v_deck_state.scheduler_revision + 1;
  v_should_update_last_critical_due_position := (v_trace.selection_reason = 'critical_due_interrupt');

  if v_card.same_day_progress_date is distinct from v_stat_date then
    v_same_day_seen_before := 0;
    v_same_day_wrong_before := 0;
  else
    v_same_day_seen_before := v_card.same_day_seen_count;
    v_same_day_wrong_before := v_card.same_day_wrong_count;
  end if;
  v_same_day_seen_after := v_same_day_seen_before + 1;
  v_same_day_wrong_after := v_same_day_wrong_before + (case when p_correct then 0 else 1 end);

  v_seconds_since_last_seen := case
    when v_card.last_seen_at is null then null
    else (extract(epoch from (now() - v_card.last_seen_at)))::bigint
  end;

  v_card_mastered_just_now := (v_card.card_status = 'ACQUIRED') and ((p_card_after->>'cardStatus') = 'LEARNED');
  if (p_card_after->>'cardStatus') = 'LEARNED' and v_card.card_status <> 'LEARNED' then
    v_mastery_xp_reason := case when v_card.card_status = 'FORGOTTEN' then 'card_relearned' else 'card_learned' end;
    v_mastery_xp := c_xp_mastery;
  end if;
  if (p_card_after->>'cardStatus') = 'LEARNED' and v_card.card_status <> 'LEARNED' then
    v_cards_mastered_delta := 1;
  end if;
  if (p_card_after->>'cardStatus') = 'FORGOTTEN' and v_card.card_status <> 'FORGOTTEN' then
    v_cards_forgotten_delta := 1;
  end if;

  v_fsrs_touched := coalesce((p_card_after->>'fsrsTouched')::boolean, false);
  v_repair_after := p_repair_obligation_after;

  update public.user_card_progress set
    card_status = p_card_after->>'cardStatus',
    learning_stage = p_card_after->>'learningStage',
    pool_status = p_card_after->>'poolStatus',
    relearning_phase = p_card_after->>'relearningPhase',
    has_ever_been_mastered = (p_card_after->>'hasEverBeenMastered')::boolean,
    fsrs_review_correct_count = (p_card_after->>'fsrsReviewCorrectCount')::integer,
    fsrs_review_correct_streak = (p_card_after->>'fsrsReviewCorrectStreak')::integer,
    correct_cooldown_until_position = (p_card_after->>'correctCooldownUntilPosition')::integer,

    repair_pending = (v_repair_after is not null),
    repair_wrong_position = case when v_repair_after is not null then (v_repair_after->>'wrongPosition')::integer else null end,
    repair_target_position = case when v_repair_after is not null then (v_repair_after->>'targetPosition')::integer else null end,
    repair_hard_cap_position = case when v_repair_after is not null then (v_repair_after->>'hardCapPosition')::integer else null end,

    fsrs_due_at = case when v_fsrs_touched then (p_card_after->>'fsrsDueAt')::timestamptz else fsrs_due_at end,
    fsrs_stability = case when v_fsrs_touched then (p_card_after->>'fsrsStability')::double precision else fsrs_stability end,
    fsrs_difficulty = case when v_fsrs_touched then (p_card_after->>'fsrsDifficulty')::double precision else fsrs_difficulty end,
    fsrs_elapsed_days = case when v_fsrs_touched then (p_card_after->>'fsrsElapsedDays')::integer else fsrs_elapsed_days end,
    fsrs_scheduled_days = case when v_fsrs_touched then (p_card_after->>'fsrsScheduledDays')::integer else fsrs_scheduled_days end,
    fsrs_reps = case when v_fsrs_touched then (p_card_after->>'fsrsReps')::integer else fsrs_reps end,
    fsrs_lapses = case when v_fsrs_touched then (p_card_after->>'fsrsLapses')::integer else fsrs_lapses end,
    fsrs_learning_steps = case when v_fsrs_touched then (p_card_after->>'fsrsLearningSteps')::integer else fsrs_learning_steps end,
    fsrs_state = case when v_fsrs_touched then (p_card_after->>'fsrsState')::integer else fsrs_state end,
    fsrs_last_review_at = case when v_fsrs_touched then (p_card_after->>'fsrsLastReviewAt')::timestamptz else fsrs_last_review_at end,

    last_presented_scheduler_position = v_new_scheduler_position,
    first_presented_at = coalesce(first_presented_at, now()),
    last_seen_at = now(),
    same_day_seen_count = v_same_day_seen_after,
    same_day_wrong_count = v_same_day_wrong_after,
    same_day_progress_date = v_stat_date
  where user_id = p_user_id and card_id = p_card_id;

  select count(*) into v_mastered_count
  from public.user_card_progress ucp
  join public.cards c on c.id = ucp.card_id
  where ucp.user_id = p_user_id and c.deck_id = v_session.deck_id and c.deleted_at is null and ucp.card_status = 'LEARNED';

  select count(*) into v_total_card_count
  from public.cards c
  where c.deck_id = v_session.deck_id and c.deleted_at is null;

  v_has_achieved_full_mastery_after := v_deck_state.has_achieved_full_mastery
    or (v_total_card_count > 0 and v_mastered_count = v_total_card_count);
  v_full_mastery_just_achieved := (not v_deck_state.has_achieved_full_mastery) and v_has_achieved_full_mastery_after;

  update public.user_deck_learning_state set
    scheduler_position = v_new_scheduler_position,
    scheduler_revision = v_new_scheduler_revision,
    last_critical_due_position = case when v_should_update_last_critical_due_position then v_new_scheduler_position else last_critical_due_position end,
    mastered_count = v_mastered_count,
    has_achieved_full_mastery = v_has_achieved_full_mastery_after
  where user_id = p_user_id and deck_id = v_session.deck_id;

  v_review_event := public.insert_learning_engine_review_event(
    p_client_event_id, p_user_id, v_session.deck_id, p_card_id, p_session_id, now(),
    v_session.total_answers + 1,
    v_claim.scheduler_position, v_trace.scheduler_revision,
    p_correct, p_response_time_ms, (p_review_event->>'timeToFirstActionMs')::integer,
    v_claim.selection_trace_id, v_trace.source, v_trace.selection_reason, v_trace.scheduler_mode,
    v_daily.daily_goal_completed,
    v_card.card_status, v_card.learning_stage, p_card_after->>'cardStatus', p_card_after->>'learningStage',
    (p_card_after->>'hasEverBeenMastered')::boolean,
    v_same_day_seen_before, v_same_day_wrong_before,
    (p_review_event->>'cardsSinceLastSeen')::integer, coalesce((p_review_event->>'secondsSinceLastSeen')::bigint, v_seconds_since_last_seen),
    v_card.repair_pending, (p_review_event->>'isRepairRetry')::boolean, (p_review_event->>'isStageAdvancingSuccess')::boolean,
    (p_review_event->>'fsrsDBefore')::double precision, (p_review_event->>'fsrsSBefore')::double precision, (p_review_event->>'fsrsRBefore')::double precision,
    (p_review_event->>'fsrsDAfter')::double precision, (p_review_event->>'fsrsSAfter')::double precision, (p_review_event->>'fsrsRAfter')::double precision,
    (p_review_event->>'scheduledIntervalSec')::integer, (p_review_event->>'intervalProgress')::double precision, (p_review_event->>'daysOverdue')::double precision,
    v_card.fsrs_review_correct_count, v_card.fsrs_review_correct_streak,
    (p_review_event->>'sourceWeightActive')::double precision, (p_review_event->>'sourceWeightDue')::double precision,
    (p_review_event->>'sourceWeightNear')::double precision, (p_review_event->>'sourceWeightRandomMastered')::double precision,
    (p_review_event->>'sourceWeightActiveRaw')::double precision, (p_review_event->>'sourceWeightDueRaw')::double precision,
    (p_review_event->>'sourceWeightNearRaw')::double precision, (p_review_event->>'sourceWeightRandomMasteredRaw')::double precision,
    v_trace.card_priority_weight, (p_review_event->>'candidateCount')::integer,
    p_review_event->>'policyVersion', p_review_event->>'fsrsVersion', p_review_event->>'parameterSetId', p_review_event->>'experimentAssignmentId'
  );

  v_daily_goal_was_completed := v_daily.daily_goal_completed;
  v_enemy_defeated_delta := case when p_enemy_defeated then 1 else 0 end;

  if not v_daily_goal_was_completed and (v_daily.enemies_defeated + v_enemy_defeated_delta) >= c_daily_goal_enemies then
    v_daily_goal_now_completed := true;
  end if;
  v_post_goal_answer := v_daily_goal_was_completed;

  if p_correct then
    v_answer_xp := c_xp_correct_answer;
  end if;
  if p_enemy_defeated then
    v_enemy_xp := c_xp_enemy_defeated;
  end if;
  if v_daily_goal_now_completed then
    v_daily_goal_xp := c_xp_daily_goal;
  end if;
  v_total_xp := v_answer_xp + v_mastery_xp + v_enemy_xp + v_daily_goal_xp;

  if v_answer_xp > 0 then
    insert into public.xp_events (user_id, session_id, card_id, source_answer_event_id, amount, reason)
    values (p_user_id, p_session_id, p_card_id, v_review_event.id, v_answer_xp, 'correct_answer')
    returning * into v_xp_row;
    v_xp_rows := array_append(v_xp_rows, v_xp_row);
  end if;
  if v_mastery_xp > 0 then
    insert into public.xp_events (user_id, session_id, card_id, source_answer_event_id, amount, reason)
    values (p_user_id, p_session_id, p_card_id, v_review_event.id, v_mastery_xp, v_mastery_xp_reason)
    returning * into v_xp_row;
    v_xp_rows := array_append(v_xp_rows, v_xp_row);
  end if;
  if v_enemy_xp > 0 then
    insert into public.xp_events (user_id, session_id, card_id, source_answer_event_id, amount, reason)
    values (p_user_id, p_session_id, p_card_id, v_review_event.id, v_enemy_xp, 'enemy_defeated')
    returning * into v_xp_row;
    v_xp_rows := array_append(v_xp_rows, v_xp_row);
  end if;
  if v_daily_goal_xp > 0 then
    insert into public.xp_events (user_id, session_id, card_id, source_answer_event_id, amount, reason)
    values (p_user_id, p_session_id, p_card_id, v_review_event.id, v_daily_goal_xp, 'daily_goal_completed')
    returning * into v_xp_row;
    v_xp_rows := array_append(v_xp_rows, v_xp_row);
  end if;

  update public.daily_user_stats set
    last_activity_at = now(),
    total_answers = total_answers + 1,
    correct_answers = correct_answers + (case when p_correct then 1 else 0 end),
    wrong_answers = wrong_answers + (case when p_correct then 0 else 1 end),
    cards_mastered = cards_mastered + v_cards_mastered_delta,
    cards_forgotten = cards_forgotten + v_cards_forgotten_delta,
    enemies_defeated = enemies_defeated + v_enemy_defeated_delta,
    critical_hits = critical_hits + (case when p_critical then 1 else 0 end),
    longest_combo = greatest(longest_combo, p_combo_after),
    xp_gained = xp_gained + v_total_xp,
    daily_goal_completed = daily_goal_completed or v_daily_goal_now_completed,
    daily_goal_completed_at = case when v_daily_goal_now_completed then now() else daily_goal_completed_at end,
    continued_after_daily_goal = continued_after_daily_goal or v_post_goal_answer,
    post_goal_answers = post_goal_answers + (case when v_post_goal_answer then 1 else 0 end)
  where id = v_daily.id
  returning * into v_daily;

  update public.sessions set
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
    xp_gained = xp_gained + v_total_xp,
    daily_goal_progress = least(v_daily.enemies_defeated, c_daily_goal_enemies),
    daily_goal_completed = v_daily.daily_goal_completed,
    continued_after_daily_goal = continued_after_daily_goal or v_post_goal_answer,
    last_active_at = now()
  where id = p_session_id
  returning * into v_session;

  v_new_total_xp := v_profile.total_xp + v_total_xp;
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
      v_new_streak := v_profile.current_streak;
    else
      v_new_streak := 1;
    end if;
  else
    v_new_streak := v_profile.current_streak;
  end if;

  update public.profiles set
    total_xp = v_new_total_xp,
    level = v_new_level,
    total_enemies_defeated = total_enemies_defeated + v_enemy_defeated_delta,
    current_streak = v_new_streak,
    longest_streak = greatest(longest_streak, v_new_streak),
    last_daily_goal_completed_on = case when v_daily_goal_now_completed then v_stat_date else last_daily_goal_completed_on end,
    last_active_at = now()
  where id = p_user_id
  returning * into v_profile;

  update public.selection_claims set status = 'ANSWERED', closed_at = now() where id = p_claim_id;
  -- Set exactly once, on this (now-guaranteed-to-exist) row.
  update public.learning_engine_v1_rollout set first_v1_answer_at = now() where user_id = p_user_id and first_v1_answer_at is null;

  select * into v_answer_event from public.answer_events where client_event_id = p_client_event_id;

  return jsonb_build_object(
    'is_replay', false,
    'answer_event', to_jsonb(v_answer_event),
    'xp_events', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from unnest(v_xp_rows) x),
    'daily_goal_just_completed', v_daily_goal_now_completed,
    'card_mastered_just_now', v_card_mastered_just_now,
    'full_mastery_just_achieved', v_full_mastery_just_achieved,
    'user_card_progress', (select to_jsonb(ucp) from public.user_card_progress ucp where ucp.user_id = p_user_id and ucp.card_id = p_card_id),
    'session', to_jsonb(v_session),
    'profile', jsonb_build_object(
      'total_xp', v_profile.total_xp,
      'level', v_profile.level,
      'current_streak', v_profile.current_streak,
      'longest_streak', v_profile.longest_streak,
      'last_daily_goal_completed_on', v_profile.last_daily_goal_completed_on
    ),
    'deck_state', jsonb_build_object(
      'schedulerPosition', v_new_scheduler_position,
      'schedulerRevision', v_new_scheduler_revision,
      'masteredCount', v_mastered_count,
      'hasAchievedFullMastery', v_has_achieved_full_mastery_after
    )
  );
end;
$$;

comment on function public.commit_learning_engine_v1_answer(
  uuid, uuid, uuid, uuid, uuid,
  integer, jsonb, integer, integer,
  jsonb, jsonb,
  boolean, integer, integer, integer, boolean, integer, integer, integer, boolean, text, integer, integer,
  jsonb
) is
  'Runtime Cutover RC-C (corrected): the atomic Answer Commit Transaction. SECURITY DEFINER, service_role-only. Replays by client_event_id (never re-mutates); for a FRESH event, requires an existing learning_engine_v1_rollout row for the caller (rejects 42501 atomically otherwise -- an engine_version=v1 session must not exist without rollout admission; never auto-creates the row); validates claim exactly-once consumption, claim-specific card before-state (never deck-wide scheduler_revision equality, RC-C pre-check A), and Battle structural invariants; persists the already-computed card/FSRS/repair result, advances scheduler_position by exactly 1 and scheduler_revision by exactly 1, recomputes mastered_count/has_achieved_full_mastery live, writes the linked review event, updates Daily Goal/streak/XP mirroring commit_answer_transaction()''s own arithmetic, closes the claim, and sets first_v1_answer_at exactly once. Never advances active_draws_since_eligible (claim-time only, RC-B). Not wired into any live call site.';
