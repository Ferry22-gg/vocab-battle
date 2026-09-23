\ir fixtures/000_test_helpers.inc

-- Group 6: Column-level grants.
-- Maps to DATABASE_SCHEMA.md §7.2 ("profiles"/"decks"/"cards" write-access
-- rewrite) and §17's corresponding acceptance checks. Column-privilege
-- violations are raised by Postgres before RLS is even evaluated, so
-- every target row below belongs to the acting tester themselves --
-- failure here can only be the column grant, never RLS ownership.

BEGIN;
SELECT plan(20);

SELECT gen_random_uuid() AS tester_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS deck_i_id \gset

SELECT tests.create_test_profile(:'tester_id'::uuid, 'test_g6_tester');

SELECT tests.authenticate_as(:'tester_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS tester_deck \gset
SELECT id AS tester_card FROM public.cards WHERE deck_id = :'tester_deck'::uuid LIMIT 1 \gset

-- -----------------------------------------------------------------------
-- profiles: protected columns
-- -----------------------------------------------------------------------
SELECT tests.throws_sqlstate(
  format('update public.profiles set role = %L where id = %L', 'admin', :'tester_id'),
  '42501', 'authenticated cannot directly UPDATE profiles.role'
);
SELECT tests.throws_sqlstate(
  format('update public.profiles set account_status = %L where id = %L', 'disabled', :'tester_id'),
  '42501', 'authenticated cannot directly UPDATE profiles.account_status'
);
SELECT tests.throws_sqlstate(
  format('update public.profiles set total_xp = 999999 where id = %L', :'tester_id'),
  '42501', 'authenticated cannot directly UPDATE profiles.total_xp'
);
SELECT tests.throws_sqlstate(
  format('update public.profiles set level = 99 where id = %L', :'tester_id'),
  '42501', 'authenticated cannot directly UPDATE profiles.level'
);
SELECT tests.throws_sqlstate(
  format('update public.profiles set selected_deck_id = %L where id = %L', :'tester_deck', :'tester_id'),
  '42501', 'authenticated cannot directly UPDATE profiles.selected_deck_id'
);

-- -----------------------------------------------------------------------
-- decks: protected columns (target the tester's OWN deck, so RLS
-- ownership is not what's blocking the write)
-- -----------------------------------------------------------------------
SELECT tests.throws_sqlstate(
  format('update public.decks set owner_user_id = gen_random_uuid() where id = %L', :'tester_deck'),
  '42501', 'authenticated cannot directly UPDATE decks.owner_user_id'
);
SELECT tests.throws_sqlstate(
  format('update public.decks set source_deck_id = gen_random_uuid() where id = %L', :'tester_deck'),
  '42501', 'authenticated cannot directly UPDATE decks.source_deck_id'
);
SELECT tests.throws_sqlstate(
  format('update public.decks set is_template = true where id = %L', :'tester_deck'),
  '42501', 'authenticated cannot directly UPDATE decks.is_template'
);
SELECT tests.throws_sqlstate(
  format('update public.decks set is_official = true where id = %L', :'tester_deck'),
  '42501', 'authenticated cannot directly UPDATE decks.is_official'
);
SELECT tests.throws_sqlstate(
  format('update public.decks set front_language = %L where id = %L', 'fr', :'tester_deck'),
  '42501', 'authenticated cannot directly UPDATE decks.front_language'
);
SELECT tests.throws_sqlstate(
  format('update public.decks set back_language = %L where id = %L', 'fr', :'tester_deck'),
  '42501', 'authenticated cannot directly UPDATE decks.back_language'
);

-- -----------------------------------------------------------------------
-- cards: protected columns (target a card in the tester's OWN deck)
-- -----------------------------------------------------------------------
SELECT tests.throws_sqlstate(
  format('update public.cards set deck_id = gen_random_uuid() where id = %L', :'tester_card'),
  '42501', 'authenticated cannot directly UPDATE cards.deck_id'
);
SELECT tests.throws_sqlstate(
  format('update public.cards set created_by_user_id = gen_random_uuid() where id = %L', :'tester_card'),
  '42501', 'authenticated cannot directly UPDATE cards.created_by_user_id'
);
SELECT tests.throws_sqlstate(
  format('update public.cards set source_card_id = gen_random_uuid() where id = %L', :'tester_card'),
  '42501', 'authenticated cannot directly UPDATE cards.source_card_id'
);

-- -----------------------------------------------------------------------
-- Permitted editable columns still work
-- -----------------------------------------------------------------------
SELECT lives_ok(
  format('update public.profiles set nickname = %L where id = %L', 'TesterNickname', :'tester_id'),
  'authenticated CAN update profiles.nickname'
);
SELECT lives_ok(
  format('update public.decks set name = %L where id = %L', 'Renamed Deck', :'tester_deck'),
  'authenticated CAN update decks.name (own deck)'
);
SELECT lives_ok(
  format('update public.cards set front = %L where id = %L', 'renamed-front', :'tester_card'),
  'authenticated CAN update cards.front (own card)'
);

SELECT tests.clear_auth();

SELECT is(
  (SELECT nickname FROM public.profiles WHERE id = :'tester_id'::uuid),
  'TesterNickname', 'permitted profiles.nickname update actually took effect'
);
SELECT is(
  (SELECT name FROM public.decks WHERE id = :'tester_deck'::uuid),
  'Renamed Deck', 'permitted decks.name update actually took effect'
);
SELECT is(
  (SELECT front FROM public.cards WHERE id = :'tester_card'::uuid),
  'renamed-front', 'permitted cards.front update actually took effect'
);

SELECT * FROM finish();
ROLLBACK;
