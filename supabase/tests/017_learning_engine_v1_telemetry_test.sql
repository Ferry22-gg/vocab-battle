\ir fixtures/000_test_helpers.inc

-- Group 17: Learning Engine v1, Phase 8 telemetry persistence.
-- Maps to docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 29-32, and
-- supabase/migrations/20261003000000_learning_engine_v1_telemetry.sql
-- (approved, unmodified by this file),
-- 20261004000000_learning_engine_v1_telemetry_position_fields.sql (the
-- corrective migration adding answer_events.session_position/
-- scheduler_position/scheduler_revision), and
-- 20261005000000_learning_engine_v1_telemetry_functions.sql (the two
-- trusted SECURITY DEFINER persistence functions this group exercises),
-- and 20261006000000_learning_engine_v1_streak_minimum_removal.sql (the
-- pre-Phase-9 policy-alignment correction removing the separate
-- streak-minimum concept -- insert_learning_engine_review_event's calls
-- below already reflect its corrected 54-parameter signature).
--
-- Covers: schema CHECK coverage for the current Phase 6/7 source/reason/
-- mode unions (A), RLS/grant isolation on learning_engine_selection_traces
-- (B), the trusted selection-trace write path including no-card/
-- RANDOM_MASTERED/emergency traces and cross-entity rejection (C), the
-- trusted review-event write path including trace linkage, scheduler
-- position/revision agreement, cross-entity rejection, and no-card-trace
-- rejection (D), idempotent replay for both primitives and append-only/
-- trace-reuse rejection (E), the new answer_events position columns'
-- shape and CHECKs (F), legacy compatibility (G), and the streak-minimum
-- removal's schema shape (H).

BEGIN;
SELECT plan(60);

-- =========================================================================
-- Fixtures
-- =========================================================================

SELECT gen_random_uuid() AS tester_a_id \gset
SELECT gen_random_uuid() AS tester_b_id \gset
SELECT gen_random_uuid() AS admin_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS deck_i_id \gset

SELECT tests.create_test_profile(:'tester_a_id'::uuid, 'test_g17_tester_a');
SELECT tests.create_test_profile(:'tester_b_id'::uuid, 'test_g17_tester_b');
SELECT tests.create_test_profile(:'admin_id'::uuid, 'test_g17_admin', 'admin', 'active', true);

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS deck_a \gset
SELECT (public.start_or_resume_session()).id AS session_a \gset
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS deck_b \gset
SELECT (public.start_or_resume_session()).id AS session_b \gset
SELECT tests.clear_auth();

SELECT id AS card_a1 FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
SELECT id AS card_a2 FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 1 \gset
SELECT id AS card_b1 FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset

-- A second session for tester A on the SAME deck_a (direct INSERT, as the
-- privileged connecting role -- bypasses RLS the same way
-- tests.create_test_profile() bypasses auth.users' own access controls),
-- so a "trace session mismatch, user+deck matching" case can be
-- constructed in isolation (section 17 of this phase's brief).
INSERT INTO public.sessions (user_id, deck_id, current_mode)
VALUES (:'tester_a_id'::uuid, :'deck_a'::uuid, 'learning')
RETURNING id AS session_a2 \gset

SELECT gen_random_uuid() AS trace_a1 \gset
SELECT gen_random_uuid() AS trace_a2 \gset
SELECT gen_random_uuid() AS trace_a_nocard \gset
SELECT gen_random_uuid() AS trace_a_random_mastered \gset
SELECT gen_random_uuid() AS trace_a_emergency \gset
SELECT gen_random_uuid() AS trace_b1 \gset

-- =========================================================================
-- Section A: CHECK constraints match the current Phase 6/7 unions exactly
-- =========================================================================

SELECT tests.authenticate_as_service_role();

SELECT lives_ok(
  format(
    $sql$select public.insert_learning_engine_selection_trace(
      %L, %L, %L, %L, %L, now(),
      0, 0, 'ACTIVE', 'active_weighted_selection', 'pre_goal_balanced',
      0, false, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
      null, null, null, '{}', null, null, null, null, false, '{}',
      'learning-engine-v1.0', '{}'::jsonb
    )$sql$,
    gen_random_uuid(), :'tester_a_id', :'deck_a', :'card_a1', :'session_a'
  ),
  'a valid ACTIVE/active_weighted_selection trace is accepted'
);

SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_selection_trace(
      %L, %L, %L, %L, %L, now(),
      0, 0, 'NOT_A_REAL_SOURCE', 'active_weighted_selection', 'pre_goal_balanced',
      0, false, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
      null, null, null, '{}', null, null, null, null, false, '{}',
      'learning-engine-v1.0', '{}'::jsonb
    )$sql$,
    gen_random_uuid(), :'tester_a_id', :'deck_a', :'card_a1', :'session_a'
  ),
  '23514',
  'an invalid source value is rejected by the CHECK constraint'
);

SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_selection_trace(
      %L, %L, %L, %L, %L, now(),
      0, 0, 'ACTIVE', 'not_a_real_reason', 'pre_goal_balanced',
      0, false, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
      null, null, null, '{}', null, null, null, null, false, '{}',
      'learning-engine-v1.0', '{}'::jsonb
    )$sql$,
    gen_random_uuid(), :'tester_a_id', :'deck_a', :'card_a1', :'session_a'
  ),
  '23514',
  'an invalid selection_reason value is rejected by the CHECK constraint'
);

SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_selection_trace(
      %L, %L, %L, %L, %L, now(),
      0, 0, 'ACTIVE', 'active_weighted_selection', 'not_a_real_mode',
      0, false, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0,
      null, null, null, '{}', null, null, null, null, false, '{}',
      'learning-engine-v1.0', '{}'::jsonb
    )$sql$,
    gen_random_uuid(), :'tester_a_id', :'deck_a', :'card_a1', :'session_a'
  ),
  '23514',
  'an invalid scheduler_mode value is rejected by the CHECK constraint'
);

-- Every current Post-Mastery mode is accepted (not just ordinary modes).
SELECT lives_ok(
  format(
    $sql$select public.insert_learning_engine_selection_trace(
      %L, %L, %L, %L, %L, now(),
      0, 0, 'RANDOM_MASTERED', 'random_mastered_shuffle_bag', 'post_mastery_pre_goal_balanced',
      0, false, 0, 0, 0, 0,
      0, 0, 0, 0.45, 0, 0, 0, 0.45,
      null, null, null, '{}', null, null, %L, %L, false, '{}',
      'learning-engine-v1.0', '{}'::jsonb
    )$sql$,
    :'trace_a_random_mastered', :'tester_a_id', :'deck_a', :'card_a1', :'session_a',
    ARRAY[gen_random_uuid(), gen_random_uuid()]::uuid[], ARRAY[gen_random_uuid()]::uuid[]
  ),
  'a Post-Mastery scheduler_mode with RANDOM_MASTERED source/reason is accepted'
);

SELECT tests.clear_auth();

-- =========================================================================
-- Section B: RLS / grants on learning_engine_selection_traces
-- =========================================================================

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT tests.assert_no_write_grants('learning_engine_selection_traces');
SELECT is(
  (SELECT count(*)::int FROM public.learning_engine_selection_traces WHERE id = :'trace_a_random_mastered'::uuid),
  1, 'tester A can read their own selection trace'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_selection_trace(%L, %L, %L, %L, %L, now(), 0,0,'ACTIVE','active_weighted_selection','pre_goal_balanced',0,false,0,0,0,0,0,0,0,0,0,0,0,0,null,null,null,'{}',null,null,null,null,false,'{}','learning-engine-v1.0','{}'::jsonb)$sql$,
    gen_random_uuid(), :'tester_a_id', :'deck_a', :'card_a1', :'session_a'
  ),
  '42501',
  'authenticated has no EXECUTE grant on insert_learning_engine_selection_trace'
);
SELECT tests.clear_auth();

-- =========================================================================
-- Section C: trusted selection-trace write path
-- =========================================================================

SELECT tests.authenticate_as_service_role();

