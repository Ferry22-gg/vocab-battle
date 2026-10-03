-- Learning Engine v1 -- policy-alignment correction before Phase 9: remove
-- the separate "streak minimum" concept entirely.
--
-- FINAL v1 PRODUCT RULE (docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section
-- 26, corrected): Daily Goal = 5 enemy defeats per Asia/Tokyo calendar day.
-- A streak day is earned only when Daily Goal is completed -- there is no
-- separate 1-enemy streak-maintenance threshold in v1. Daily Goal
-- completion IS streak-day qualification, not two thresholds that happen
-- to share the same number.
--
-- This migration is a forward-only correction. It does NOT edit the three
-- already-applied Phase 8 migrations (20261003000000_learning_engine_v1_telemetry.sql,
-- 20261004000000_learning_engine_v1_telemetry_position_fields.sql,
-- 20261005000000_learning_engine_v1_telemetry_functions.sql) -- those
-- introduced the now-obsolete `streak_minimum_complete_before`/
-- `streak_minimum_completed_at` columns and the corresponding
-- `insert_learning_engine_review_event` parameter; this migration removes
-- them going forward instead.
--
-- Scope:
--   1. Drop and recreate `public.insert_learning_engine_review_event`
--      WITHOUT `p_streak_minimum_complete_before` (a parameter list change
--      requires DROP + CREATE, not CREATE OR REPLACE -- Postgres cannot
--      replace a function while removing one of its arguments).
--   2. Drop `public.answer_events.streak_minimum_complete_before`.
--   3. Drop `public.sessions.streak_minimum_completed_at`.
--
-- Preserved, unchanged: `answer_events.daily_goal_complete_before`,
-- `sessions.daily_goal_completed_at`, and every other Phase 8 column/
-- function. No reset, no backfill, no destruction of existing tester data
-- -- every pre-existing row simply loses these two always-nullable,
-- never-populated-by-live-runtime columns (Phase 8's own brief: "Not
-- called from any live application code path in this phase" -- confirmed
-- unused by any live runtime caller).

-- =========================================================================
-- 1. Recreate insert_learning_engine_review_event without the
--    streak-minimum parameter/column. Not live runtime yet (Phase 8 brief
--    section 10/35/45), so this ends with a clean v1 API rather than
--    carrying forward an obsolete, ignored argument.
-- =========================================================================

drop function public.insert_learning_engine_review_event(
  uuid, uuid, uuid, uuid, uuid, timestamptz,
  integer, integer, integer,
  boolean, integer, integer,
  uuid, text, text, text,
  boolean, boolean,
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
  p_experiment_assignment_id text
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
    policy_version, fsrs_version, parameter_set_id, experiment_assignment_id
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
    p_policy_version, p_fsrs_version, p_parameter_set_id, p_experiment_assignment_id
  )
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.insert_learning_engine_review_event is
  'Phase 8 trusted persistence primitive for v1 answer_events rows (session_mode = ''v1''), corrected by the pre-Phase-9 streak-minimum removal migration to drop the obsolete streak_minimum_complete_before parameter. SECURITY DEFINER, service_role-only. Replays by client_event_id (same idempotency semantics as commit_answer_transaction()); validates session/card/trace cross-entity consistency, including scheduler_position/scheduler_revision agreement with a linked trace, before inserting. Not wired into any live call site yet -- see the original 20261005000000 migration''s header. Never call this for a legacy (review/learning) answer -- that path remains commit_answer_transaction() exclusively.';

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
  text, text, text, text
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
  text, text, text, text
) to service_role;

-- =========================================================================
-- 2/3. Drop the obsolete columns. Both always-nullable, never populated by
-- any live runtime caller (confirmed: Phase 8 telemetry is not wired into
-- any live call site -- see migration 20261005000000's header) -- dropping
-- them discards no tester-meaningful data. daily_goal_complete_before /
-- daily_goal_completed_at are untouched.
-- =========================================================================
alter table public.answer_events
  drop column streak_minimum_complete_before;

alter table public.sessions
  drop column streak_minimum_completed_at;
