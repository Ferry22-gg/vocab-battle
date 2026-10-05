-- Learning Engine v1 -- Runtime Cutover RC-C: the Answer Commit
-- Transaction (trusted lock -> validate -> persist path around the
-- already-complete, pure prepareLearningEngineAnswer()).
--
-- Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md and the RC-C
-- task brief. Builds on RC-A/RC-B (20261007000000, 20261008000000,
-- 20261009000000, 20261010000000, 20261011000000) and Phase 8
-- (20261003000000, 20261004000000, 20261005000000, 20261006000000)
-- without modifying any of them. Strictly additive: two new SECURITY
-- DEFINER, service_role-only trusted functions. Not wired into any live
-- Server Action or Session UI path -- commit_answer_transaction() (legacy)
-- is completely untouched except for the one forward-only engine-boundary
-- guard added in Section C below.
--
-- ---------------------------------------------------------------------
-- Architecture (unchanged from RC-A/RC-B's own precedent)
-- ---------------------------------------------------------------------
-- TypeScript (lib/learning-engine/runtime/prepare-answer.ts's
-- prepareLearningEngineAnswer, already reviewed) owns every Learning
-- Engine policy decision: which pure transition/FSRS/repair function
-- applies, the resulting card/FSRS/repair state, and the Battle result
-- (lib/learning/battle.ts's calculateBattleResult, unchanged). Postgres
-- authenticates, locks, validates structurally, and persists atomically.
-- Postgres does NOT reimplement stage-transition policy, repair-target
-- timing, FSRS scheduling, or mastery eligibility (spec section 33) --
-- the handful of values this migration DOES derive server-side
-- (card-mastered/mastery-XP eligibility, last_critical_due_position,
-- live mastered_count/full-mastery, Daily Goal/streak/XP arithmetic) are
-- either trivial before/after comparisons this function already has to
-- validate anyway, or Game-Economy bookkeeping with no Learning Engine
-- content, mirroring commit_answer_transaction()'s own established
-- arithmetic exactly (see Section B's header for the itemized list).
--
-- ---------------------------------------------------------------------
-- RC-C pre-check A: the answer-time concurrency contract
-- ---------------------------------------------------------------------
-- commit_learning_engine_v1_answer() does NOT require the deck's CURRENT
-- scheduler_revision to equal the claim's own scheduler_revision -- an
-- unrelated card insert/delete-toggle while the claim was open (RC-B's
-- own card-set-revision-bump correction) must not reject an otherwise-
-- valid answer. Instead it validates the claim itself (still OPEN, card
-- matches, trace matches) and the CLAIMED CARD'S OWN locked row against
-- `p_expected_card_before` (an optimistic lock on that specific row, not
-- the deck-wide token). scheduler_revision is still bumped by exactly 1
-- for this answer's own mutation, computed from the currently-locked
-- value (`v_deck_state.scheduler_revision + 1`), never
-- `claim.scheduler_revision + 1`.
--
-- ---------------------------------------------------------------------
-- RC-C pre-check B: active_draws_since_eligible
-- ---------------------------------------------------------------------
-- Exclusively a claim-time concern since
-- 20261011000000_learning_engine_v1_runtime_cutover_rc_b_active_draw_counters.sql.
-- This function never reads or writes it.
--
-- ---------------------------------------------------------------------
-- cards_since_last_seen / last_presented_scheduler_position
-- ---------------------------------------------------------------------
-- `cards_since_last_seen` is computed by TypeScript
-- (lib/learning-engine/telemetry/review-event.ts's deriveCardsSinceLastSeen,
-- fed the COMMITTED position, never the pre-answer trace echo -- see that
-- module's header) and forwarded verbatim inside `p_review_event`; this
-- function reads `last_presented_scheduler_position` BEFORE overwriting
-- it (so the caller's `previousPresentationSchedulerPosition` input was
-- genuinely authoritative), then persists the NEW committed position.
--
-- ---------------------------------------------------------------------
-- mastered_count / has_achieved_full_mastery: live recompute, not a
-- maintained delta
-- ---------------------------------------------------------------------
-- A delta ("+1 on not-LEARNED -> LEARNED") is NOT provably safe: a card
-- soft-delete/restore can change the deck's live LEARNED count and total
-- card count independently of any answer (RC-B's own card-set triggers
-- only bump scheduler_revision, never mastered_count). Rather than add a
-- second incremental-maintenance path with its own staleness race, this
-- function recomputes BOTH values as a live aggregate over
-- user_card_progress/cards at the end of every successful commit --
-- always exactly correct regardless of what happened via delete/restore
-- since the last answer, and consistent with this codebase's own existing
-- precedent (lib/decks/dal.ts's getMasteredCountsByDeck(), lib/stats/
-- dal.ts's getMasteredCardCount() already never trust the backfilled
-- `user_deck_learning_state.mastered_count` column -- see docs/
-- LEARNING_ENGINE_V1_RUNTIME_CUTOVER_TODO.md's "Stale
-- user_deck_learning_state"). `has_achieved_full_mastery` is updated with
-- a plain monotonic OR -- never cleared once true.
--
-- ---------------------------------------------------------------------
-- Answer idempotency and claim exactly-once consumption
-- ---------------------------------------------------------------------
-- `client_event_id` is checked FIRST, before any other validation,
-- against `answer_events` (the same table/column legacy answers already
-- use) -- a genuine retry of the SAME logical answer replays the
-- historical result without recomputing or re-mutating anything (same
-- discipline as commit_answer_transaction()'s own "idempotency check
-- happens first" ordering, Section A below). A DIFFERENT
-- `client_event_id` against a claim that is no longer OPEN (already
-- ANSWERED by a prior call, or ABANDONED) is rejected outright by the
-- claim-status check -- it is never treated as a new valid answer against
-- an already-consumed selection (spec section 30).
create function public.get_learning_engine_v1_answer_context(
  p_user_id uuid,
  p_session_id uuid,
  p_claim_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
  v_claim public.selection_claims;
  v_trace public.learning_engine_selection_traces;
  v_deck_state public.user_deck_learning_state;
  v_stat_date date;
  v_result jsonb;
begin
  if p_user_id is null then
    raise exception 'get_learning_engine_v1_answer_context: p_user_id is required'
      using errcode = '22023';
  end if;

  select * into v_session from public.sessions where id = p_session_id;
  if not found then
    raise exception 'get_learning_engine_v1_answer_context: session % not found', p_session_id
      using errcode = '22023';
  end if;
  if v_session.user_id <> p_user_id then
    raise exception 'get_learning_engine_v1_answer_context: session % does not belong to caller', p_session_id
      using errcode = '42501';
  end if;
  if v_session.status <> 'active' then
    raise exception 'get_learning_engine_v1_answer_context: session % is not active', p_session_id
      using errcode = '42501';
  end if;
  if v_session.engine_version <> 'v1' then
    raise exception 'get_learning_engine_v1_answer_context: session % is not an engine_version=v1 session', p_session_id
      using errcode = '42501';
  end if;

  -- RC-C design correction: the caller always already holds the exact
  -- claim_id it is trying to answer (the same identifier
  -- claimNextLearningEngineCard() returned) -- this function reads THAT
  -- claim directly, rather than "whichever claim is currently OPEN for
  -- this session". This is what makes a genuine client_event_id replay
  -- (section 30) work at all: the orchestration layer's own idempotency
  -- pre-check (lib/learning-engine/runtime/commit-answer.ts) must be able
  -- to short-circuit BEFORE ever reaching this read, but a caller
  -- submitting a genuinely NEW client_event_id against a claim that is no
  -- longer OPEN (already ANSWERED by a prior call, or ABANDONED) must
  -- still be rejected here, not silently treated as a new valid answer.
  select * into v_claim from public.selection_claims where id = p_claim_id;
  if not found or v_claim.user_id <> p_user_id or v_claim.session_id <> p_session_id then
    raise exception 'get_learning_engine_v1_answer_context: claim % does not belong to caller/session', p_claim_id
      using errcode = '42501';
  end if;
  if v_claim.status <> 'OPEN' then
    raise exception 'get_learning_engine_v1_answer_context: claim % is not OPEN (status %)', p_claim_id, v_claim.status
      using errcode = '42501';
  end if;

  select * into v_trace from public.learning_engine_selection_traces where id = v_claim.selection_trace_id;
  if not found then
    raise exception 'get_learning_engine_v1_answer_context: claim %''s selection trace not found', v_claim.id
      using errcode = '22023';
  end if;

  select * into v_deck_state
  from public.user_deck_learning_state
  where user_id = p_user_id and deck_id = v_session.deck_id;
  if not found then
    raise exception 'get_learning_engine_v1_answer_context: no user_deck_learning_state for user % deck %', p_user_id, v_session.deck_id
      using errcode = '42501';
  end if;

  v_stat_date := (now() at time zone 'Asia/Tokyo')::date;

  select jsonb_build_object(
    'userId', p_user_id,
    'deckId', v_session.deck_id,
    'now', now(),
    'session', jsonb_build_object(
      'comboBefore', v_session.current_combo,
      'enemyHpBefore', v_session.current_enemy_hp,
      'totalAnswersBefore', v_session.total_answers
    ),
    'claim', jsonb_build_object(
      'id', v_claim.id,
      'cardId', v_claim.card_id,
      'selectionTraceId', v_claim.selection_trace_id,
      'schedulerPosition', v_claim.scheduler_position,
      'schedulerRevision', v_claim.scheduler_revision,
      'status', v_claim.status
    ),
    'trace', jsonb_build_object(
      'source', v_trace.source,
      'selectionReason', v_trace.selection_reason,
      'schedulerMode', v_trace.scheduler_mode,
      'sourceWeightActive', v_trace.source_weight_active_normalized,
      'sourceWeightDue', v_trace.source_weight_due_normalized,
      'sourceWeightNear', v_trace.source_weight_near_normalized,
      'sourceWeightRandomMastered', v_trace.source_weight_random_mastered_normalized,
      'sourceWeightActiveRaw', v_trace.source_weight_active_raw,
      'sourceWeightDueRaw', v_trace.source_weight_due_raw,
      'sourceWeightNearRaw', v_trace.source_weight_near_raw,
      'sourceWeightRandomMasteredRaw', v_trace.source_weight_random_mastered_raw,
      'cardPriorityWeight', v_trace.card_priority_weight,
      'retrievability', v_trace.retrievability,
      'intervalProgress', v_trace.interval_progress,
      'candidateCount', case v_trace.source
        when 'ACTIVE' then v_trace.candidate_count_active
        when 'FSRS_DUE' then v_trace.candidate_count_due
        when 'NEAR_DUE' then v_trace.candidate_count_near
        when 'RANDOM_MASTERED' then v_trace.candidate_count_random_mastered
        else null
      end
    ),
    'deckState', jsonb_build_object(
      'schedulerPosition', v_deck_state.scheduler_position,
      'schedulerRevision', v_deck_state.scheduler_revision,
      'desiredRetention', v_deck_state.desired_retention,
      'policyVersion', v_deck_state.policy_version,
      'lastCriticalDuePosition', v_deck_state.last_critical_due_position,
      'masteredCount', v_deck_state.mastered_count,
      'hasAchievedFullMastery', v_deck_state.has_achieved_full_mastery
    ),
    'dailyGoal', (
      select jsonb_build_object(
        'enemiesDefeatedToday', coalesce(dus.enemies_defeated, 0),
        'completed', coalesce(dus.daily_goal_completed, false)
      )
      from public.daily_user_stats dus
      where dus.user_id = p_user_id and dus.stat_date = v_stat_date
    ),
    'card', (
      select jsonb_build_object(
        'cardId', ucp.card_id,
        'cardStatus', ucp.card_status,
        'learningStage', ucp.learning_stage,
        'poolStatus', ucp.pool_status,
        'relearningPhase', ucp.relearning_phase,
        'hasEverBeenMastered', ucp.has_ever_been_mastered,
        'repairPending', ucp.repair_pending,
        'repairWrongPosition', ucp.repair_wrong_position,
        'repairTargetPosition', ucp.repair_target_position,
        'repairHardCapPosition', ucp.repair_hard_cap_position,
        'correctCooldownUntilPosition', ucp.correct_cooldown_until_position,
        'fsrsReviewCorrectCount', ucp.fsrs_review_correct_count,
        'fsrsReviewCorrectStreak', ucp.fsrs_review_correct_streak,
        'fsrsDueAt', ucp.fsrs_due_at,
        'fsrsStability', ucp.fsrs_stability,
        'fsrsDifficulty', ucp.fsrs_difficulty,
        'fsrsElapsedDays', ucp.fsrs_elapsed_days,
        'fsrsScheduledDays', ucp.fsrs_scheduled_days,
        'fsrsReps', ucp.fsrs_reps,
        'fsrsLapses', ucp.fsrs_lapses,
        'fsrsLearningSteps', ucp.fsrs_learning_steps,
        'fsrsState', ucp.fsrs_state,
        'fsrsLastReviewAt', ucp.fsrs_last_review_at,
        'lastPresentedSchedulerPosition', ucp.last_presented_scheduler_position,
        'sameDaySeenCount', ucp.same_day_seen_count,
        'sameDayWrongCount', ucp.same_day_wrong_count,
        'sameDayProgressDate', ucp.same_day_progress_date,
        'lastSeenAt', ucp.last_seen_at
      )
      from public.user_card_progress ucp
      where ucp.user_id = p_user_id and ucp.card_id = v_claim.card_id
    )
  )
  into v_result;

  return v_result;
end;
$$;

comment on function public.get_learning_engine_v1_answer_context(uuid, uuid, uuid) is
  'Runtime Cutover RC-C: trusted single-statement read of one authoritative AnswerContext for one specific claim_id (session battle state, claim, its SelectionTrace, deck state, Daily Goal, and the claimed card''s full schedulable+FSRS+repair+same-day state). SECURITY DEFINER, service_role-only. Rejects a non-v1/inactive/foreign session, or a claim that does not belong to the caller/session or is not OPEN. The caller always already holds claim_id (from claimNextLearningEngineCard()''s own result) -- this never discovers "whichever claim is open". Read-only. Not wired into any live call site.';

revoke all on function public.get_learning_engine_v1_answer_context(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_learning_engine_v1_answer_context(uuid, uuid, uuid) to service_role;

-- =========================================================================
-- Section B: commit_learning_engine_v1_answer()
-- =========================================================================
create function public.commit_learning_engine_v1_answer(
  p_client_event_id uuid,
  p_user_id uuid,
  p_session_id uuid,
  p_claim_id uuid,
  p_card_id uuid,

  -- Optimistic concurrency / before-state validation (RC-C pre-check A:
  -- the CLAIM's own pre-answer scheduler_position, and the CLAIMED CARD's
  -- own locked row -- never the deck-wide scheduler_revision).
  p_expected_scheduler_position integer,
  p_expected_card_before jsonb,
  p_expected_session_combo_before integer,
  p_expected_session_enemy_hp_before integer,

  -- The already-computed result (TypeScript-owned policy; prepareLearningEngineAnswer).
  p_card_after jsonb,
  p_repair_obligation_after jsonb,

  -- Battle (lib/learning/battle.ts's calculateBattleResult, unchanged).
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

  -- Review-event telemetry: only the fields genuinely NOT re-derivable
  -- from already-locked/validated state (see this migration's header).
  -- Forwarded to insert_learning_engine_review_event, never a second
  -- event format.
  p_review_event jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Game Economy constants, mirroring commit_answer_transaction()'s own
  -- (unchanged) constants exactly -- spec section 23.
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
  -- Idempotency FIRST (same ordering discipline as commit_answer_transaction()):
  -- a genuine retry of the SAME logical answer replays, never re-mutates.
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

  -- =========================================================================
  -- Lock order: profile -> session -> claim -> card -> deck state ->
  -- daily_user_stats, the same fixed order convention every trusted
  -- Learning Engine v1 function already uses.
  -- =========================================================================
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

  -- =========================================================================
  -- RC-C pre-check A: optimistic-concurrency / before-state validation.
  -- The CLAIM's own pre-answer scheduler_position, never the deck-wide
  -- scheduler_revision. The CLAIMED CARD's own locked row, field-by-field.
  -- =========================================================================
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

  -- =========================================================================
  -- Battle-result structural invariants (same fixed-mechanics checks as
  -- commit_answer_transaction() -- the TS config ranges/damage formula
  -- itself is never reimplemented here, spec section 24).
  -- =========================================================================
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

  -- =========================================================================
  -- Scheduler deltas that belong exclusively to answer commit (spec
  -- sections 12-14): scheduler_position advances exactly once; one
  -- scheduler_revision bump for this answer's own mutation; the Critical
  -- Due marker, derived from the TRACE's own selection_reason (never
  -- trusted from the caller).
  -- =========================================================================
  v_new_scheduler_position := v_deck_state.scheduler_position + 1;
  v_new_scheduler_revision := v_deck_state.scheduler_revision + 1;
  v_should_update_last_critical_due_position := (v_trace.selection_reason = 'critical_due_interrupt');

  -- =========================================================================
  -- Same-day counters: Asia/Tokyo day-scoped bookkeeping, no Learning
  -- Engine policy content (spec section 17).
  -- =========================================================================
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

  -- =========================================================================
  -- Server-derived notification/XP-eligibility signals (trivially
  -- re-derivable from already-locked before-state and the validated
  -- after-state -- never trusted from the caller, spec sections 22/23).
  -- =========================================================================
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

  -- =========================================================================
  -- Persist: user_card_progress. FSRS columns only overwritten when this
  -- answer path actually touched FSRS (p_card_after carries an explicit
  -- fsrsTouched flag -- never inferred from a null due-date, which is
  -- also valid for a genuinely never-reviewed card).
  -- =========================================================================
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

  -- =========================================================================
  -- Persist: user_deck_learning_state. scheduler_position/revision,
  -- Critical Due marker, and the LIVE mastered_count/full-mastery
  -- recompute (this migration's own header) -- read back from the
  -- just-updated user_card_progress/cards, never a maintained delta.
  -- =========================================================================
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

  -- =========================================================================
  -- Review event (Phase 8, reused unchanged -- spec section 27). Linked
  -- to the claim's own SelectionTrace; scheduler_position/revision stay
  -- the trace's own (pre-answer) values, per that function's existing
  -- cross-check -- never the newly-committed ones (section 28).
  -- session_position is server-derived here, never trusted from the
  -- client (spec section 26).
  -- =========================================================================
  -- NOTE: v_trace.scheduler_revision, NEVER v_claim.scheduler_revision --
  -- the claim row's own scheduler_revision is the POST-claim value
  -- (RC-B's claim_next_learning_engine_card() persists v_next_revision
  -- onto the claim), while insert_learning_engine_review_event's own
  -- cross-check requires the linked trace's PRE-claim scheduler_revision
  -- (the two deliberately differ -- see RC-B's own pgTAP C18/C25
  -- assertions). v_claim.scheduler_position, by contrast, genuinely does
  -- equal the trace's scheduler_position (both are the pre-claim value).
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

  -- =========================================================================
  -- Game Economy: Daily Goal / streak / XP -- mirrors
  -- commit_answer_transaction()'s own established arithmetic exactly
  -- (spec section 25), no Learning Engine content.
  -- =========================================================================
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
      v_new_streak := v_profile.current_streak; -- defensive no-op, unreachable given the daily_user_stats guard above
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

  -- =========================================================================
  -- Close the claim (exactly-once); the primary answer_events row;
  -- first_v1_answer_at (set exactly once, never on replay/claim/abandon --
  -- spec section 34). A safe no-op UPDATE if no rollout row exists for
  -- this user (test fixtures routinely set engine_version='v1' directly,
  -- bypassing the rollout table -- the same documented precedent RC-B's
  -- own pgTAP/integration suites already establish) -- this function
  -- never inserts one, per RC-A's own explicit scope boundary.
  -- =========================================================================
  update public.selection_claims set status = 'ANSWERED', closed_at = now() where id = p_claim_id;
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
  'Runtime Cutover RC-C: the atomic Answer Commit Transaction. SECURITY DEFINER, service_role-only. Replays by client_event_id; validates claim exactly-once consumption, claim-specific card before-state (never deck-wide scheduler_revision equality, RC-C pre-check A), and Battle structural invariants; persists the already-computed card/FSRS/repair result, advances scheduler_position by exactly 1 and scheduler_revision by exactly 1, recomputes mastered_count/has_achieved_full_mastery live, writes the linked review event (via insert_learning_engine_review_event, unchanged), updates Daily Goal/streak/XP mirroring commit_answer_transaction()''s own arithmetic, closes the claim, and sets first_v1_answer_at exactly once. Never advances active_draws_since_eligible (claim-time only, RC-B). Not wired into any live call site.';

revoke all on function public.commit_learning_engine_v1_answer(
  uuid, uuid, uuid, uuid, uuid,
  integer, jsonb, integer, integer,
  jsonb, jsonb,
  boolean, integer, integer, integer, boolean, integer, integer, integer, boolean, text, integer, integer,
  jsonb
) from public, anon, authenticated;

grant execute on function public.commit_learning_engine_v1_answer(
  uuid, uuid, uuid, uuid, uuid,
  integer, jsonb, integer, integer,
  jsonb, jsonb,
  boolean, integer, integer, integer, boolean, integer, integer, integer, boolean, text, integer, integer,
  jsonb
) to service_role;

-- =========================================================================
-- Section C: legacy/v1 answer-path isolation (spec section 35).
-- Forward-only correction to commit_answer_transaction() (legacy) --
-- the smallest possible addition: reject an attempt to commit a LEGACY
-- answer against a v1-engine session. Does not rewrite any existing
-- legacy scheduling/lifecycle logic; every other line of that function is
-- untouched. commit_learning_engine_v1_answer() (above) already
-- independently rejects a non-v1 session on its own, so the v1 side of
-- this isolation already holds without any change.
-- =========================================================================
create or replace function public.commit_answer_transaction(
  p_client_event_id uuid,
  p_user_id uuid,
  p_session_id uuid,
  p_card_id uuid,

  p_expected_card_status_before text,
  p_expected_seen_count_before integer,
  p_expected_correct_streak_before integer,
  p_expected_wrong_streak_before integer,
  p_expected_fsrs_due_before timestamptz,
  p_expected_session_enemy_hp_before integer,
  p_expected_session_combo_before integer,
  p_expected_session_learning_draw_index integer,

  p_correct boolean,
  p_response_time_ms integer,
  p_session_mode text,

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

  -- RC-C forward-only correction (spec section 35: "legacy/v1 answer-path
  -- isolation"): the legacy trusted answer path must never commit against
  -- a v1-engine session -- the two lifecycle/queue models are mutually
  -- incompatible (this function writes session_learning_queue/
  -- session_review_cards and the legacy 4-value card_status enum
  -- semantics; a v1 session's card_status/learning_stage/pool_status are
  -- governed exclusively by commit_learning_engine_v1_answer()).
  if v_session.engine_version <> 'legacy' then
    raise exception 'commit_answer_transaction: session % is not a legacy-engine session (engine_version=%)', p_session_id, v_session.engine_version
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
  'SECURITY DEFINER trusted workflow (DATABASE_SCHEMA.md 10.3-10.6). Atomically persists one already-computed answer (FSRS + battle result supplied by the trusted Next.js/ts-fsrs layer, never recomputed here). Recomputes deterministic card lifecycle, review/learning queue mechanics, XP, level, and Daily Goal/streak in Postgres. client_event_id idempotency is checked before any other validation so a delayed retry always replays safely. A Learning-mode Wrong answer sets BOTH forced_reappear_draw_index and next_eligible_draw_index to the same collision-shifted draw (20260927000000 follow-up): the card cannot be redrawn before that reserved draw, and must be drawn at it. RC-C forward-only correction: rejects (42501) any session whose engine_version is not ''legacy'' -- the v1 answer path is exclusively commit_learning_engine_v1_answer(). Callable only by service_role -- p_user_id is a trusted caller-supplied parameter, independently re-verified against session/card/progress ownership on every call. search_path pinned to empty; all references schema-qualified.';

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
