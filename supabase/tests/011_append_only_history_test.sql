\ir fixtures/000_test_helpers.inc

-- Group 11: Append-only / history integrity.
-- Maps to DATABASE_SCHEMA.md §17 / §7.2:
--   "answer_events and xp_events remain append-only in the stricter sense
--   too: no policy or grant permits UPDATE/DELETE on them under any
--   circumstance, including for admin"

BEGIN;
SELECT plan(12);

SELECT gen_random_uuid() AS tester_a_id \gset
SELECT gen_random_uuid() AS tester_b_id \gset
SELECT gen_random_uuid() AS admin_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS deck_i_id \gset

SELECT tests.create_test_profile(:'tester_a_id'::uuid, 'test_g11_tester_a');
SELECT tests.create_test_profile(:'tester_b_id'::uuid, 'test_g11_tester_b');
SELECT tests.create_test_profile(:'admin_id'::uuid, 'test_g11_admin', 'admin', 'active', true);

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS deck_a \gset
SELECT (public.start_or_resume_session()).id AS session_a \gset
SELECT tests.clear_auth();

SELECT id AS card_a FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 \gset

SELECT tests.authenticate_as_service_role();
SELECT tests.call_commit_answer(gen_random_uuid(), :'tester_a_id'::uuid, :'session_a'::uuid, :'card_a'::uuid, true, 'learning');
SELECT tests.clear_auth();

-- -----------------------------------------------------------------------
-- authenticated has no INSERT/UPDATE/DELETE grant on answer_events or
-- xp_events, under any tester identity
-- -----------------------------------------------------------------------
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT * FROM tests.assert_no_write_grants('answer_events');
SELECT * FROM tests.assert_no_write_grants('xp_events');
SELECT tests.clear_auth();

-- -----------------------------------------------------------------------
-- Read scoping: own vs. another tester's vs. admin
-- -----------------------------------------------------------------------
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT is(
  (SELECT count(*)::int FROM public.answer_events WHERE session_id = :'session_a'::uuid),
  1, 'tester A can read their own answer_events'
);
SELECT ok(
  (SELECT count(*)::int FROM public.xp_events WHERE user_id = :'tester_a_id'::uuid) >= 1,
  'tester A can read their own xp_events'
);
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT is(
  (SELECT count(*)::int FROM public.answer_events WHERE session_id = :'session_a'::uuid),
  0, 'tester B cannot read tester A''s answer_events'
);
SELECT is(
  (SELECT count(*)::int FROM public.xp_events WHERE user_id = :'tester_a_id'::uuid),
  0, 'tester B cannot read tester A''s xp_events'
);
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'admin_id'::uuid);
SELECT is(
  (SELECT count(*)::int FROM public.answer_events WHERE session_id = :'session_a'::uuid),
  1, 'admin can read tester A''s answer_events'
);
SELECT ok(
  (SELECT count(*)::int FROM public.xp_events WHERE user_id = :'tester_a_id'::uuid) >= 1,
  'admin can read tester A''s xp_events'
);
SELECT tests.clear_auth();

SELECT * FROM finish();
ROLLBACK;
