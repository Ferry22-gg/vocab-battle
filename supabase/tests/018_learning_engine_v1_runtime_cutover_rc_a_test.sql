\ir fixtures/000_test_helpers.inc

-- Group 18: Learning Engine v1, Runtime Cutover RC-A (schema + trusted
-- one-time legacy-normalization primitives).
-- Maps to the approved Runtime Cutover Architecture plan (sections
-- 5/6/8/9/11/13) and the resolved pre-RC-A invariant check (legacy
-- FORGOTTEN repair-obligation completeness), plus
-- supabase/migrations/20261007000000_learning_engine_v1_runtime_cutover_schema.sql
-- and 20261008000000_learning_engine_v1_cutover_normalization_functions.sql.
--
-- Covers: selection_claims schema/CHECK/one-open-per-session/trace
-- retention/grants (A-D), the three other additive columns/tables and
-- their grants (E-H), normalize_card_progress_for_learning_engine_v1()
-- for NEW/LEARNING/LEARNED/FORGOTTEN including the R2 has_ever_been_
-- mastered correction, structural repair-obligation-completeness
-- rejections, drift protection, and idempotency (I-K), and
-- recompute_user_deck_learning_state_for_v1()'s mastered_count/
-- has_achieved_full_mastery reconciliation and monotonicity (L).
--
-- Deliberately NOT covered here (out of RC-A scope -- approved plan
-- section 17): get_next_session_card()/commit_answer_transaction()/
-- start_or_resume_session()/finish_session() are untouched by this
-- migration, so "a new session actually gets assigned engine_version =
-- 'v1' because its user is in learning_engine_v1_rollout" is a RC-D
-- behavior, not testable yet -- this file only proves the schema a
-- future RC-D can build on.

BEGIN;
SELECT plan(95);

-- =========================================================================
-- Fixtures
-- =========================================================================

SELECT gen_random_uuid() AS tester_a_id \gset
SELECT gen_random_uuid() AS tester_b_id \gset
SELECT gen_random_uuid() AS admin_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS deck_i_id \gset

SELECT tests.create_test_profile(:'tester_a_id'::uuid, 'test_g18_tester_a');
SELECT tests.create_test_profile(:'tester_b_id'::uuid, 'test_g18_tester_b');
SELECT tests.create_test_profile(:'admin_id'::uuid, 'test_g18_admin', 'admin', 'active', true);

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

SELECT gen_random_uuid() AS trace_a1 \gset
SELECT gen_random_uuid() AS trace_a2 \gset

SELECT tests.authenticate_as_service_role();
SELECT public.insert_learning_engine_selection_trace(
  :'trace_a1', :'tester_a_id', :'deck_a', :'card_a1', :'session_a', now(),
  0, 0, 'ACTIVE', 'active_weighted_selection', 'pre_goal_balanced',
  0, false, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  null, null, null, '{}', null, null, null, null, false, '{}',
  'learning-engine-v1.0', '{}'::jsonb
);
SELECT public.insert_learning_engine_selection_trace(
  :'trace_a2', :'tester_a_id', :'deck_a', :'card_a2', :'session_a', now(),
  0, 0, 'ACTIVE', 'active_weighted_selection', 'pre_goal_balanced',
  0, false, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  null, null, null, '{}', null, null, null, null, false, '{}',
  'learning-engine-v1.0', '{}'::jsonb
);
SELECT tests.clear_auth();

-- =========================================================================
-- Section A: selection_claims -- shape
-- =========================================================================

SELECT has_table('public', 'selection_claims', 'selection_claims table exists');
SELECT col_type_is('public', 'selection_claims', 'id', 'uuid', 'selection_claims.id is uuid');
SELECT col_type_is('public', 'selection_claims', 'user_id', 'uuid', 'selection_claims.user_id is uuid');
SELECT col_type_is('public', 'selection_claims', 'deck_id', 'uuid', 'selection_claims.deck_id is uuid');
SELECT col_type_is('public', 'selection_claims', 'session_id', 'uuid', 'selection_claims.session_id is uuid');
SELECT col_type_is('public', 'selection_claims', 'card_id', 'uuid', 'selection_claims.card_id is uuid');
SELECT col_type_is('public', 'selection_claims', 'selection_trace_id', 'uuid', 'selection_claims.selection_trace_id is uuid');
SELECT col_type_is('public', 'selection_claims', 'scheduler_position', 'integer', 'selection_claims.scheduler_position is integer');
SELECT col_type_is('public', 'selection_claims', 'scheduler_revision', 'integer', 'selection_claims.scheduler_revision is integer');
SELECT col_type_is('public', 'selection_claims', 'status', 'text', 'selection_claims.status is text');
SELECT col_type_is('public', 'selection_claims', 'created_at', 'timestamp with time zone', 'selection_claims.created_at is timestamptz');
SELECT col_type_is('public', 'selection_claims', 'closed_at', 'timestamp with time zone', 'selection_claims.closed_at is timestamptz');

