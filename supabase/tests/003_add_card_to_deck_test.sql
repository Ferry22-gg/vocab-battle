\ir fixtures/000_test_helpers.inc

-- Group 3: add_card_to_deck().
-- Maps to DATABASE_SCHEMA.md §17 (post-Phase-6C additions):
--   "authenticated has no direct INSERT grant on cards -- the only tester
--   card-creation path is add_card_to_deck()"
--   "add_card_to_deck() always creates the card and its NEW
--   user_card_progress row together"
--   §10.7 required behavior, §10.6 admin exclusion.

BEGIN;
SELECT plan(9);

SELECT gen_random_uuid() AS tester_a_id \gset
SELECT gen_random_uuid() AS tester_b_id \gset
SELECT gen_random_uuid() AS admin_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS deck_i_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary II') AS deck_ii_id \gset

SELECT tests.create_test_profile(:'tester_a_id'::uuid, 'test_g3_tester_a');
SELECT tests.create_test_profile(:'tester_b_id'::uuid, 'test_g3_tester_b');
SELECT tests.create_test_profile(:'admin_id'::uuid, 'test_g3_admin', 'admin', 'active', true);

-- Fixture setup: give each tester an owned deck via the real trusted
-- duplication path (there is no direct deck-INSERT path any more).
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS tester_a_deck1 \gset
SELECT (public.duplicate_starter_deck(:'deck_ii_id'::uuid)).id AS tester_a_deck2 \gset
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS tester_b_deck1 \gset
SELECT tests.clear_auth();

-- active tester can add a personal card to their own non-archived,
-- non-deleted deck
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT (public.add_card_to_deck(:'tester_a_deck1'::uuid, 'ephemeral', 'はかない')).id AS new_card_id \gset
SELECT tests.clear_auth();

SELECT ok(:'new_card_id' IS NOT NULL, 'add_card_to_deck() returns a created card');

-- created_by_user_id = tester, source_card_id = NULL, correct deck
SELECT is(
  (SELECT deck_id FROM public.cards WHERE id = :'new_card_id'::uuid),
  :'tester_a_deck1'::uuid,
  'the new card belongs to the target deck'
);

SELECT is(
  (SELECT created_by_user_id FROM public.cards WHERE id = :'new_card_id'::uuid),
  :'tester_a_id'::uuid,
  'created_by_user_id is the calling tester'
);

SELECT ok(
  (SELECT source_card_id FROM public.cards WHERE id = :'new_card_id'::uuid) IS NULL,
  'source_card_id is NULL for a personally-authored card'
);

-- card + matching NEW user_card_progress are created atomically. True
-- fault-injected atomicity (forcing the second INSERT to fail after the
-- first succeeds) is not exercised here -- both inserts happen inside one
-- PL/pgSQL function invocation, which is structurally one transaction, so
-- any exception between them unwinds both; what this test confirms is
-- that the pairing is actually present, which is the externally
-- observable half of that guarantee.
SELECT is(
  (SELECT count(*)::int FROM public.user_card_progress
    WHERE user_id = :'tester_a_id'::uuid
      AND card_id = :'new_card_id'::uuid
      AND card_status = 'NEW'
      AND seen_count = 0 AND correct_streak = 0 AND wrong_streak = 0),
  1,
  'the matching NEW user_card_progress row was created in the same call'
);

-- cannot add to another tester's deck
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT tests.throws_sqlstate(
  format('select public.add_card_to_deck(%L, %L, %L)', :'tester_b_deck1', 'x', 'y'),
  '42501',
  'tester A cannot add a card to tester B''s deck'
);
SELECT tests.clear_auth();

-- cannot add to an archived deck
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
UPDATE public.decks SET archived_at = now() WHERE id = :'tester_a_deck1'::uuid;
SELECT tests.throws_sqlstate(
  format('select public.add_card_to_deck(%L, %L, %L)', :'tester_a_deck1', 'x', 'y'),
  '42501',
  'tester A cannot add a card to their own archived deck'
);
SELECT tests.clear_auth();

-- cannot add to a deleted (soft-deleted) deck
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
UPDATE public.decks SET deleted_at = now() WHERE id = :'tester_a_deck2'::uuid;
SELECT tests.throws_sqlstate(
  format('select public.add_card_to_deck(%L, %L, %L)', :'tester_a_deck2', 'x', 'y'),
  '42501',
  'tester A cannot add a card to their own soft-deleted deck'
);
SELECT tests.clear_auth();

-- admin cannot use it
SELECT tests.authenticate_as(:'admin_id'::uuid);
SELECT tests.throws_sqlstate(
  format('select public.add_card_to_deck(%L, %L, %L)', :'tester_b_deck1', 'x', 'y'),
  '28000',
  'admin is rejected by add_card_to_deck() regardless of target deck'
);
SELECT tests.clear_auth();

SELECT * FROM finish();
ROLLBACK;
