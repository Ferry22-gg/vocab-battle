\ir fixtures/000_test_helpers.inc

-- Group 16: Learning Engine v1, Phase 6A/6B schema
-- (scheduler_position / last_critical_due_position / scheduler_revision).
-- Maps to docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 22.2 and
-- supabase/migrations/20261002000000_learning_engine_v1_scheduler_position.sql.

BEGIN;
SELECT plan(19);

SELECT gen_random_uuid() AS tester_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS deck_i_id \gset
SELECT tests.create_test_profile(:'tester_id'::uuid, 'test_g16_tester');

-- =========================================================================
-- Section A: column shape
-- =========================================================================

SELECT col_type_is('public', 'user_deck_learning_state', 'scheduler_position', 'integer', 'scheduler_position is integer');
SELECT col_type_is('public', 'user_deck_learning_state', 'last_critical_due_position', 'integer', 'last_critical_due_position is integer');
SELECT col_type_is('public', 'user_deck_learning_state', 'scheduler_revision', 'integer', 'scheduler_revision is integer');

SELECT col_default_is('public', 'user_deck_learning_state', 'scheduler_position', '0', 'scheduler_position defaults to 0');
SELECT col_default_is('public', 'user_deck_learning_state', 'scheduler_revision', '0', 'scheduler_revision defaults to 0');

-- =========================================================================
-- Section B: a fresh row (no columns named) gets the documented defaults
-- =========================================================================

INSERT INTO public.user_deck_learning_state (user_id, deck_id) VALUES (:'tester_id'::uuid, :'deck_i_id'::uuid);

SELECT is(
  (SELECT scheduler_position FROM public.user_deck_learning_state WHERE user_id = :'tester_id'::uuid AND deck_id = :'deck_i_id'::uuid),
  0, 'fresh row: scheduler_position defaults to 0'
);
SELECT is(
  (SELECT last_critical_due_position FROM public.user_deck_learning_state WHERE user_id = :'tester_id'::uuid AND deck_id = :'deck_i_id'::uuid),
  NULL, 'fresh row: last_critical_due_position defaults to NULL'
);
SELECT is(
  (SELECT scheduler_revision FROM public.user_deck_learning_state WHERE user_id = :'tester_id'::uuid AND deck_id = :'deck_i_id'::uuid),
  0, 'fresh row: scheduler_revision defaults to 0'
);

-- =========================================================================
-- Section C: CHECK constraints
-- =========================================================================

SELECT tests.throws_sqlstate(
  format('update public.user_deck_learning_state set scheduler_position = -1 where user_id = %L and deck_id = %L', :'tester_id', :'deck_i_id'),
  '23514', 'scheduler_position rejects a negative value'
);
SELECT tests.throws_sqlstate(
  format('update public.user_deck_learning_state set scheduler_revision = -1 where user_id = %L and deck_id = %L', :'tester_id', :'deck_i_id'),
  '23514', 'scheduler_revision rejects a negative value'
);
SELECT tests.throws_sqlstate(
  format('update public.user_deck_learning_state set last_critical_due_position = -1 where user_id = %L and deck_id = %L', :'tester_id', :'deck_i_id'),
  '23514', 'last_critical_due_position rejects a negative value'
);

-- last_critical_due_position must never exceed scheduler_position.
SELECT tests.throws_sqlstate(
  format(
    'update public.user_deck_learning_state set scheduler_position = 10, last_critical_due_position = 11 where user_id = %L and deck_id = %L',
    :'tester_id', :'deck_i_id'
  ),
  '23514', 'last_critical_due_position > scheduler_position is rejected'
);
SELECT lives_ok(
  format(
    'update public.user_deck_learning_state set scheduler_position = 10, last_critical_due_position = 10 where user_id = %L and deck_id = %L',
    :'tester_id', :'deck_i_id'
  ),
  'last_critical_due_position == scheduler_position is accepted (the tightest legal case)'
);
SELECT lives_ok(
  format(
    'update public.user_deck_learning_state set scheduler_position = 20, last_critical_due_position = 10 where user_id = %L and deck_id = %L',
    :'tester_id', :'deck_i_id'
  ),
  'last_critical_due_position < scheduler_position is accepted'
);
SELECT lives_ok(
  format(
    'update public.user_deck_learning_state set last_critical_due_position = NULL where user_id = %L and deck_id = %L',
    :'tester_id', :'deck_i_id'
  ),
  'last_critical_due_position can be cleared back to NULL regardless of scheduler_position'
);

-- =========================================================================
-- Section D: trusted-state grants unaffected by the new columns
-- (user_deck_learning_state has a genuine `id` column, unlike
-- user_learning_preferences, so the generic helper applies directly here)
-- =========================================================================

SELECT tests.authenticate_as(:'tester_id'::uuid);
SELECT tests.assert_no_write_grants('user_deck_learning_state');

SELECT is(
  (SELECT scheduler_position FROM public.user_deck_learning_state WHERE user_id = :'tester_id'::uuid AND deck_id = :'deck_i_id'::uuid),
  20, 'authenticated can still read scheduler_position (SELECT-only grant unaffected)'
);

SELECT tests.clear_auth();

SELECT * FROM finish();
ROLLBACK;