-- =========================================================================
-- Section B: selection_claims -- CHECK + one-OPEN-per-session lifecycle
-- (direct inserts as the privileged connecting role, same pattern every
-- other fixtures-construction step in this suite already uses)
-- =========================================================================

SELECT tests.throws_sqlstate(
  format(
    $sql$insert into public.selection_claims (user_id, deck_id, session_id, card_id, selection_trace_id, scheduler_position, scheduler_revision, status)
         values (%L, %L, %L, %L, %L, 0, 0, 'GARBAGE')$sql$,
    :'tester_a_id', :'deck_a', :'session_a', :'card_a1', :'trace_a1'
  ),
  '23514', 'selection_claims.status rejects a value outside OPEN/ANSWERED/ABANDONED'
);

SELECT lives_ok(
  format(
    $sql$insert into public.selection_claims (id, user_id, deck_id, session_id, card_id, selection_trace_id, scheduler_position, scheduler_revision, status)
         values (gen_random_uuid(), %L, %L, %L, %L, %L, 0, 0, 'OPEN')$sql$,
    :'tester_a_id', :'deck_a', :'session_a', :'card_a1', :'trace_a1'
  ),
  'first OPEN claim for session_a is accepted'
);

SELECT tests.throws_sqlstate(
  format(
    $sql$insert into public.selection_claims (id, user_id, deck_id, session_id, card_id, selection_trace_id, scheduler_position, scheduler_revision, status)
         values (gen_random_uuid(), %L, %L, %L, %L, %L, 1, 1, 'OPEN')$sql$,
    :'tester_a_id', :'deck_a', :'session_a', :'card_a2', :'trace_a2'
  ),
  '23505',
  'a second OPEN claim for the same session is rejected (one-OPEN-per-session invariant)'
);

SELECT lives_ok(
  format(
    $sql$update public.selection_claims set status = 'ANSWERED', closed_at = now() where session_id = %L and status = 'OPEN'$sql$,
    :'session_a'
  ),
  'the first claim can transition OPEN -> ANSWERED'
);

SELECT lives_ok(
  format(
    $sql$insert into public.selection_claims (id, user_id, deck_id, session_id, card_id, selection_trace_id, scheduler_position, scheduler_revision, status)
         values (gen_random_uuid(), %L, %L, %L, %L, %L, 1, 1, 'OPEN')$sql$,
    :'tester_a_id', :'deck_a', :'session_a', :'card_a2', :'trace_a2'
  ),
  'once the first claim is no longer OPEN, a new OPEN claim for the same session is accepted'
);

SELECT lives_ok(
  format(
    $sql$update public.selection_claims set status = 'ABANDONED', closed_at = now() where session_id = %L and status = 'OPEN'$sql$,
    :'session_a'
  ),
  'the second claim can transition OPEN -> ABANDONED'
);

-- =========================================================================
-- Section C: trace retention after abandonment -- an ABANDONED claim
-- still references its SelectionTrace via an ON DELETE RESTRICT foreign
-- key, so the trace can never be deleted out from under it. "Abandoned"
-- means "selected but never answered", not "never happened" -- the
-- trace is never discarded.
-- =========================================================================

SELECT tests.throws_sqlstate(
  format('delete from public.learning_engine_selection_traces where id = %L', :'trace_a2'),
  '23503',
  'a SelectionTrace still referenced by an ABANDONED claim cannot be deleted -- trace retention after abandonment'
);

-- =========================================================================
-- Section D: selection_claims -- grants/RLS
-- =========================================================================

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT tests.assert_no_write_grants('selection_claims');

SELECT is(
  (SELECT count(*)::integer FROM public.selection_claims WHERE session_id = :'session_a'::uuid),
  2, 'tester_a can read their own selection_claims rows'
);
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT is(
  (SELECT count(*)::integer FROM public.selection_claims WHERE session_id = :'session_a'::uuid),
  0, 'tester_b cannot see tester_a''s selection_claims rows (RLS isolation)'
);
SELECT tests.clear_auth();