-- C1: ordinary card trace (trace_a1), full field round-trip check.
SELECT (public.insert_learning_engine_selection_trace(
  :'trace_a1'::uuid, :'tester_a_id'::uuid, :'deck_a'::uuid, :'card_a1'::uuid, :'session_a'::uuid, now(),
  500, 2, 'ACTIVE', 'active_weighted_selection', 'pre_goal_balanced',
  3, false,
  5, 1, 0, 0,
  0.7, 0.25, 0.05, 0,
  0.7, 0.25, 0.05, 0,
  1.2, null, null,
  ARRAY['10000000-0000-0000-0000-000000000001']::uuid[], null, null, null, null,
  false, ARRAY[0.42]::double precision[],
  'learning-engine-v1.0', '{"note":"trace_a1"}'::jsonb
)).scheduler_position AS trace_a1_scheduler_position \gset
SELECT is(:'trace_a1_scheduler_position'::int, 500, 'trace_a1 persists scheduler_position exactly');

SELECT is(
  (SELECT selection_reason FROM public.learning_engine_selection_traces WHERE id = :'trace_a1'::uuid),
  'active_weighted_selection', 'trace_a1 persists selection_reason exactly'
);
SELECT is(
  (SELECT admitted_card_ids FROM public.learning_engine_selection_traces WHERE id = :'trace_a1'::uuid),
  ARRAY['10000000-0000-0000-0000-000000000001']::uuid[], 'trace_a1 persists admitted_card_ids exactly'
);
SELECT is(
  (SELECT random_draws FROM public.learning_engine_selection_traces WHERE id = :'trace_a1'::uuid),
  ARRAY[0.42]::double precision[], 'trace_a1 persists random_draws exactly'
);

-- C2: no-card trace (card_id NULL, source NULL, reason no_card_all_unavailable).
-- Not captured via \gset: psql unsets a \gset variable entirely when the
-- captured column is NULL, which would make a later :'var' reference
-- undefined rather than usable -- read it back by trace id directly
-- instead (same pattern the two is() checks immediately below already use).
SELECT public.insert_learning_engine_selection_trace(
  :'trace_a_nocard'::uuid, :'tester_a_id'::uuid, :'deck_a'::uuid, null, :'session_a'::uuid, now(),
  510, 2, null, 'no_card_all_unavailable', 'pre_goal_review_pressure',
  15, false,
  0, 0, 0, 0,
  0.5, 0.48, 0.02, 0,
  0, 0, 0, 0,
  null, null, null,
  '{}', null, null, null, null,
  true, '{}'::double precision[],
  'learning-engine-v1.0', '{}'::jsonb
);
SELECT is(
  (SELECT card_id FROM public.learning_engine_selection_traces WHERE id = :'trace_a_nocard'::uuid),
  NULL, 'a no_card_all_unavailable trace persists card_id = NULL'
);
SELECT is(
  (SELECT source FROM public.learning_engine_selection_traces WHERE id = :'trace_a_nocard'::uuid),
  NULL, 'a no_card_all_unavailable trace persists source = NULL'
);

-- C3: emergency fallback trace.
SELECT (public.insert_learning_engine_selection_trace(
  :'trace_a_emergency'::uuid, :'tester_a_id'::uuid, :'deck_a'::uuid, :'card_a2'::uuid, :'session_a'::uuid, now(),
  520, 2, 'ACTIVE', 'emergency_cooldown_relaxation', 'pre_goal_active_focus',
  0, false,
  1, 0, 0, 0,
  0.9, 0, 0.1, 0,
  1, 0, 0, 0,
  null, null, null,
  '{}', null, null, null, null,
  true, '{}'::double precision[],
  'learning-engine-v1.0', '{}'::jsonb
)).emergency_fallback_applied AS emergency_flag \gset
SELECT is(:'emergency_flag'::boolean, true, 'an emergency_cooldown_relaxation trace persists emergency_fallback_applied = true');

