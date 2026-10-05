\ir fixtures/000_test_helpers.inc

-- Group 23: Learning Engine v1, pre-RC-E corrective -- enrollment-time
-- active-legacy-session guard.
-- Maps to supabase/migrations/
-- 20261019000000_learning_engine_v1_enrollment_active_legacy_session_guard.sql.
--
-- Covers admit_user_to_learning_engine_v1()'s new transactional check
-- only -- the TypeScript-side guard in
-- lib/learning-engine/cutover/enroll.ts (getActiveLegacySessionForUser(),
-- getLearningEngineV1RolloutRow()) is covered at its own layer by
-- tests/unit/learning-engine-cutover-enroll.test.ts.

BEGIN;
SELECT plan(7);

-- =========================================================================
-- Fixtures
-- =========================================================================
-- tester_g: has an ACTIVE legacy session at admission time -> rejected.
SELECT gen_random_uuid() AS tester_g_id \gset
-- tester_h: HAD a legacy session, but it was finished before admission -> allowed.
SELECT gen_random_uuid() AS tester_h_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS official_deck_id \gset

SELECT tests.create_test_profile(:'tester_g_id'::uuid, 'test_g22_tester_g');
SELECT tests.create_test_profile(:'tester_h_id'::uuid, 'test_g22_tester_h');

-- =========================================================================
-- Section A: an ACTIVE legacy session blocks admission.
-- =========================================================================

SELECT tests.authenticate_as(:'tester_g_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_g \gset
SELECT (public.start_or_resume_session()).id AS session_g \gset
SELECT tests.clear_auth();

SELECT is(
  (SELECT engine_version FROM public.sessions WHERE id = :'session_g'::uuid),
  'legacy', 'A0: session_g is a legacy session (sanity check before admitting)'
);
SELECT is(
  (SELECT status FROM public.sessions WHERE id = :'session_g'::uuid),
  'active', 'A1: session_g is active (sanity check before admitting)'
);

SELECT tests.authenticate_as_service_role();
SELECT tests.throws_sqlstate(
  format('select public.admit_user_to_learning_engine_v1(%L)', :'tester_g_id'),
  '42501', 'A2: admit_user_to_learning_engine_v1 rejects a user with an active legacy session'
);
SELECT tests.clear_auth();

SELECT is(
  (SELECT count(*)::integer FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_g_id'::uuid),
  0, 'A3: the rejected admission created no rollout row'
);
SELECT is(
  (SELECT status FROM public.sessions WHERE id = :'session_g'::uuid),
  'active', 'A4: the rejected admission left the legacy session untouched (still active -- never auto-finished)'
);

-- =========================================================================
-- Section B: a legacy session that has already been finished does not
-- block admission.
-- =========================================================================

SELECT tests.authenticate_as(:'tester_h_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_h \gset
SELECT (public.start_or_resume_session()).id AS session_h \gset
SELECT public.finish_session(:'session_h'::uuid);
SELECT tests.clear_auth();

SELECT is(
  (SELECT status FROM public.sessions WHERE id = :'session_h'::uuid),
  'completed', 'B0: session_h is completed (sanity check before admitting)'
);

SELECT tests.authenticate_as_service_role();
SELECT public.admit_user_to_learning_engine_v1(:'tester_h_id'::uuid);
SELECT tests.clear_auth();

SELECT is(
  (SELECT count(*)::integer FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_h_id'::uuid),
  1, 'B1: admission succeeds once the only legacy session has been finished'
);

SELECT * FROM finish();
ROLLBACK;