-- =========================================================================
-- Section E: user_card_progress.last_presented_scheduler_position
-- =========================================================================

SELECT col_type_is('public', 'user_card_progress', 'last_presented_scheduler_position', 'integer', 'last_presented_scheduler_position is integer');
SELECT is(
  (SELECT last_presented_scheduler_position FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a1'::uuid),
  NULL, 'a never-touched row has last_presented_scheduler_position = NULL (never fabricated from legacy history)'
);
SELECT tests.throws_sqlstate(
  format('update public.user_card_progress set last_presented_scheduler_position = -1 where user_id = %L and card_id = %L', :'tester_a_id', :'card_a1'),
  '23514', 'last_presented_scheduler_position rejects a negative value'
);

-- =========================================================================
-- Section F: user_deck_learning_state.first_pass_queue
-- =========================================================================

SELECT col_type_is('public', 'user_deck_learning_state', 'first_pass_queue', 'jsonb', 'first_pass_queue is jsonb');
SELECT is(
  (SELECT first_pass_queue FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid),
  NULL, 'an existing row has first_pass_queue = NULL (no in-flight batch, nothing fabricated)'
);
SELECT lives_ok(
  format(
    $sql$update public.user_deck_learning_state set first_pass_queue = '["%s"]'::jsonb where user_id = %L and deck_id = %L$sql$,
    :'card_a1', :'tester_a_id', :'deck_a'
  ),
  'first_pass_queue accepts a jsonb array of card ids'
);

-- =========================================================================
-- Section G: sessions.engine_version
-- =========================================================================

SELECT col_type_is('public', 'sessions', 'engine_version', 'text', 'sessions.engine_version is text');
SELECT is(
  (SELECT engine_version FROM public.sessions WHERE id = :'session_a'::uuid),
  'legacy', 'a session created before RC-D''s rollout wiring exists defaults to engine_version = legacy'
);
SELECT tests.throws_sqlstate(
  format('update public.sessions set engine_version = ''GARBAGE'' where id = %L', :'session_a'),
  '23514', 'engine_version rejects a value outside legacy/v1'
);
SELECT lives_ok(
  format('update public.sessions set engine_version = ''v1'' where id = %L', :'session_b'),
  'engine_version accepts the literal v1 value (schema permits it; no live code sets it yet)'
);
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT tests.throws_sqlstate(
  format('update public.sessions set engine_version = ''v1'' where id = %L', :'session_a'),
  '42501', 'an authenticated tester cannot set their own session''s engine_version directly (no write grant on sessions at all)'
);
SELECT tests.clear_auth();

-- =========================================================================
-- Section H: learning_engine_v1_rollout
-- =========================================================================

SELECT has_table('public', 'learning_engine_v1_rollout', 'learning_engine_v1_rollout table exists');
SELECT col_type_is('public', 'learning_engine_v1_rollout', 'user_id', 'uuid', 'learning_engine_v1_rollout.user_id is uuid');
SELECT col_type_is('public', 'learning_engine_v1_rollout', 'enabled_at', 'timestamp with time zone', 'learning_engine_v1_rollout.enabled_at is timestamptz');
SELECT col_type_is('public', 'learning_engine_v1_rollout', 'first_v1_answer_at', 'timestamp with time zone', 'learning_engine_v1_rollout.first_v1_answer_at is timestamptz');

-- learning_engine_v1_rollout's primary key is user_id itself (no generic
-- `id` column), so tests.assert_no_write_grants() (which probes `set id
-- = id`) does not apply here -- same reasoning as user_learning_preferences
-- in supabase/tests/015_learning_engine_v1_schema_test.sql; inline the
-- three checks against a real column instead.
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT tests.throws_sqlstate(
  'insert into public.learning_engine_v1_rollout default values',
  '42501', 'authenticated has no INSERT grant on learning_engine_v1_rollout'
);
SELECT tests.throws_sqlstate(
  'update public.learning_engine_v1_rollout set enabled_at = enabled_at',
  '42501', 'authenticated has no UPDATE grant on learning_engine_v1_rollout (cannot set first_v1_answer_at either)'
);
SELECT tests.throws_sqlstate(
  'delete from public.learning_engine_v1_rollout',
  '42501', 'authenticated has no DELETE grant on learning_engine_v1_rollout'
);
SELECT tests.clear_auth();

