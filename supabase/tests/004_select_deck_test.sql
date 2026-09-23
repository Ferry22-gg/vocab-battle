\ir fixtures/000_test_helpers.inc

-- Group 4: select_deck().
-- Maps to DATABASE_SCHEMA.md §17:
--   "select_deck() only succeeds for a deck the caller owns that is
--   neither archived nor deleted, and is the only direct path to change
--   profiles.selected_deck_id outside of duplicate_starter_deck()"
--   §10.8 required behavior, §10.6 admin exclusion.

BEGIN;
SELECT plan(6);

SELECT gen_random_uuid() AS tester_a_id \gset
SELECT gen_random_uuid() AS tester_b_id \gset
SELECT gen_random_uuid() AS admin_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS deck_i_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary II') AS deck_ii_id \gset

SELECT tests.create_test_profile(:'tester_a_id'::uuid, 'test_g4_tester_a');
SELECT tests.create_test_profile(:'tester_b_id'::uuid, 'test_g4_tester_b');
SELECT tests.create_test_profile(:'admin_id'::uuid, 'test_g4_admin', 'admin', 'active', true);

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS tester_a_deck1 \gset
SELECT (public.duplicate_starter_deck(:'deck_ii_id'::uuid)).id AS tester_a_deck2 \gset
-- selected_deck_id is now tester_a_deck2 (the most recently duplicated one)
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS tester_b_deck1 \gset
SELECT tests.clear_auth();

-- tester can select their own (different) active deck
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT is(
  (public.select_deck(:'tester_a_deck1'::uuid)).id,
  :'tester_a_deck1'::uuid,
  'select_deck() returns the selected deck'
);
SELECT tests.clear_auth();

SELECT is(
  (SELECT selected_deck_id FROM public.profiles WHERE id = :'tester_a_id'::uuid),
  :'tester_a_deck1'::uuid,
  'profiles.selected_deck_id is switched to the newly selected deck'
);

-- cannot select another tester's deck
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT tests.throws_sqlstate(
  format('select public.select_deck(%L)', :'tester_b_deck1'),
  '42501',
  'tester A cannot select tester B''s deck'
);
SELECT tests.clear_auth();

-- cannot select an archived deck
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
UPDATE public.decks SET archived_at = now() WHERE id = :'tester_a_deck2'::uuid;
SELECT tests.throws_sqlstate(
  format('select public.select_deck(%L)', :'tester_a_deck2'),
  '42501',
  'tester A cannot select their own archived deck'
);
SELECT tests.clear_auth();

-- cannot select a soft-deleted deck
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
UPDATE public.decks SET deleted_at = now() WHERE id = :'tester_a_deck1'::uuid;
SELECT tests.throws_sqlstate(
  format('select public.select_deck(%L)', :'tester_a_deck1'),
  '42501',
  'tester A cannot select their own soft-deleted deck'
);
SELECT tests.clear_auth();

-- admin cannot use it
SELECT tests.authenticate_as(:'admin_id'::uuid);
SELECT tests.throws_sqlstate(
  format('select public.select_deck(%L)', :'tester_b_deck1'),
  '28000',
  'admin is rejected by select_deck() regardless of target deck'
);
SELECT tests.clear_auth();

SELECT * FROM finish();
ROLLBACK;
