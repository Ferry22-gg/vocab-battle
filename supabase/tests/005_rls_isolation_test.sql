\ir fixtures/000_test_helpers.inc

-- Group 5: RLS isolation.
-- Maps to DATABASE_SCHEMA.md §17 / §7.1-7.2:
--   "tester cannot read another tester's private data"
--   "admin can read beta data but is excluded from analytics" (read half)
--   "authenticated has no direct INSERT/UPDATE/DELETE grant on any
--   trusted-state table"

BEGIN;
SELECT plan(31);

SELECT gen_random_uuid() AS tester_a_id \gset
SELECT gen_random_uuid() AS tester_b_id \gset
SELECT gen_random_uuid() AS admin_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS deck_i_id \gset

SELECT tests.create_test_profile(:'tester_a_id'::uuid, 'test_g5_tester_a');
SELECT tests.create_test_profile(:'tester_b_id'::uuid, 'test_g5_tester_b');
SELECT tests.create_test_profile(:'admin_id'::uuid, 'test_g5_admin', 'admin', 'active', true);

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS tester_a_deck \gset
SELECT (public.start_or_resume_session()).id AS tester_a_session \gset
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS tester_b_deck \gset
SELECT (public.start_or_resume_session()).id AS tester_b_session \gset
SELECT tests.clear_auth();

-- -----------------------------------------------------------------------
-- Read isolation: tester A cannot see tester B's private learner data
-- -----------------------------------------------------------------------
SELECT tests.authenticate_as(:'tester_a_id'::uuid);

SELECT is(
  (SELECT count(*)::int FROM public.profiles WHERE id = :'tester_b_id'::uuid),
  0, 'tester A cannot read tester B''s profile row'
);
SELECT is(
  (SELECT count(*)::int FROM public.decks WHERE id = :'tester_b_deck'::uuid),
  0, 'tester A cannot read tester B''s private deck'
);
SELECT is(
  (SELECT count(*)::int FROM public.cards WHERE deck_id = :'tester_b_deck'::uuid),
  0, 'tester A cannot read tester B''s cards'
);
SELECT is(
  (SELECT count(*)::int FROM public.user_card_progress WHERE user_id = :'tester_b_id'::uuid),
  0, 'tester A cannot read tester B''s user_card_progress'
);
SELECT is(
  (SELECT count(*)::int FROM public.sessions WHERE id = :'tester_b_session'::uuid),
  0, 'tester A cannot read tester B''s sessions'
);

-- -----------------------------------------------------------------------
-- Mutation isolation: tester A cannot mutate tester B's decks/cards
-- (RLS silently excludes the row from the UPDATE's target set rather
-- than raising -- the observable effect is that the row is unchanged)
-- -----------------------------------------------------------------------
UPDATE public.decks SET name = 'HACKED BY TESTER A' WHERE id = :'tester_b_deck'::uuid;
UPDATE public.cards SET front = 'HACKED' WHERE deck_id = :'tester_b_deck'::uuid;

SELECT tests.clear_auth();

SELECT isnt(
  (SELECT name FROM public.decks WHERE id = :'tester_b_deck'::uuid),
  'HACKED BY TESTER A',
  'tester A''s UPDATE against tester B''s deck had no effect'
);
SELECT is(
  (SELECT count(*)::int FROM public.cards WHERE deck_id = :'tester_b_deck'::uuid AND front = 'HACKED'),
  0,
  'tester A''s UPDATE against tester B''s cards had no effect'
);

-- -----------------------------------------------------------------------
-- Admin can read beta data where documented
-- -----------------------------------------------------------------------
SELECT tests.authenticate_as(:'admin_id'::uuid);

SELECT is(
  (SELECT count(*)::int FROM public.profiles WHERE id = :'tester_a_id'::uuid),
  1, 'admin can read tester A''s profile'
);
SELECT is(
  (SELECT count(*)::int FROM public.decks WHERE id = :'tester_a_deck'::uuid),
  1, 'admin can read tester A''s deck'
);
SELECT is(
  (SELECT count(*)::int FROM public.sessions WHERE id = :'tester_a_session'::uuid),
  1, 'admin can read tester A''s session'
);

SELECT tests.clear_auth();

-- -----------------------------------------------------------------------
-- authenticated has no direct INSERT/UPDATE/DELETE on any of the seven
-- trusted-state tables (§7.2) -- 3 assertions x 7 tables = 21
-- -----------------------------------------------------------------------
SELECT tests.authenticate_as(:'tester_a_id'::uuid);

SELECT * FROM tests.assert_no_write_grants('user_card_progress');
SELECT * FROM tests.assert_no_write_grants('sessions');
SELECT * FROM tests.assert_no_write_grants('session_review_cards');
SELECT * FROM tests.assert_no_write_grants('session_learning_queue');
SELECT * FROM tests.assert_no_write_grants('answer_events');
SELECT * FROM tests.assert_no_write_grants('daily_user_stats');
SELECT * FROM tests.assert_no_write_grants('xp_events');

SELECT tests.clear_auth();

SELECT * FROM finish();
ROLLBACK;