SELECT lives_ok(
  format('insert into public.learning_engine_v1_rollout (user_id) values (%L)', :'tester_a_id'),
  'the privileged connecting role can admit a tester to the v1 rollout (future admin tooling''s eventual role, not built in RC-A)'
);

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT is(
  (SELECT first_v1_answer_at FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_a_id'::uuid),
  NULL, 'tester_a can read their own rollout row, and first_v1_answer_at is NULL (not yet in the one-way v1 zone)'
);
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT is(
  (SELECT count(*)::integer FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_a_id'::uuid),
  0, 'tester_b cannot see tester_a''s rollout row (RLS isolation -- rollout table is not user-self-service)'
);
SELECT tests.clear_auth();

-- =========================================================================
-- Section I: normalize_card_progress_for_learning_engine_v1 -- NEW
-- =========================================================================

SELECT id AS card_a3 FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 2 \gset

SELECT tests.authenticate_as_service_role();
SELECT lives_ok(
  format(
    $sql$select public.normalize_card_progress_for_learning_engine_v1(
      %L, %L, 'NEW', 'NEW', null, null, null, false, false, null, null, null, 'test-version'
    )$sql$,
    :'tester_a_id', :'card_a3'
  ),
  'NEW normalizes as a true no-op'
);
SELECT is((SELECT card_status FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a3'::uuid), 'NEW', 'NEW card_status unchanged');
SELECT is((SELECT learning_stage FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a3'::uuid), NULL, 'NEW learning_stage stays NULL');
SELECT is((SELECT pool_status FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a3'::uuid), NULL, 'NEW pool_status stays NULL');
SELECT is((SELECT relearning_phase FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a3'::uuid), NULL, 'NEW relearning_phase stays NULL');
SELECT is((SELECT has_ever_been_mastered FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a3'::uuid), false, 'NEW has_ever_been_mastered stays false');
SELECT is((SELECT repair_pending FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a3'::uuid), false, 'NEW repair_pending stays false');

-- =========================================================================
-- Section J: normalize_card_progress_for_learning_engine_v1 -- LEGACY
-- LEARNING (R1, approved)
-- =========================================================================

SELECT tests.clear_auth();
SELECT lives_ok(
  format('update public.user_card_progress set card_status = ''LEARNING'' where user_id = %L and card_id = %L', :'tester_a_id', :'card_a1'),
  'seed: card_a1 is set to legacy LEARNING (simulating pre-cutover data)'
);
SELECT tests.authenticate_as_service_role();

SELECT lives_ok(
  format(
    $sql$select public.normalize_card_progress_for_learning_engine_v1(
      %L, %L, 'LEARNING', 'LEARNING', 'FRESH', 'ACTIVE', null, false, false, null, null, null, 'test-version'
    )$sql$,
    :'tester_a_id', :'card_a1'
  ),
  'legacy LEARNING normalizes successfully'
);
SELECT is((SELECT card_status FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a1'::uuid), 'LEARNING', 'legacy LEARNING -- card_status stays LEARNING');
SELECT is((SELECT learning_stage FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a1'::uuid), 'FRESH', 'legacy LEARNING -- learning_stage normalizes to FRESH, never inferring LEARNING_1/LEARNING_2');
SELECT is((SELECT pool_status FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a1'::uuid), 'ACTIVE', 'legacy LEARNING -- pool_status normalizes to ACTIVE');
SELECT is((SELECT relearning_phase FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a1'::uuid), NULL, 'legacy LEARNING -- relearning_phase stays NULL');
SELECT is((SELECT has_ever_been_mastered FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a1'::uuid), false, 'legacy LEARNING -- has_ever_been_mastered stays false');
SELECT is((SELECT repair_pending FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a1'::uuid), false, 'legacy LEARNING -- repair_pending stays false');

-- =========================================================================
-- Section K: normalize_card_progress_for_learning_engine_v1 -- LEGACY
-- FORGOTTEN (R2 + the approved pre-RC-A repair-completeness rule)
-- =========================================================================

SELECT tests.clear_auth();
SELECT lives_ok(
  format(
    'update public.user_card_progress set card_status = ''FORGOTTEN'', has_ever_been_mastered = false where user_id = %L and card_id = %L',
    :'tester_a_id', :'card_a2'
  ),
  'seed: card_a2 is set to legacy FORGOTTEN with has_ever_been_mastered still false -- reproducing the under-backfilled gap the pre-RC-A audit found'
);
SELECT tests.authenticate_as_service_role();

SELECT lives_ok(
  format(
    $sql$select public.normalize_card_progress_for_learning_engine_v1(
      %L, %L, 'FORGOTTEN', 'FORGOTTEN', null, 'ACTIVE', 'REPAIR_PENDING', true, true, 0, 4, 7, 'test-version'
    )$sql$,
    :'tester_a_id', :'card_a2'
  ),
  'legacy FORGOTTEN normalizes successfully with a complete synthetic RepairObligation'
);
SELECT is((SELECT card_status FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid), 'FORGOTTEN', 'legacy FORGOTTEN -- card_status stays FORGOTTEN');
SELECT is((SELECT learning_stage FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid), NULL, 'legacy FORGOTTEN -- learning_stage stays NULL');
SELECT is((SELECT pool_status FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid), 'ACTIVE', 'legacy FORGOTTEN -- pool_status normalizes to ACTIVE');
SELECT is((SELECT relearning_phase FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid), 'REPAIR_PENDING', 'legacy FORGOTTEN -- relearning_phase normalizes to REPAIR_PENDING');
SELECT is((SELECT has_ever_been_mastered FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid), true, 'legacy FORGOTTEN -- has_ever_been_mastered forced TRUE (the R2 fix, correcting the under-backfilled seed state)');
SELECT is((SELECT repair_pending FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid), true, 'legacy FORGOTTEN -- repair_pending becomes true (a RepairObligation now exists)');
SELECT is((SELECT repair_wrong_position FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid), 0, 'legacy FORGOTTEN -- repair_wrong_position is the supplied synthetic ordinal');
SELECT is((SELECT repair_target_position FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid), 4, 'legacy FORGOTTEN -- repair_target_position is non-null and complete');
SELECT is((SELECT repair_hard_cap_position FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid), 7, 'legacy FORGOTTEN -- repair_hard_cap_position is non-null and complete');

-- Structural repair-obligation-completeness rejections (the exact
-- invariant the pre-RC-A audit was about, enforced again at the DB layer).
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.normalize_card_progress_for_learning_engine_v1(
      %L, %L, 'FORGOTTEN', 'FORGOTTEN', null, 'ACTIVE', 'REPAIR_PENDING', true, true, null, 4, 7, 'test-version'
    )$sql$,
    :'tester_a_id', :'card_a2'
  ),
  '22023', 'repair_pending=true with a NULL repair_wrong_position is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.normalize_card_progress_for_learning_engine_v1(
      %L, %L, 'FORGOTTEN', 'FORGOTTEN', null, 'ACTIVE', null, true, false, 0, 4, 7, 'test-version'
    )$sql$,
    :'tester_a_id', :'card_a2'
  ),
  '22023', 'repair_pending=false with non-null repair positions is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.normalize_card_progress_for_learning_engine_v1(
      %L, %L, 'FORGOTTEN', 'FORGOTTEN', null, 'ACTIVE', 'REPAIR_PENDING', true, false, null, null, null, 'test-version'
    )$sql$,
    :'tester_a_id', :'card_a2'
  ),
  '22023', 'relearning_phase=REPAIR_PENDING with repair_pending=false is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.normalize_card_progress_for_learning_engine_v1(
      %L, %L, 'FORGOTTEN', 'FORGOTTEN', null, 'ACTIVE', 'REPAIR_PENDING', true, true, 0, 7, 4, 'test-version'
    )$sql$,
    :'tester_a_id', :'card_a2'
  ),
  '22023', 'an internally-inconsistent repair window (hard_cap < target) is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.normalize_card_progress_for_learning_engine_v1(
      %L, %L, 'FORGOTTEN', 'ACQUIRED', null, 'OUTSIDE', null, true, false, null, null, null, 'test-version'
    )$sql$,
    :'tester_a_id', :'card_a2'
  ),
  '22023', 'ACQUIRED is never a legal one-time legacy-normalization target card_status'
);

-- Drift protection: the row is now FORGOTTEN (already normalized above),
-- so an attempt that still expects legacy LEARNING must be rejected as
-- stale rather than silently overwriting it.
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.normalize_card_progress_for_learning_engine_v1(
      %L, %L, 'LEARNING', 'LEARNING', 'FRESH', 'ACTIVE', null, false, false, null, null, null, 'test-version'
    )$sql$,
    :'tester_a_id', :'card_a2'
  ),
  '40001', 'a drifted expected_legacy_card_status is rejected rather than silently overwritten'
);

-- Idempotency: re-applying the SAME already-applied normalization
-- (now correctly expecting FORGOTTEN, since that is what the row already
-- is) reproduces the identical stored state.
SELECT lives_ok(
  format(
    $sql$select public.normalize_card_progress_for_learning_engine_v1(
      %L, %L, 'FORGOTTEN', 'FORGOTTEN', null, 'ACTIVE', 'REPAIR_PENDING', true, true, 0, 4, 7, 'test-version'
    )$sql$,
    :'tester_a_id', :'card_a2'
  ),
  'retrying the identical normalization is accepted'
);
SELECT is((SELECT card_status FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid), 'FORGOTTEN', 'retry -- card_status unchanged');
SELECT is((SELECT pool_status FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid), 'ACTIVE', 'retry -- pool_status unchanged');
SELECT is((SELECT relearning_phase FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid), 'REPAIR_PENDING', 'retry -- relearning_phase unchanged');
SELECT is((SELECT has_ever_been_mastered FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid), true, 'retry -- has_ever_been_mastered unchanged');
SELECT is((SELECT repair_wrong_position FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid), 0, 'retry -- repair_wrong_position unchanged (retrying normalization cannot silently change the obligation)');
SELECT is((SELECT repair_target_position FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid), 4, 'retry -- repair_target_position unchanged');
SELECT is((SELECT repair_hard_cap_position FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid), 7, 'retry -- repair_hard_cap_position unchanged');

SELECT tests.clear_auth();

-- =========================================================================
-- Section L: recompute_user_deck_learning_state_for_v1 -- mastered_count /
-- has_achieved_full_mastery reconciliation and monotonicity
-- =========================================================================

SELECT tests.authenticate_as_service_role();

SELECT lives_ok(
  format('select public.recompute_user_deck_learning_state_for_v1(%L, %L)', :'tester_a_id', :'deck_a'),
  'recompute runs successfully after per-card normalization'
);
SELECT is(
  (SELECT mastered_count FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid),
  (SELECT count(*)::integer FROM public.user_card_progress ucp JOIN public.cards c ON c.id = ucp.card_id
     WHERE ucp.user_id = :'tester_a_id'::uuid AND c.deck_id = :'deck_a'::uuid AND c.deleted_at IS NULL AND ucp.card_status = 'LEARNED'),
  'mastered_count reconciles with the FINAL normalized live card state (currently 0 -- card_a1 is LEARNING, card_a2 is FORGOTTEN)'
);

SELECT tests.clear_auth();
SELECT lives_ok(
  format(
    'update public.user_card_progress set card_status = ''LEARNED'' where user_id = %L and card_id in (select id from public.cards where deck_id = %L)',
    :'tester_a_id', :'deck_a'
  ),
  'seed: every card in deck_a is marked LEARNED, for the Full Mastery recompute case'
);
SELECT tests.authenticate_as_service_role();

SELECT lives_ok(
  format('select public.recompute_user_deck_learning_state_for_v1(%L, %L)', :'tester_a_id', :'deck_a'),
  'recompute runs successfully against the all-LEARNED deck state'
);
SELECT is(
  (SELECT mastered_count FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid),
  (SELECT count(*)::integer FROM public.cards WHERE deck_id = :'deck_a'::uuid AND deleted_at IS NULL),
  'mastered_count equals the full deck size'
);
SELECT is(
  (SELECT has_achieved_full_mastery FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid),
  true, 'has_achieved_full_mastery becomes true'
);

SELECT tests.clear_auth();
SELECT lives_ok(
  format('update public.user_card_progress set card_status = ''FORGOTTEN'' where user_id = %L and card_id = %L', :'tester_a_id', :'card_a1'),
  'seed: one card lapses back to FORGOTTEN after Full Mastery was achieved'
);
SELECT tests.authenticate_as_service_role();

SELECT lives_ok(
  format('select public.recompute_user_deck_learning_state_for_v1(%L, %L)', :'tester_a_id', :'deck_a'),
  'recompute runs successfully after the lapse'
);
SELECT is(
  (SELECT has_achieved_full_mastery FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid),
  true, 'has_achieved_full_mastery remains true after a lapse (monotonicity: 25.1 -- never cleared once set)'
);
SELECT is(
  (SELECT mastered_count FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid),
  (SELECT count(*)::integer FROM public.cards WHERE deck_id = :'deck_a'::uuid AND deleted_at IS NULL) - 1,
  'mastered_count correctly decreases to reflect the lapse (Deck Progress may legitimately decrease; Full Mastery flag does not)'
);

SELECT tests.clear_auth();

SELECT * FROM finish();
ROLLBACK;
