\ir fixtures/000_test_helpers.sql

-- Group 12: Soft delete.
-- Maps to DATABASE_SCHEMA.md §17 / §2.5 / §7.2:
--   "Card/Deck soft deletion preserves historical references"
--   "authenticated has no DELETE grant on decks/cards -- soft delete
--   (deleted_at) is the only tester-initiated removal path"

BEGIN;
SELECT plan(7);

SELECT gen_random_uuid() AS tester_x_id \gset
SELECT gen_random_uuid() AS tester_z_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS deck_i_id \gset

SELECT tests.create_test_profile(:'tester_x_id'::uuid, 'test_g12_tester_x');
SELECT tests.create_test_profile(:'tester_z_id'::uuid, 'test_g12_tester_z');

-- -----------------------------------------------------------------------
-- No hard DELETE path exists for authenticated testers on decks/cards
-- -----------------------------------------------------------------------
SELECT tests.authenticate_as(:'tester_x_id'::uuid);
SELECT throws_ok('delete from public.decks', '42501', 'authenticated has no DELETE grant on decks');
SELECT throws_ok('delete from public.cards', '42501', 'authenticated has no DELETE grant on cards');

-- Soft delete (deleted_at) IS the sanctioned tester-initiated path
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS deck_x \gset
SELECT lives_ok(
  format('update public.decks set deleted_at = now() where id = %L', :'deck_x'),
  'authenticated CAN soft-delete their own deck (deleted_at)'
);
SELECT tests.clear_auth();

SELECT ok(
  (SELECT deleted_at FROM public.decks WHERE id = :'deck_x'::uuid) IS NOT NULL,
  'the soft-deleted deck now has a non-NULL deleted_at'
);

-- -----------------------------------------------------------------------
-- A soft-deleted card is excluded from the fixed review queue at session
-- creation, even though its user_card_progress row is LEARNED and due
-- -----------------------------------------------------------------------
SELECT tests.authenticate_as(:'tester_z_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS deck_z \gset
SELECT tests.clear_auth();

SELECT id AS due_card FROM public.cards WHERE deck_id = :'deck_z'::uuid ORDER BY sort_order LIMIT 1 \gset
UPDATE public.user_card_progress SET card_status = 'LEARNED', fsrs_due_at = now() - interval '1 day'
 WHERE user_id = :'tester_z_id'::uuid AND card_id = :'due_card'::uuid;
UPDATE public.cards SET deleted_at = now() WHERE id = :'due_card'::uuid;

SELECT tests.authenticate_as(:'tester_z_id'::uuid);
SELECT (public.start_or_resume_session()).id AS session_z \gset
SELECT tests.clear_auth();

SELECT is(
  (SELECT count(*)::int FROM public.session_review_cards WHERE session_id = :'session_z'::uuid AND card_id = :'due_card'::uuid),
  0, 'a soft-deleted LEARNED-and-due card is excluded from the fixed review queue'
);
SELECT is(
  (SELECT current_mode FROM public.sessions WHERE id = :'session_z'::uuid),
  'learning', 'with its only due card excluded, the session starts in learning mode instead of review'
);

-- -----------------------------------------------------------------------
-- A soft-deleted official card is excluded from duplicate_starter_deck()
-- -----------------------------------------------------------------------
UPDATE public.cards c SET deleted_at = now()
  FROM public.decks d
 WHERE c.deck_id = d.id AND d.id = :'deck_i_id'::uuid AND d.is_official = true
   AND c.id = (SELECT id FROM public.cards WHERE deck_id = :'deck_i_id'::uuid ORDER BY sort_order LIMIT 1);

SELECT gen_random_uuid() AS tester_w_id \gset
SELECT tests.create_test_profile(:'tester_w_id'::uuid, 'test_g12_tester_w');
SELECT tests.authenticate_as(:'tester_w_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS deck_w \gset
SELECT tests.clear_auth();

SELECT is(
  (SELECT count(*)::int FROM public.cards WHERE deck_id = :'deck_w'::uuid),
  99, 'a soft-deleted official card is not copied by duplicate_starter_deck() (99, not 100)'
);

SELECT * FROM finish();
ROLLBACK;