-- C4: a second trace for tester A on a DIFFERENT deck/session (deck_a is
-- reused for session_a2 in Section D's session-mismatch case; trace_a2
-- instead uses tester A's own deck_b... tester A has no deck_b, so build
-- trace_a2 against session_a2 itself (same deck_a, same user, DIFFERENT
-- session than trace_a1) -- this is reused in Section D to isolate a pure
-- session mismatch with user+deck both matching.
SELECT (public.insert_learning_engine_selection_trace(
  :'trace_a2'::uuid, :'tester_a_id'::uuid, :'deck_a'::uuid, :'card_a1'::uuid, :'session_a2'::uuid, now(),
  0, 0, 'ACTIVE', 'active_first_pass', 'pre_goal_active_focus',
  0, false,
  1, 0, 0, 0,
  0.9, 0, 0.1, 0,
  1, 0, 0, 0,
  null, null, null,
  '{}', null, null, null, null,
  false, '{}'::double precision[],
  'learning-engine-v1.0', '{}'::jsonb
)).id AS trace_a2_id \gset
SELECT is(:'trace_a2_id'::uuid, :'trace_a2'::uuid, 'trace_a2 (session_a2) persists successfully');

-- C5: a trace for tester B, used in Section D's full cross-user mismatch case.
SELECT (public.insert_learning_engine_selection_trace(
  :'trace_b1'::uuid, :'tester_b_id'::uuid, :'deck_b'::uuid, :'card_b1'::uuid, :'session_b'::uuid, now(),
  0, 0, 'ACTIVE', 'active_weighted_selection', 'pre_goal_balanced',
  0, false,
  1, 0, 0, 0,
  0.9, 0, 0.1, 0,
  1, 0, 0, 0,
  null, null, null,
  '{}', null, null, null, null,
  false, '{}'::double precision[],
  'learning-engine-v1.0', '{}'::jsonb
)).id AS trace_b1_id \gset
SELECT is(:'trace_b1_id'::uuid, :'trace_b1'::uuid, 'trace_b1 (tester B) persists successfully');

-- C6: cross-entity rejection on the trace write path itself.
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_selection_trace(%L, %L, %L, %L, %L, now(),0,0,'ACTIVE','active_weighted_selection','pre_goal_balanced',0,false,0,0,0,0,0,0,0,0,0,0,0,0,null,null,null,'{}',null,null,null,null,false,'{}','learning-engine-v1.0','{}'::jsonb)$sql$,
    gen_random_uuid(), :'tester_b_id', :'deck_a', :'card_a1', :'session_a'
  ),
  '42501', 'trace insert: session does not belong to the given user (tester B against tester A''s session) is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_selection_trace(%L, %L, %L, %L, %L, now(),0,0,'ACTIVE','active_weighted_selection','pre_goal_balanced',0,false,0,0,0,0,0,0,0,0,0,0,0,0,null,null,null,'{}',null,null,null,null,false,'{}','learning-engine-v1.0','{}'::jsonb)$sql$,
    gen_random_uuid(), :'tester_a_id', :'deck_b', :'card_a1', :'session_a'
  ),
  '42501', 'trace insert: session does not belong to the given deck is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_selection_trace(%L, %L, %L, %L, %L, now(),0,0,'ACTIVE','active_weighted_selection','pre_goal_balanced',0,false,0,0,0,0,0,0,0,0,0,0,0,0,null,null,null,'{}',null,null,null,null,false,'{}','learning-engine-v1.0','{}'::jsonb)$sql$,
    gen_random_uuid(), :'tester_a_id', :'deck_a', :'card_b1', :'session_a'
  ),
  '42501', 'trace insert: card does not belong to the given deck is rejected'
);

-- C7: append-only -- a duplicate trace id fails, never silently overwrites.
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_selection_trace(%L, %L, %L, %L, %L, now(),0,0,'ACTIVE','active_weighted_selection','pre_goal_balanced',0,false,0,0,0,0,0,0,0,0,0,0,0,0,null,null,null,'{}',null,null,null,null,false,'{}','learning-engine-v1.0','{}'::jsonb)$sql$,
    :'trace_a1', :'tester_a_id', :'deck_a', :'card_a1', :'session_a'
  ),
  '23505', 'a duplicate selection trace id is rejected (append-only, never a silent overwrite)'
);

SELECT tests.clear_auth();

-- =========================================================================
-- Section D: trusted review-event write path
-- =========================================================================

SELECT tests.authenticate_as_service_role();
SELECT gen_random_uuid() AS event_1 \gset
SELECT gen_random_uuid() AS event_2 \gset

