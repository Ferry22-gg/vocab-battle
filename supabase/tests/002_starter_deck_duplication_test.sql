\ir fixtures/000_test_helpers.inc

-- Group 2: Starter deck duplication (duplicate_starter_deck()).
-- Maps to DATABASE_SCHEMA.md §17:
--   "starter deck duplication produces: 1 user-owned deck / 100 independent
--   card copies / 100 NEW progress rows"
--   "re-running starter duplication does not create unintended duplicates"
--   §10.1 required behavior, §10.6 admin exclusion.

BEGIN;
SELECT plan(14);

SELECT gen_random_uuid() AS tester_id \gset
SELECT gen_random_uuid() AS admin_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS official_deck_id \gset

SELECT tests.create_test_profile(:'tester_id'::uuid, 'test_g2_tester_a');
SELECT tests.create_test_profile(:'admin_id'::uuid, 'test_g2_admin', 'admin', 'active', true);

-- active tester can duplicate an official template
SELECT tests.authenticate_as(:'tester_id'::uuid);
SELECT lives_ok(
  format('select public.duplicate_starter_deck(%L)', :'official_deck_id'),
  'an active tester can call duplicate_starter_deck() on an official template'
);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS dup_deck_id \gset
SELECT tests.clear_auth();

-- produces exactly 1 user-owned deck copy
SELECT is(
  (SELECT count(*)::int FROM public.decks WHERE owner_user_id = :'tester_id'::uuid),
  1,
  'duplication produces exactly 1 user-owned deck'
);

SELECT is(
  (SELECT source_deck_id FROM public.decks WHERE id = :'dup_deck_id'::uuid),
  :'official_deck_id'::uuid,
  'the duplicated deck''s source_deck_id points at the official template'
);

-- produces exactly 100 independent card copies
SELECT is(
  (SELECT count(*)::int FROM public.cards WHERE deck_id = :'dup_deck_id'::uuid),
  100,
  'duplication produces exactly 100 card copies'
);

SELECT is(
  (SELECT count(*)::int FROM public.cards WHERE deck_id = :'dup_deck_id'::uuid AND source_card_id IS NOT NULL),
  100,
  'every duplicated card carries a source_card_id back to its official original'
);

SELECT is(
  (SELECT count(*)::int FROM public.cards WHERE deck_id = :'dup_deck_id'::uuid AND created_by_user_id = :'tester_id'::uuid),
  100,
  'every duplicated card is attributed to the duplicating tester'
);

-- produces exactly 100 NEW user_card_progress rows
SELECT is(
  (SELECT count(*)::int FROM public.user_card_progress ucp
     JOIN public.cards c ON c.id = ucp.card_id
    WHERE c.deck_id = :'dup_deck_id'::uuid
      AND ucp.user_id = :'tester_id'::uuid
      AND ucp.card_status = 'NEW'
      AND ucp.seen_count = 0
      AND ucp.correct_streak = 0
      AND ucp.wrong_streak = 0),
  100,
  'exactly 100 fresh NEW user_card_progress rows are created'
);

-- selected_deck_id is set correctly
SELECT is(
  (SELECT selected_deck_id FROM public.profiles WHERE id = :'tester_id'::uuid),
  :'dup_deck_id'::uuid,
  'profiles.selected_deck_id is set to the newly duplicated deck'
);

-- onboarding_completed is true
SELECT is(
  (SELECT onboarding_completed FROM public.profiles WHERE id = :'tester_id'::uuid),
  true,
  'onboarding_completed is set to true'
);

-- rerunning duplicate_starter_deck() is idempotent
SELECT tests.authenticate_as(:'tester_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS dup_deck_id_2 \gset
SELECT tests.clear_auth();

SELECT is(
  :'dup_deck_id_2'::uuid,
  :'dup_deck_id'::uuid,
  're-running duplicate_starter_deck() returns the SAME deck id (idempotent)'
);

SELECT is(
  (SELECT count(*)::int FROM public.decks WHERE owner_user_id = :'tester_id'::uuid),
  1,
  're-running duplicate_starter_deck() does not create a second deck'
);

SELECT is(
  (SELECT count(*)::int FROM public.cards WHERE deck_id = :'dup_deck_id'::uuid),
  100,
  're-running duplicate_starter_deck() does not create duplicate cards'
);

-- admin cannot use duplicate_starter_deck() to persist learner content
SELECT tests.authenticate_as(:'admin_id'::uuid);
SELECT tests.throws_sqlstate(
  format('select public.duplicate_starter_deck(%L)', :'official_deck_id'),
  '28000',
  'admin is rejected by duplicate_starter_deck() (not an active tester account)'
);
SELECT tests.clear_auth();

-- Concurrency: two simultaneous duplicate_starter_deck() calls for the same
-- tester cannot be represented inside a single pgTAP file, which runs as
-- one connection/one transaction (BEGIN..ROLLBACK). The function's
-- documented concurrency guarantee (20260923190000_duplicate_and_session_
-- functions.sql: `select ... for update` on the caller's profile row
-- serializes concurrent callers) requires a genuine multi-connection
-- harness -- e.g. two `psql` processes racing against the same local
-- database -- which is out of scope for pgTAP and belongs in a follow-up
-- shell-script-based concurrency test once a real instance is available.
SELECT skip(1, 'true concurrent duplicate_starter_deck() calls require a multi-connection harness, not representable in a single pgTAP transaction');

SELECT * FROM finish();
ROLLBACK;
