-- Learning Engine v1 -- Phase 8 (remaining scope): trusted persistence
-- functions for selection traces and v1 review events.
--
-- Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 29
-- ("Data model requirements"), 30 ("Behavioral event logging"), 41.9
-- ("use a trusted function / server-side workflow rather than weakening
-- RLS"); the approved schema migrations supabase/migrations/
-- 20261003000000_learning_engine_v1_telemetry.sql and
-- 20261004000000_learning_engine_v1_telemetry_position_fields.sql
-- (neither modified by this file); and this phase's brief sections 16-21
-- ("trusted persistence path", "cross-entity consistency -- mandatory",
-- "selection trace write path", "review event write path", "selection
-- trace linkage", "idempotency").
--
-- ---------------------------------------------------------------------
-- Design: two narrow SECURITY DEFINER functions, service_role-only,
-- mirroring commit_answer_transaction()'s own trust-boundary pattern
-- ---------------------------------------------------------------------
-- The approved 20261003000000 migration's own header comment already
-- anticipated "an internal SQL helper function callable by the future
-- trusted commit/claim RPC" as one of this phase's possible persistence
-- shapes (this phase's original brief section 19). A SQL function (not a
-- bare service-role table INSERT from TypeScript) is the right choice
-- here specifically because:
--   (a) cross-entity validation (session/deck/card/trace consistency)
--       must happen atomically with the insert to avoid a TOCTOU race
--       between a separate validation read and the write -- the same
--       reason commit_answer_transaction() validates and writes inside
--       one PL/pgSQL function, not two round-trips from the client;
--   (b) a future runtime-cutover transaction (not built in this phase)
--       will need to compose "claim a selection" + "persist its trace",
--       and "commit an answer" + "persist its review event", into ONE
--       atomic Postgres transaction -- a SQL function is directly
--       composable (CALL it, or inline its body) inside that future
--       transaction the way a TypeScript call never could be.
-- Both functions are `security definer`, `set search_path = ''` (the
-- same pattern public.is_admin()/commit_answer_transaction() already
-- use), and granted ONLY to `service_role` -- an authenticated user has
-- no EXECUTE grant at all, so the browser cannot reach either function
-- even indirectly.
--
-- Neither function performs any scheduling, FSRS, or lifecycle-transition
-- computation. Both are narrow, validate-then-insert primitives -- all
-- values (including every derived telemetry field) are computed upstream
-- by the pure lib/learning-engine/telemetry/{selection-trace,review-event}.ts
-- modules and simply forwarded here, the same "no calculation" discipline
-- lib/learning/commit-answer.ts already documents for the legacy path.
--
-- Neither function is wired into any live call site in this phase (this
-- phase's brief section 10/35/45: "Do NOT wire it into live
-- chooseNextCard() calls yet... the code may be callable by tests and
-- future cutover only").

-- =========================================================================
-- public.insert_learning_engine_selection_trace
-- =========================================================================
create or replace function public.insert_learning_engine_selection_trace(
  p_id uuid,
  p_user_id uuid,
  p_deck_id uuid,
  p_card_id uuid,
  p_session_id uuid,
  p_occurred_at timestamptz,

  p_scheduler_position integer,
  p_scheduler_revision integer,

  p_source text,
  p_selection_reason text,
  p_scheduler_mode text,

  p_due_count integer,
  p_daily_goal_complete_before boolean,

  p_candidate_count_active integer,
  p_candidate_count_due integer,
  p_candidate_count_near integer,
  p_candidate_count_random_mastered integer,

  p_source_weight_active_raw double precision,
  p_source_weight_due_raw double precision,
  p_source_weight_near_raw double precision,
  p_source_weight_random_mastered_raw double precision,
  p_source_weight_active_normalized double precision,
  p_source_weight_due_normalized double precision,
  p_source_weight_near_normalized double precision,
  p_source_weight_random_mastered_normalized double precision,

  p_card_priority_weight double precision,
  p_retrievability double precision,
  p_interval_progress double precision,

  p_admitted_card_ids uuid[],
  p_first_pass_queue_before uuid[],
  p_first_pass_queue_after uuid[],
  p_post_mastery_shuffle_bag_before uuid[],
  p_post_mastery_shuffle_bag_after uuid[],

  p_emergency_fallback_applied boolean,
  p_random_draws double precision[],

  p_policy_version text,
  p_trace_payload jsonb
) returns public.learning_engine_selection_traces
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
  v_card public.cards;
  v_trace public.learning_engine_selection_traces;
begin
  -- =========================================================================
  -- Cross-entity consistency (this phase's brief section 17 -- "the
  -- TRUSTED WRITE PATH must validate it procedurally"). A plain FK
  -- cannot express "this session belongs to this user AND this deck", or
  -- "this card belongs to this deck" -- only a procedural check can, the
  -- same reason commit_answer_transaction() validates
  -- `card.deck_id = session.deck_id` in PL/pgSQL rather than via a schema
  -- constraint (verified directly against that function during the Phase
  -- 8 schema review).
  -- =========================================================================
  select * into v_session from public.sessions where id = p_session_id;
  if not found then
    raise exception 'insert_learning_engine_selection_trace: session not found' using errcode = '22023';
  end if;
  if v_session.user_id <> p_user_id then
    raise exception 'insert_learning_engine_selection_trace: session does not belong to the given user' using errcode = '42501';
  end if;
  if v_session.deck_id <> p_deck_id then
    raise exception 'insert_learning_engine_selection_trace: session does not belong to the given deck' using errcode = '42501';
  end if;

  -- Section 22 of the normative spec: a no_card_all_unavailable decision
  -- has card_id = NULL -- only validate card/deck membership when a card
  -- was actually selected.
  if p_card_id is not null then
    select * into v_card from public.cards where id = p_card_id;
    if not found then
      raise exception 'insert_learning_engine_selection_trace: card not found' using errcode = '22023';
    end if;
    if v_card.deck_id <> p_deck_id then
      raise exception 'insert_learning_engine_selection_trace: card does not belong to the given deck' using errcode = '42501';
    end if;
  end if;

  -- Append-only (this phase's brief section 6/22): a duplicate p_id hits
  -- the primary key and raises a unique_violation (23505) naturally --
  -- never a silent overwrite of a different trace's content. No ON
  -- CONFLICT clause is used, deliberately.
  insert into public.learning_engine_selection_traces (
    id, user_id, deck_id, card_id, session_id, occurred_at,
    scheduler_position, scheduler_revision,
    source, selection_reason, scheduler_mode,
    due_count, daily_goal_complete_before,
    candidate_count_active, candidate_count_due, candidate_count_near, candidate_count_random_mastered,
    source_weight_active_raw, source_weight_due_raw, source_weight_near_raw, source_weight_random_mastered_raw,
    source_weight_active_normalized, source_weight_due_normalized, source_weight_near_normalized, source_weight_random_mastered_normalized,
    card_priority_weight, retrievability, interval_progress,
    admitted_card_ids,
    first_pass_queue_before, first_pass_queue_after,
    post_mastery_shuffle_bag_before, post_mastery_shuffle_bag_after,
    emergency_fallback_applied, random_draws,
    policy_version, trace_payload
  ) values (
    p_id, p_user_id, p_deck_id, p_card_id, p_session_id, p_occurred_at,
    p_scheduler_position, p_scheduler_revision,
    p_source, p_selection_reason, p_scheduler_mode,
    p_due_count, p_daily_goal_complete_before,
    p_candidate_count_active, p_candidate_count_due, p_candidate_count_near, p_candidate_count_random_mastered,
    p_source_weight_active_raw, p_source_weight_due_raw, p_source_weight_near_raw, p_source_weight_random_mastered_raw,
    p_source_weight_active_normalized, p_source_weight_due_normalized, p_source_weight_near_normalized, p_source_weight_random_mastered_normalized,
    p_card_priority_weight, p_retrievability, p_interval_progress,
    coalesce(p_admitted_card_ids, '{}'),
    p_first_pass_queue_before, p_first_pass_queue_after,
    p_post_mastery_shuffle_bag_before, p_post_mastery_shuffle_bag_after,
    p_emergency_fallback_applied, coalesce(p_random_draws, '{}'),
    p_policy_version, p_trace_payload
  )
  returning * into v_trace;

  return v_trace;
end;
$$;

comment on function public.insert_learning_engine_selection_trace is
  'Phase 8 trusted persistence primitive for learning_engine_selection_traces. SECURITY DEFINER, service_role-only. Validates session/card cross-entity consistency, then inserts (never upserts) one historical selection-trace row. Not wired into any live call site yet -- see this migration''s header.';

revoke all on function public.insert_learning_engine_selection_trace(
  uuid, uuid, uuid, uuid, uuid, timestamptz,
  integer, integer,
  text, text, text,
  integer, boolean,
  integer, integer, integer, integer,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision,
  uuid[], uuid[], uuid[], uuid[], uuid[],
  boolean, double precision[],
  text, jsonb
) from public, anon, authenticated;

grant execute on function public.insert_learning_engine_selection_trace(
  uuid, uuid, uuid, uuid, uuid, timestamptz,
  integer, integer,
  text, text, text,
  integer, boolean,
  integer, integer, integer, integer,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision,
  uuid[], uuid[], uuid[], uuid[], uuid[],
  boolean, double precision[],
  text, jsonb
) to service_role;

-- =========================================================================
-- answer_events.selection_trace_id: unique (where not null)
-- =========================================================================
-- This phase's brief section 17/22: "trace is not reused for a different
-- answer/card... Do not silently overwrite an existing historical trace
-- with different content." The approved 20261003000000 migration already
-- added a plain (non-unique) partial index on this column for query
-- performance (answer_events_selection_trace_id_idx) -- left untouched.
-- This ADDITIONAL unique partial index is the race-safe way to guarantee
-- "at most one answer_event ever links to a given trace": a procedural
-- existence check (`select 1 from answer_events where selection_trace_id
-- = ...`) immediately before an insert is a classic check-then-insert
-- race under concurrent callers, whereas a unique index makes a second
-- attempt fail atomically at the database level, the same reason
-- client_event_id itself is a unique column rather than a procedurally-
-- checked one. Purely additive -- does not alter, replace, or drop the
-- existing index.
create unique index answer_events_selection_trace_id_unique_idx
  on public.answer_events (selection_trace_id)
  where selection_trace_id is not null;

-- =========================================================================
-- public.insert_learning_engine_review_event
-- =========================================================================
create or replace function public.insert_learning_engine_review_event(
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
  p_streak_minimum_complete_before boolean,

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
    -- partial index on answer_events.selection_trace_id (above) enforces
    -- this atomically on the INSERT below -- a second attempt to link the
    -- same trace raises a unique_violation (23505), never a silent
    -- overwrite.
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
    daily_goal_complete_before, streak_minimum_complete_before,
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
    p_daily_goal_complete_before, p_streak_minimum_complete_before,
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
  'Phase 8 trusted persistence primitive for v1 answer_events rows (session_mode = ''v1''). SECURITY DEFINER, service_role-only. Replays by client_event_id (same idempotency semantics as commit_answer_transaction()); validates session/card/trace cross-entity consistency, including scheduler_position/scheduler_revision agreement with a linked trace, before inserting. Not wired into any live call site yet -- see this migration''s header. Never call this for a legacy (review/learning) answer -- that path remains commit_answer_transaction() exclusively.';

revoke all on function public.insert_learning_engine_review_event(
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
) from public, anon, authenticated;

grant execute on function public.insert_learning_engine_review_event(
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
) to service_role;