-- D1: a valid v1 review event linked to trace_a1, full round-trip.
SELECT (public.insert_learning_engine_review_event(
  :'event_1'::uuid, :'tester_a_id'::uuid, :'deck_a'::uuid, :'card_a1'::uuid, :'session_a'::uuid, now(),
  12, 500, 2,
  true, 1500, null,
  :'trace_a1'::uuid, 'ACTIVE', 'active_weighted_selection', 'pre_goal_balanced',
  false,
  'LEARNING', 'FRESH', 'LEARNING', 'LEARNING_1', false,
  1, 0, null, null,
  false, false, true,
  null, null, null, null, null, null,
  null, null, null,
  0, 0,
  0.7, 0.25, 0.05, null, 0.7, 0.25, 0.05, null,
  1.2, 5,
  'learning-engine-v1.0', 'ts-fsrs@5.4.2', null, null
)).client_event_id AS event_1_client_event_id \gset
SELECT is(:'event_1_client_event_id'::uuid, :'event_1'::uuid, 'a valid v1 review event persists successfully');
SELECT is(
  (SELECT session_mode FROM public.answer_events WHERE client_event_id = :'event_1'::uuid),
  'v1', 'the v1 review event is stored with session_mode = ''v1'''
);
SELECT is(
  (SELECT scheduler_position FROM public.answer_events WHERE client_event_id = :'event_1'::uuid)::int,
  500, 'the v1 review event persists scheduler_position matching its linked trace'
);
SELECT is(
  (SELECT scheduler_revision FROM public.answer_events WHERE client_event_id = :'event_1'::uuid)::int,
  2, 'the v1 review event persists scheduler_revision matching its linked trace'
);
SELECT is(
  (SELECT session_position FROM public.answer_events WHERE client_event_id = :'event_1'::uuid)::int,
  12, 'the v1 review event persists session_position exactly'
);
SELECT is(
  (SELECT selection_trace_id FROM public.answer_events WHERE client_event_id = :'event_1'::uuid),
  :'trace_a1'::uuid, 'the v1 review event links to its selection trace via selection_trace_id'
);
SELECT is(
  (SELECT is_repair_retry FROM public.answer_events WHERE client_event_id = :'event_1'::uuid)::boolean,
  false, 'the v1 review event persists is_repair_retry exactly'
);
SELECT is(
  (SELECT is_stage_advancing_success FROM public.answer_events WHERE client_event_id = :'event_1'::uuid)::boolean,
  true, 'the v1 review event persists is_stage_advancing_success exactly'
);

-- D2: mismatched scheduler_position / scheduler_revision against the linked trace are rejected.
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_review_event(%L,%L,%L,%L,%L,now(),12,501,2,true,1500,null,%L,'ACTIVE','active_weighted_selection','pre_goal_balanced',false,'LEARNING','FRESH','LEARNING','LEARNING_1',false,1,0,null,null,false,false,true,null,null,null,null,null,null,null,null,null,0,0,0.7,0.25,0.05,null,0.7,0.25,0.05,null,1.2,5,'learning-engine-v1.0','ts-fsrs@5.4.2',null,null)$sql$,
    gen_random_uuid(), :'tester_a_id', :'deck_a', :'card_a1', :'session_a', :'trace_a1'
  ),
  '42501', 'a review event whose scheduler_position does not match its linked trace is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_review_event(%L,%L,%L,%L,%L,now(),12,500,3,true,1500,null,%L,'ACTIVE','active_weighted_selection','pre_goal_balanced',false,'LEARNING','FRESH','LEARNING','LEARNING_1',false,1,0,null,null,false,false,true,null,null,null,null,null,null,null,null,null,0,0,0.7,0.25,0.05,null,0.7,0.25,0.05,null,1.2,5,'learning-engine-v1.0','ts-fsrs@5.4.2',null,null)$sql$,
    gen_random_uuid(), :'tester_a_id', :'deck_a', :'card_a1', :'session_a', :'trace_a1'
  ),
  '42501', 'a review event whose scheduler_revision does not match its linked trace is rejected'
);

