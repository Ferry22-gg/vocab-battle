-- Learning Engine v1 -- Stage 0 audit follow-up: Alpha-audit telemetry
-- additions (the position-based "after" facts the audit found were
-- reconstructable only by replaying position differences across many
-- rows, never readable directly from a single answer_event).
--
-- Forward-only. Does not edit any already-applied migration.
--
-- ---------------------------------------------------------------------
-- Additive schema: four new nullable columns on answer_events
-- ---------------------------------------------------------------------
-- All four are explicitly AFTER this answer's processing (repair_pending_
-- before already exists and already covers the BEFORE side -- see
-- 20261003000000_learning_engine_v1_telemetry.sql). Nullable, no backfill,
-- no default other than NULL: every row written before this migration
-- (including every one of tester 951's historical Stage 0 answers) simply
-- has NULL for all four -- an honest "not captured at the time", never a
-- fabricated reconstruction. This is a pure additive migration: it does
-- not touch, recompute, or backfill a single existing row.
alter table public.answer_events
  add column repair_pending_after boolean,
  add column repair_target_position_after integer,
  add column repair_hard_cap_position_after integer,
  add column correct_cooldown_until_position_after integer;

alter table public.answer_events
  add constraint answer_events_repair_target_position_after_check
    check (repair_target_position_after is null or repair_target_position_after >= 0),
  add constraint answer_events_repair_hard_cap_position_after_check
    check (repair_hard_cap_position_after is null or repair_hard_cap_position_after >= 0),
  add constraint answer_events_correct_cooldown_until_position_after_check
    check (correct_cooldown_until_position_after is null or correct_cooldown_until_position_after >= 0);

comment on column public.answer_events.repair_pending_after is
  'Stage 0 audit follow-up: user_card_progress.repair_pending immediately AFTER this answer''s transition (repairPendingBefore already covers BEFORE). NULL for every row written before this migration.';
comment on column public.answer_events.repair_target_position_after is
  'Stage 0 audit follow-up: the repair obligation''s targetPosition AFTER this answer, or NULL if no repair obligation exists after it (never cleared vs. never created). NULL for every row written before this migration.';
comment on column public.answer_events.repair_hard_cap_position_after is
  'Stage 0 audit follow-up: the repair obligation''s hardCapPosition AFTER this answer, or NULL if no repair obligation exists after it. NULL for every row written before this migration.';
comment on column public.answer_events.correct_cooldown_until_position_after is
  'Stage 0 audit follow-up: the normal-Correct-cooldown gate (correctCooldownUntilPosition) in force AFTER this answer, or NULL if none is. NULL for every row written before this migration.';

-- ---------------------------------------------------------------------
-- insert_learning_engine_review_event: DROP + CREATE (not CREATE OR
-- REPLACE), matching this project's own established precedent for
-- changing this function's parameter list
-- (20261006000000_learning_engine_v1_streak_minimum_removal.sql, which
-- removed a parameter the same way) -- Postgres cannot CREATE OR REPLACE
-- a function onto a different parameter list; it would silently create a
-- second overload instead of replacing this one.
-- ---------------------------------------------------------------------
drop function public.insert_learning_engine_review_event(
  uuid, uuid, uuid, uuid, uuid, timestamptz,
  integer, integer, integer,
  boolean, integer, integer,
  uuid, text, text, text,
  boolean,
  text, text, text, text, boolean,
  integer, integer, integer, bigint,
  boolean, boolean, boolean,
  double precision, double precision, double precision, double precision, double precision, double precision,
  integer, double precision, double precision,
  integer, integer,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  double precision, integer,
  text, text, text, text
);

create function public.insert_learning_engine_review_event(
  p_client_event_id uuid,
  p_user_id uuid,
  p_deck_id uuid,
  p_card_id uuid,
  p_session_id uuid,
  p_occurred_at timestamptz,

  p_session_position integer,
  p_scheduler_position integer,
  p_scheduler_revision integer,

  p_correct boolean,
  p_response_time_ms integer,
  p_time_to_first_action_ms integer,

  p_selection_trace_id uuid,
  p_source text,
  p_selection_reason text,
  p_scheduler_mode text,

  p_daily_goal_complete_before boolean,

  p_card_status_before text,
  p_learning_stage_before text,
  p_card_status_after text,
  p_learning_stage_after text,
  p_has_ever_been_mastered boolean,

  p_same_day_seen_count_before integer,
  p_same_day_wrong_count_before integer,
  p_cards_since_last_seen integer,
  p_seconds_since_last_seen bigint,

  p_repair_pending_before boolean,
  p_is_repair_retry boolean,
  p_is_stage_advancing_success boolean,

  p_fsrs_d_before double precision,
  p_fsrs_s_before double precision,
  p_fsrs_r_before double precision,
  p_fsrs_d_after double precision,
  p_fsrs_s_after double precision,
  p_fsrs_r_after double precision,

  p_scheduled_interval_sec integer,
  p_interval_progress double precision,
  p_days_overdue double precision,

  p_fsrs_review_correct_count_before integer,
  p_fsrs_review_correct_streak_before integer,

  p_source_weight_active double precision,
  p_source_weight_due double precision,
  p_source_weight_near double precision,
  p_source_weight_random_mastered double precision,
  p_source_weight_active_raw double precision,
  p_source_weight_due_raw double precision,
  p_source_weight_near_raw double precision,
  p_source_weight_random_mastered_raw double precision,

  p_card_priority_weight double precision,
  p_candidate_count integer,

  p_policy_version text,
  p_fsrs_version text,
  p_parameter_set_id text,
  p_experiment_assignment_id text,

  -- Stage 0 audit follow-up: the four new Alpha-audit telemetry fields.
  -- Appended at the end (never interleaved into the original list) so
  -- every already-reviewed parameter above keeps its exact original
  -- position.
  p_repair_pending_after boolean default null,
  p_repair_target_position_after integer default null,
  p_repair_hard_cap_position_after integer default null,
  p_correct_cooldown_until_position_after integer default null
) returns public.answer_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.answer_events;
  v_session public.sessions;
  v_card public.cards;
  v_trace public.learning_engine_selection_traces;
  v_result public.answer_events;
begin
  -- =========================================================================
  -- Idempotency FIRST (this phase's brief section 21; same ordering
  -- rationale as commit_answer_transaction()'s own "idempotency check
  -- happens first... a legitimate delayed retry is never rejected just
  -- because the original processing already advanced state"). A replay
  -- returns the original historical row completely unchanged -- it never
  -- re-validates, re-derives, or re-inserts anything.
  -- =========================================================================
  select * into v_existing from public.answer_events where client_event_id = p_client_event_id;
  if found then
    return v_existing;
  end if;

  -- =========================================================================
  -- Cross-entity consistency (this phase's brief section 17).
  -- =========================================================================
  select * into v_session from public.sessions where id = p_session_id;
  if not found then
    raise exception 'insert_learning_engine_review_event: session not found' using errcode = '22023';
  end if;
  if v_session.user_id <> p_user_id then
    raise exception 'insert_learning_engine_review_event: session does not belong to the given user' using errcode = '42501';
  end if;
  if v_session.deck_id <> p_deck_id then
    raise exception 'insert_learning_engine_review_event: session does not belong to the given deck' using errcode = '42501';
  end if;

  select * into v_card from public.cards where id = p_card_id;
  if not found then
    raise exception 'insert_learning_engine_review_event: card not found' using errcode = '22023';
  end if;
  if v_card.deck_id <> p_deck_id then
    raise exception 'insert_learning_engine_review_event: card does not belong to the given deck' using errcode = '42501';
  end if;

  -- Section 9/22 of this phase's brief, section 21 of the normative spec:
  -- "every answered v1 card should reference the exact persisted
  -- selection trace that produced it... legacy answer_events may leave it
  -- NULL" -- so p_selection_trace_id is nullable (a legacy-shaped or
  -- not-yet-linked v1 row), but whenever it IS supplied, every dimension
  -- of the trace must agree with this event, including the newly added
  -- scheduler_position/scheduler_revision (this phase's brief section 4:
  -- "event scheduler_position must match the linked trace's
  -- scheduler_position", same for scheduler_revision).
  if p_selection_trace_id is not null then
    select * into v_trace from public.learning_engine_selection_traces where id = p_selection_trace_id;
    if not found then
      raise exception 'insert_learning_engine_review_event: selection trace not found' using errcode = '22023';
    end if;
    if v_trace.user_id <> p_user_id then
      raise exception 'insert_learning_engine_review_event: selection trace does not belong to the given user' using errcode = '42501';
    end if;
    if v_trace.deck_id <> p_deck_id then
      raise exception 'insert_learning_engine_review_event: selection trace does not belong to the given deck' using errcode = '42501';
    end if;
    if v_trace.session_id <> p_session_id then
      raise exception 'insert_learning_engine_review_event: selection trace does not belong to the given session' using errcode = '42501';
    end if;
    -- Section 31 of the normative spec: "there is no answered card/event"
    -- for a no_card_all_unavailable decision -- a trace with card_id NULL
    -- can never legitimately be linked to an answer_event.
    if v_trace.card_id is null then
      raise exception 'insert_learning_engine_review_event: selection trace has no card and cannot be linked to an answer event' using errcode = '22023';
    end if;
    if v_trace.card_id <> p_card_id then
      raise exception 'insert_learning_engine_review_event: selection trace card does not match the given card' using errcode = '42501';
    end if;
    if v_trace.scheduler_position <> p_scheduler_position then
      raise exception 'insert_learning_engine_review_event: scheduler_position does not match the linked selection trace' using errcode = '42501';
    end if;
    if v_trace.scheduler_revision <> p_scheduler_revision then
      raise exception 'insert_learning_engine_review_event: scheduler_revision does not match the linked selection trace' using errcode = '42501';
    end if;
    -- "trace is not reused for a different answer/card": the unique
    -- partial index on answer_events.selection_trace_id enforces this
    -- atomically on the INSERT below -- a second attempt to link the same
    -- trace raises a unique_violation (23505), never a silent overwrite.
  end if;

  -- =========================================================================
  -- Insert. Legacy-only columns with NO v1 equivalent concept
  -- (card_seen_count_at_answer, correct_streak_before/after,
  -- wrong_streak_before/after) remain NOT NULL on this table -- the Phase
  -- 8 schema review deliberately did not relax them (relaxing a pre-
  -- existing legacy constraint was out of that review's scope). They are
  -- written as the literal placeholder 0 here: not a fabricated v1
  -- telemetry fact, but the only value that satisfies a constraint this
  -- phase correctly chose not to touch. The AUTHORITATIVE v1 record of
  -- this kind of information is same_day_seen_count_before/
  -- fsrs_review_correct_count_before/_streak_before below, not these five
  -- legacy columns. previous_answer/time_since_last_seen/
  -- previous_review_interval/fsrs_rating/fsrs_due_before/after are left
  -- NULL for the same "distinct v1-named column already carries this
  -- concept" reason the approved migration documents for
  -- seconds_since_last_seen vs. time_since_last_seen. base_damage/
  -- speed_bonus/combo/damage/critical/enemy_hp_before/after are omitted
  -- entirely from the column list below (Battle Engine concepts, not
  -- named by this function at all -- their existing defaults/NULL apply).
  -- =========================================================================
  insert into public.answer_events (
    client_event_id, user_id, card_id, deck_id, session_id, answered_at,
    correct, response_time_ms, session_mode,
    card_seen_count_at_answer, correct_streak_before, wrong_streak_before,
    card_status_before, card_status_after, correct_streak_after, wrong_streak_after,

    session_position, scheduler_position, scheduler_revision,
    time_to_first_action_ms,
    selection_trace_id, source, selection_reason, scheduler_mode,
    daily_goal_complete_before,
    learning_stage_before, learning_stage_after, has_ever_been_mastered,
    same_day_seen_count_before, same_day_wrong_count_before, cards_since_last_seen, seconds_since_last_seen,
    repair_pending_before, is_repair_retry, is_stage_advancing_success,
    fsrs_d_before, fsrs_s_before, fsrs_r_before, fsrs_d_after, fsrs_s_after, fsrs_r_after,
    scheduled_interval_sec, interval_progress, days_overdue,
    fsrs_review_correct_count_before, fsrs_review_correct_streak_before,
    source_weight_active, source_weight_due, source_weight_near, source_weight_random_mastered,
    source_weight_active_raw, source_weight_due_raw, source_weight_near_raw, source_weight_random_mastered_raw,
    card_priority_weight, candidate_count,
    policy_version, fsrs_version, parameter_set_id, experiment_assignment_id,
    repair_pending_after, repair_target_position_after, repair_hard_cap_position_after, correct_cooldown_until_position_after
  ) values (
    p_client_event_id, p_user_id, p_card_id, p_deck_id, p_session_id, p_occurred_at,
    p_correct, p_response_time_ms, 'v1',
    0, 0, 0,
    p_card_status_before, p_card_status_after, 0, 0,

    p_session_position, p_scheduler_position, p_scheduler_revision,
    p_time_to_first_action_ms,
    p_selection_trace_id, p_source, p_selection_reason, p_scheduler_mode,
    p_daily_goal_complete_before,
    p_learning_stage_before, p_learning_stage_after, p_has_ever_been_mastered,
    p_same_day_seen_count_before, p_same_day_wrong_count_before, p_cards_since_last_seen, p_seconds_since_last_seen,
    p_repair_pending_before, p_is_repair_retry, p_is_stage_advancing_success,
    p_fsrs_d_before, p_fsrs_s_before, p_fsrs_r_before, p_fsrs_d_after, p_fsrs_s_after, p_fsrs_r_after,
    p_scheduled_interval_sec, p_interval_progress, p_days_overdue,
    p_fsrs_review_correct_count_before, p_fsrs_review_correct_streak_before,
    p_source_weight_active, p_source_weight_due, p_source_weight_near, p_source_weight_random_mastered,
    p_source_weight_active_raw, p_source_weight_due_raw, p_source_weight_near_raw, p_source_weight_random_mastered_raw,
    p_card_priority_weight, p_candidate_count,
    p_policy_version, p_fsrs_version, p_parameter_set_id, p_experiment_assignment_id,
    p_repair_pending_after, p_repair_target_position_after, p_repair_hard_cap_position_after, p_correct_cooldown_until_position_after
  )
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.insert_learning_engine_review_event is
  'Phase 8 trusted persistence primitive for v1 answer_events rows (session_mode = ''v1''). SECURITY DEFINER, service_role-only. Stage 0 audit follow-up: accepts and persists four additional Alpha-audit telemetry fields (repair_pending_after, repair_target_position_after, repair_hard_cap_position_after, correct_cooldown_until_position_after), all defaulted to NULL for backward compatibility. Replays by client_event_id; validates session/card/trace cross-entity consistency, including scheduler_position/scheduler_revision agreement with a linked trace, before inserting. Never call this for a legacy (review/learning) answer -- that path remains commit_answer_transaction() exclusively.';

revoke all on function public.insert_learning_engine_review_event(
  uuid, uuid, uuid, uuid, uuid, timestamptz,
  integer, integer, integer,
  boolean, integer, integer,
  uuid, text, text, text,
  boolean,
  text, text, text, text, boolean,
  integer, integer, integer, bigint,
  boolean, boolean, boolean,
  double precision, double precision, double precision, double precision, double precision, double precision,
  integer, double precision, double precision,
  integer, integer,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  double precision, integer,
  text, text, text, text,
  boolean, integer, integer, integer
) from public, anon, authenticated;

grant execute on function public.insert_learning_engine_review_event(
  uuid, uuid, uuid, uuid, uuid, timestamptz,
  integer, integer, integer,
  boolean, integer, integer,
  uuid, text, text, text,
  boolean,
  text, text, text, text, boolean,
  integer, integer, integer, bigint,
  boolean, boolean, boolean,
  double precision, double precision, double precision, double precision, double precision, double precision,
  integer, double precision, double precision,
  integer, integer,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  double precision, integer,
  text, text, text, text,
  boolean, integer, integer, integer
) to service_role;

-- ---------------------------------------------------------------------
-- commit_learning_engine_v1_answer: CREATE OR REPLACE, SAME signature
-- (p_review_event stays one JSONB parameter -- the four new facts are
-- new KEYS inside it, not new SQL parameters), matching
-- 20261018000000_learning_engine_v1_battle_replay_fidelity.sql's own
-- precedent exactly ("CREATE OR REPLACEs ... in place (identical
-- signature, no new parameter, no new column) to add exactly one
-- [change]"). Every line is copied unchanged from that migration except
-- the one insert_learning_engine_review_event(...) call, which now also
-- passes the four new trailing arguments (extracted from p_review_event,
-- the same already-pure-TS-computed values commit-answer.ts's
-- buildReviewEventPayload()/reviewEventRpcPayload() already produce --
-- never re-derived in SQL).
-- ---------------------------------------------------------------------
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
  -- genuine replay never reaches the rollout-row check below, and now
  -- returns a FULLY FAITHFUL historical answer_event row (this
  -- migration's whole fix lives in the fresh-commit path below; this
  -- branch needed no change at all to benefit from it).
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
  -- RC-C corrective: the rollout invariant (unchanged). A FRESH v1
  -- answer commit (never a replay -- see above) requires an existing
  -- learning_engine_v1_rollout row for this user. Rejects the WHOLE
  -- transaction atomically -- no claim/card/session/XP/Daily-Goal/
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
    p_review_event->>'policyVersion', p_review_event->>'fsrsVersion', p_review_event->>'parameterSetId', p_review_event->>'experimentAssignmentId',
    (p_review_event->>'repairPendingAfter')::boolean, (p_review_event->>'repairTargetPositionAfter')::integer,
    (p_review_event->>'repairHardCapPositionAfter')::integer, (p_review_event->>'correctCooldownUntilPositionAfter')::integer
  );

  -- =========================================================================
  -- THE FIX (this migration's own header): persist the already-validated
  -- Battle result onto the row insert_learning_engine_review_event() just
  -- created. Every value here was already checked against locked
  -- session/card state above (combo progression, enemy-HP arithmetic,
  -- next-enemy fields on defeat) -- this is a pure persistence step, not
  -- a new calculation or a new trust decision.
  -- =========================================================================
  update public.answer_events
  set base_damage = p_base_damage,
      speed_bonus = p_speed_bonus,
      critical = p_critical,
      combo = p_combo_after,
      damage = p_damage,
      enemy_hp_before = p_expected_session_enemy_hp_before,
      enemy_hp_after = p_enemy_hp_after
  where id = v_review_event.id;

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
  'Runtime Cutover RC-C: the atomic Answer Commit Transaction. SECURITY DEFINER, service_role-only. Stage 0 audit follow-up (20261023000000): the Repair-timing/Correct-cooldown position-semantics fix lives entirely in the pure TypeScript layer (lib/learning-engine/runtime/prepare-answer.ts) that computes p_card_after/p_repair_obligation_after/p_review_event -- this function''s own body is otherwise unchanged from 20261018000000, except that it now also forwards four additional already-computed Alpha-audit telemetry fields (repairPendingAfter/repairTargetPositionAfter/repairHardCapPositionAfter/correctCooldownUntilPositionAfter) from p_review_event into insert_learning_engine_review_event(). Replays by client_event_id; validates claim exactly-once consumption, claim-specific card before-state, and Battle structural invariants; persists the already-computed card/FSRS/repair result, advances scheduler_position by exactly 1 and scheduler_revision by exactly 1, recomputes mastered_count/has_achieved_full_mastery live, writes the linked review event, updates Daily Goal/streak/XP, closes the claim, and sets first_v1_answer_at exactly once.';
