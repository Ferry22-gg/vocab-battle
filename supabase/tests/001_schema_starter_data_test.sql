\ir fixtures/000_test_helpers.inc

-- Group 1: Schema / starter data.
-- Maps to DATABASE_SCHEMA.md §17:
--   "starter deck duplication produces: 1 user-owned deck / 100 independent
--   card copies / 100 NEW progress rows" (the template-side precondition
--   for that check), and the official-starter-deck-data migration itself
--   (20260923220000_official_starter_deck_data.sql).
--
-- Runs as the default connecting (table-owning) role throughout -- RLS is
-- irrelevant here, this only asserts what data exists.

BEGIN;
SELECT plan(13);

-- exactly 3 official template decks (the two original TOEFL decks plus
-- Swahili Basics, added by 20261022000000_swahili_basics_starter_deck.sql
-- -- purely additive, never replacing or renaming either original deck)
SELECT is(
  (SELECT count(*)::int FROM public.decks WHERE is_official = true),
  3,
  'exactly 3 official decks exist'
);

-- each is_template = true
SELECT is(
  (SELECT count(*)::int FROM public.decks WHERE is_official = true AND is_template = true),
  3,
  'every official deck has is_template = true'
);

-- each owner_user_id = NULL
SELECT is(
  (SELECT count(*)::int FROM public.decks WHERE is_official = true AND owner_user_id IS NULL),
  3,
  'every official deck has owner_user_id = NULL'
);

-- exactly 100 cards per official TOEFL deck (unchanged by the Swahili addition)
SELECT is(
  (SELECT count(*)::int FROM public.cards c
     JOIN public.decks d ON d.id = c.deck_id
    WHERE d.name = 'Advanced English Vocabulary I' AND d.is_official = true),
  100,
  'Advanced English Vocabulary I has exactly 100 cards'
);

SELECT is(
  (SELECT count(*)::int FROM public.cards c
     JOIN public.decks d ON d.id = c.deck_id
    WHERE d.name = 'Advanced English Vocabulary II' AND d.is_official = true),
  100,
  'Advanced English Vocabulary II has exactly 100 cards'
);

-- exactly 60 cards for the new Swahili Basics deck
SELECT is(
  (SELECT count(*)::int FROM public.cards c
     JOIN public.decks d ON d.id = c.deck_id
    WHERE d.name = 'Swahili Basics' AND d.is_official = true),
  60,
  'Swahili Basics has exactly 60 cards'
);

-- Swahili Basics direction: sw -> en (the two TOEFL decks remain en -> ja, unasserted here, unchanged)
SELECT is(
  (SELECT front_language FROM public.decks WHERE name = 'Swahili Basics' AND is_official = true),
  'sw',
  'Swahili Basics has front_language = sw'
);

SELECT is(
  (SELECT back_language FROM public.decks WHERE name = 'Swahili Basics' AND is_official = true),
  'en',
  'Swahili Basics has back_language = en'
);

-- 260 official cards total (200 original + 60 Swahili)
SELECT is(
  (SELECT count(*)::int FROM public.cards c
     JOIN public.decks d ON d.id = c.deck_id
    WHERE d.is_official = true),
  260,
  '260 official cards total across all three decks'
);

-- official cards have created_by_user_id = NULL
SELECT is(
  (SELECT count(*)::int FROM public.cards c
     JOIN public.decks d ON d.id = c.deck_id
    WHERE d.is_official = true AND c.created_by_user_id IS NOT NULL),
  0,
  'no official card has a non-NULL created_by_user_id'
);

-- official cards have source_card_id = NULL (they are the origin, not a copy)
SELECT is(
  (SELECT count(*)::int FROM public.cards c
     JOIN public.decks d ON d.id = c.deck_id
    WHERE d.is_official = true AND c.source_card_id IS NOT NULL),
  0,
  'no official card has a non-NULL source_card_id'
);

-- no user_card_progress rows exist for template cards
SELECT is(
  (SELECT count(*)::int FROM public.user_card_progress ucp
     JOIN public.cards c ON c.id = ucp.card_id
     JOIN public.decks d ON d.id = c.deck_id
    WHERE d.is_official = true),
  0,
  'no user_card_progress rows exist for official template cards'
);

-- deck names resolve via tests.official_deck_id() (used by every other test file)
SELECT ok(
  tests.official_deck_id('Advanced English Vocabulary I') IS NOT NULL
  AND tests.official_deck_id('Advanced English Vocabulary II') IS NOT NULL
  AND tests.official_deck_id('Swahili Basics') IS NOT NULL,
  'tests.official_deck_id() resolves all three official deck names'
);

SELECT * FROM finish();
ROLLBACK;