-- D3: cross-entity mismatches between the event's own identity and the linked trace.
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_review_event(%L,%L,%L,%L,%L,now(),12,0,0,true,1500,null,%L,'ACTIVE','active_weighted_selection','pre_goal_balanced',false,'LEARNING','FRESH','LEARNING','LEARNING_1',false,1,0,null,null,false,false,true,null,null,null,null,null,null,null,null,null,0,0,0.9,0,0.1,null,0.9,0,0.1,null,1,5,'learning-engine-v1.0','ts-fsrs@5.4.2',null,null)$sql$,
    gen_random_uuid(), :'tester_a_id', :'deck_a', :'card_b1', :'session_a', :'trace_b1'
  ),
  '42501', 'a review event linking to a trace belonging to a different user is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_review_event(%L,%L,%L,%L,%L,now(),12,0,0,true,1500,null,%L,'ACTIVE','active_first_pass','pre_goal_active_focus',false,'LEARNING','FRESH','LEARNING','LEARNING_1',false,1,0,null,null,false,false,true,null,null,null,null,null,null,null,null,null,0,0,0.9,0,0.1,null,0.9,0,0.1,null,1,5,'learning-engine-v1.0','ts-fsrs@5.4.2',null,null)$sql$,
    gen_random_uuid(), :'tester_a_id', :'deck_a', :'card_a1', :'session_a', :'trace_a2'
  ),
  '42501', 'a review event linking to a trace belonging to a different session (same user+deck) is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_review_event(%L,%L,%L,%L,%L,now(),12,500,2,true,1500,null,%L,'ACTIVE','active_weighted_selection','pre_goal_balanced',false,'LEARNING','FRESH','LEARNING','LEARNING_1',false,1,0,null,null,false,false,true,null,null,null,null,null,null,null,null,null,0,0,0.7,0.25,0.05,null,0.7,0.25,0.05,null,1.2,5,'learning-engine-v1.0','ts-fsrs@5.4.2',null,null)$sql$,
    gen_random_uuid(), :'tester_a_id', :'deck_a', :'card_a2', :'session_a', :'trace_a1'
  ),
  '42501', 'a review event whose card does not match its linked trace''s card is rejected'
);

-- D4: a no-card trace cannot be linked to an answer event.
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_review_event(%L,%L,%L,%L,%L,now(),12,510,2,true,1500,null,%L,'ACTIVE','active_weighted_selection','pre_goal_balanced',false,'LEARNING','FRESH','LEARNING','LEARNING_1',false,1,0,null,null,false,false,true,null,null,null,null,null,null,null,null,null,0,0,0.5,0.48,0.02,null,0.5,0.48,0.02,null,1,5,'learning-engine-v1.0','ts-fsrs@5.4.2',null,null)$sql$,
    gen_random_uuid(), :'tester_a_id', :'deck_a', :'card_a1', :'session_a', :'trace_a_nocard'
  ),
  '22023', 'a no_card_all_unavailable trace cannot be linked to an answer event'
);

-- D5: ordinary cross-entity rejection on the event's own identity (independent of any trace).
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_review_event(%L,%L,%L,%L,%L,now(),0,0,0,true,1500,null,null,null,'active_weighted_selection','pre_goal_balanced',false,'LEARNING','FRESH','LEARNING','LEARNING_1',false,1,0,null,null,false,false,true,null,null,null,null,null,null,null,null,null,0,0,null,null,null,null,null,null,null,null,null,null,'learning-engine-v1.0','ts-fsrs@5.4.2',null,null)$sql$,
    gen_random_uuid(), :'tester_b_id', :'deck_a', :'card_a1', :'session_a'
  ),
  '42501', 'review event insert: session does not belong to the given user is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_review_event(%L,%L,%L,%L,%L,now(),0,0,0,true,1500,null,null,null,'active_weighted_selection','pre_goal_balanced',false,'LEARNING','FRESH','LEARNING','LEARNING_1',false,1,0,null,null,false,false,true,null,null,null,null,null,null,null,null,null,0,0,null,null,null,null,null,null,null,null,null,null,'learning-engine-v1.0','ts-fsrs@5.4.2',null,null)$sql$,
    gen_random_uuid(), :'tester_a_id', :'deck_a', :'card_b1', :'session_a'
  ),
  '42501', 'review event insert: card does not belong to the given deck is rejected'
);

-- D6: idempotent replay -- same client_event_id returns the ORIGINAL row, never a duplicate or a mutated value.
SELECT (public.insert_learning_engine_review_event(
  :'event_1'::uuid, :'tester_a_id'::uuid, :'deck_a'::uuid, :'card_a1'::uuid, :'session_a'::uuid, now(),
  99, 999, 99,
  false, 1, null,
  null, null, 'active_starvation', 'pre_goal_active_focus',
  true,
  'LEARNED', null, 'FORGOTTEN', null, true,
  9, 9, null, null,
  true, true, false,
  null, null, null, null, null, null,
  null, null, null,
  0, 0,
  null, null, null, null, null, null, null, null,
  null, null,
  'learning-engine-v1.0', 'ts-fsrs@5.4.2', null, null
)).correct AS replay_correct \gset
SELECT is(:'replay_correct'::boolean, true, 'retrying a committed client_event_id replays the ORIGINAL correct value, not the retry''s differing input');
SELECT is(
  (SELECT count(*)::int FROM public.answer_events WHERE client_event_id = :'event_1'::uuid),
  1, 'retrying a committed client_event_id never creates a second answer_events row'
);

-- D7: a selection trace cannot be reused across two different answer events (unique partial index).
SELECT (public.insert_learning_engine_selection_trace(
  gen_random_uuid(), :'tester_a_id'::uuid, :'deck_a'::uuid, :'card_a2'::uuid, :'session_a'::uuid, now(),
  600, 2, 'ACTIVE', 'active_weighted_selection', 'pre_goal_balanced',
  0, false, 1,0,0,0, 0.7,0.25,0.05,0, 0.7,0.25,0.05,0,
  1, null, null, '{}', null, null, null, null, false, '{}',
  'learning-engine-v1.0', '{}'::jsonb
)).id AS trace_for_reuse_test \gset

SELECT (public.insert_learning_engine_review_event(
  gen_random_uuid(), :'tester_a_id'::uuid, :'deck_a'::uuid, :'card_a2'::uuid, :'session_a'::uuid, now(),
  13, 600, 2,
  true, 1500, null,
  :'trace_for_reuse_test'::uuid, 'ACTIVE', 'active_weighted_selection', 'pre_goal_balanced',
  false, 'LEARNING', 'FRESH', 'LEARNING', 'LEARNING_1', false,
  1, 0, null, null, false, false, true,
  null, null, null, null, null, null, null, null, null, 0, 0,
  0.7,0.25,0.05,null,0.7,0.25,0.05,null, 1, 5,
  'learning-engine-v1.0', 'ts-fsrs@5.4.2', null, null
)).id AS event_using_trace_for_reuse \gset

SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_review_event(%L,%L,%L,%L,%L,now(),14,600,2,true,1500,null,%L,'ACTIVE','active_weighted_selection','pre_goal_balanced',false,'LEARNING','FRESH','LEARNING','LEARNING_1',false,1,0,null,null,false,false,true,null,null,null,null,null,null,null,null,null,0,0,0.7,0.25,0.05,null,0.7,0.25,0.05,null,1,5,'learning-engine-v1.0','ts-fsrs@5.4.2',null,null)$sql$,
    gen_random_uuid(), :'tester_a_id', :'deck_a', :'card_a2', :'session_a', :'trace_for_reuse_test'
  ),
  '23505', 'a selection trace already linked to one answer event cannot be linked to a second, different answer event'
);

-- Direct authenticated EXECUTE on insert_learning_engine_review_event is rejected.
-- tests.authenticate_as() has no EXECUTE grant for service_role (only the
-- privileged connecting role may call it) -- clear_auth() first.
SELECT tests.clear_auth();
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.insert_learning_engine_review_event(%L,%L,%L,%L,%L,now(),0,0,0,true,1500,null,null,null,'active_weighted_selection','pre_goal_balanced',false,'LEARNING','FRESH','LEARNING','LEARNING_1',false,1,0,null,null,false,false,true,null,null,null,null,null,null,null,null,null,0,0,null,null,null,null,null,null,null,null,null,null,'learning-engine-v1.0','ts-fsrs@5.4.2',null,null)$sql$,
    gen_random_uuid(), :'tester_a_id', :'deck_a', :'card_a1', :'session_a'
  ),
  '42501',
  'authenticated has no EXECUTE grant on insert_learning_engine_review_event'
);
SELECT tests.clear_auth();

-- =========================================================================
-- Section F: answer_events position columns (corrective migration)
-- =========================================================================

SELECT col_type_is('public', 'answer_events', 'session_position', 'integer', 'session_position is integer');
SELECT col_type_is('public', 'answer_events', 'scheduler_position', 'integer', 'scheduler_position is integer');
SELECT col_type_is('public', 'answer_events', 'scheduler_revision', 'integer', 'scheduler_revision is integer');

SELECT tests.authenticate_as_service_role();
SELECT lives_ok(
  format(
    $sql$update public.answer_events set session_position = 0, scheduler_position = 0, scheduler_revision = 0 where client_event_id = %L$sql$,
    :'event_1'
  ),
  'session_position/scheduler_position/scheduler_revision = 0 are all accepted'
);
SELECT tests.throws_sqlstate(
  format('update public.answer_events set session_position = -1 where client_event_id = %L', :'event_1'),
  '23514', 'a negative session_position is rejected'
);
SELECT tests.throws_sqlstate(
  format('update public.answer_events set scheduler_position = -1 where client_event_id = %L', :'event_1'),
  '23514', 'a negative scheduler_position is rejected'
);
SELECT tests.throws_sqlstate(
  format('update public.answer_events set scheduler_revision = -1 where client_event_id = %L', :'event_1'),
  '23514', 'a negative scheduler_revision is rejected'
);
SELECT tests.clear_auth();

-- =========================================================================
-- Section G: legacy compatibility
-- =========================================================================

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT id AS legacy_card FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 2 \gset
SELECT tests.clear_auth();

SELECT tests.authenticate_as_service_role();
SELECT tests.call_commit_answer(gen_random_uuid(), :'tester_a_id'::uuid, :'session_a'::uuid, :'legacy_card'::uuid, true) AS legacy_result \gset
SELECT is((:'legacy_result')::jsonb ->> 'is_replay', 'false', 'the legacy commit_answer_transaction() path still succeeds unaffected by Phase 8''s changes');
SELECT is(
  (SELECT session_position FROM public.answer_events WHERE id = ((:'legacy_result')::jsonb -> 'answer_event' ->> 'id')::uuid),
  NULL, 'a legacy answer_events row leaves session_position NULL'
);
SELECT is(
  (SELECT scheduler_position FROM public.answer_events WHERE id = ((:'legacy_result')::jsonb -> 'answer_event' ->> 'id')::uuid),
  NULL, 'a legacy answer_events row leaves scheduler_position NULL'
);
SELECT is(
  (SELECT scheduler_revision FROM public.answer_events WHERE id = ((:'legacy_result')::jsonb -> 'answer_event' ->> 'id')::uuid),
  NULL, 'a legacy answer_events row leaves scheduler_revision NULL'
);
SELECT is(
  (SELECT selection_trace_id FROM public.answer_events WHERE id = ((:'legacy_result')::jsonb -> 'answer_event' ->> 'id')::uuid),
  NULL, 'a legacy answer_events row leaves selection_trace_id NULL'
);
SELECT is(
  (SELECT session_mode FROM public.answer_events WHERE id = ((:'legacy_result')::jsonb -> 'answer_event' ->> 'id')::uuid),
  'learning', 'the legacy answer_events row keeps its legacy session_mode value, never ''v1'''
);
SELECT tests.clear_auth();

-- =========================================================================
-- Section H: streak-minimum removal (20261006000000 corrective migration)
-- =========================================================================

SELECT hasnt_column('public', 'answer_events', 'streak_minimum_complete_before', 'answer_events.streak_minimum_complete_before no longer exists');
SELECT hasnt_column('public', 'sessions', 'streak_minimum_completed_at', 'sessions.streak_minimum_completed_at no longer exists');
SELECT has_column('public', 'answer_events', 'daily_goal_complete_before', 'answer_events.daily_goal_complete_before is preserved');
SELECT has_column('public', 'sessions', 'daily_goal_completed_at', 'sessions.daily_goal_completed_at is preserved');

SELECT * FROM finish();
ROLLBACK;
