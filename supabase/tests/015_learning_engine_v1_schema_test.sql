\ir fixtures/000_test_helpers.inc

-- Group 15: Learning Engine v1, Phase 1 (additive schema).
-- Maps to docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 29 and
-- supabase/migrations/20261001000000_learning_engine_v1_additive_schema.sql.
--
-- Covers: new user_card_progress columns exist with the right shape and
-- defaults (A), the new/widened CHECK constraints behave correctly (B),
-- a pre-existing trusted function (duplicate_starter_deck()) still
-- inserts cleanly now that the table has 15 new columns (C), the two new
-- tables exist with trusted-state-table grants/RLS matching every other
-- learning table in this project (D), and the migration's backfill SQL
-- produces the documented result when applied to synthetic
-- "pre-migration-shaped" data -- since a fresh `supabase test db` run has
-- no genuinely pre-existing legacy rows for the real migration's backfill
-- statements to have acted on, this re-runs that exact backfill logic
-- against rows this file constructs itself (E).

BEGIN;
SELECT plan(58);

-- =========================================================================
-- Section A: new user_card_progress columns -- shape
-- =========================================================================

SELECT col_type_is('public', 'user_card_progress', 'learning_stage', 'text', 'learning_stage is text');
SELECT col_type_is('public', 'user_card_progress', 'pool_status', 'text', 'pool_status is text');
SELECT col_type_is('public', 'user_card_progress', 'relearning_phase', 'text', 'relearning_phase is text');
SELECT col_type_is('public', 'user_card_progress', 'has_ever_been_mastered', 'boolean', 'has_ever_been_mastered is boolean');
SELECT col_type_is('public', 'user_card_progress', 'first_presented_at', 'timestamp with time zone', 'first_presented_at is timestamptz');
SELECT col_type_is('public', 'user_card_progress', 'same_day_seen_count', 'integer', 'same_day_seen_count is integer');
SELECT col_type_is('public', 'user_card_progress', 'same_day_wrong_count', 'integer', 'same_day_wrong_count is integer');
SELECT col_type_is('public', 'user_card_progress', 'same_day_progress_date', 'date', 'same_day_progress_date is date');
SELECT col_type_is('public', 'user_card_progress', 'correct_cooldown_until_position', 'integer', 'correct_cooldown_until_position is integer');
SELECT col_type_is('public', 'user_card_progress', 'repair_pending', 'boolean', 'repair_pending is boolean');
SELECT col_type_is('public', 'user_card_progress', 'repair_wrong_position', 'integer', 'repair_wrong_position is integer');
SELECT col_type_is('public', 'user_card_progress', 'repair_target_position', 'integer', 'repair_target_position is integer');
SELECT col_type_is('public', 'user_card_progress', 'repair_hard_cap_position', 'integer', 'repair_hard_cap_position is integer');
SELECT col_type_is('public', 'user_card_progress', 'active_draws_since_eligible', 'integer', 'active_draws_since_eligible is integer');
SELECT col_type_is('public', 'user_card_progress', 'fsrs_review_correct_count', 'integer', 'fsrs_review_correct_count is integer');

SELECT col_default_is('public', 'user_card_progress', 'has_ever_been_mastered', 'false', 'has_ever_been_mastered defaults to false');
SELECT col_default_is('public', 'user_card_progress', 'repair_pending', 'false', 'repair_pending defaults to false');
SELECT col_default_is('public', 'user_card_progress', 'same_day_seen_count', '0', 'same_day_seen_count defaults to 0');
SELECT col_default_is('public', 'user_card_progress', 'fsrs_review_correct_count', '0', 'fsrs_review_correct_count defaults to 0');

-- =========================================================================
-- Section B: CHECK constraint behavior (runs as the privileged connecting
-- role -- no auth needed to exercise a CHECK constraint, and RLS is
-- irrelevant to it)
-- =========================================================================

SELECT gen_random_uuid() AS check_tester_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS deck_i_id \gset
SELECT tests.create_test_profile(:'check_tester_id'::uuid, 'test_g15_check_tester');
SELECT id AS check_card_id FROM public.cards WHERE deck_id = :'deck_i_id'::uuid LIMIT 1 \gset

-- card_status: widened to accept ACQUIRED, still rejects garbage.
SELECT lives_ok(
  format(
    'insert into public.user_card_progress (user_id, card_id, card_status) values (%L, %L, %L)',
    :'check_tester_id', :'check_card_id', 'ACQUIRED'
  ),
  'card_status accepts the new ACQUIRED value'
);
SELECT tests.throws_sqlstate(
  format(
    'update public.user_card_progress set card_status = %L where user_id = %L and card_id = %L',
    'NOT_A_REAL_STATUS', :'check_tester_id', :'check_card_id'
  ),
  '23514', 'card_status still rejects an invalid value'
);

-- learning_stage: valid value accepted, invalid value rejected.
SELECT lives_ok(
  format(
    'update public.user_card_progress set learning_stage = %L where user_id = %L and card_id = %L',
    'LEARNING_2', :'check_tester_id', :'check_card_id'
  ),
  'learning_stage accepts LEARNING_2'
);
SELECT tests.throws_sqlstate(
  format(
    'update public.user_card_progress set learning_stage = %L where user_id = %L and card_id = %L',
    'LEARNING_3', :'check_tester_id', :'check_card_id'
  ),
  '23514', 'learning_stage rejects an invalid value'
);

-- pool_status: valid value accepted, invalid value rejected.
SELECT lives_ok(
  format(
    'update public.user_card_progress set pool_status = %L where user_id = %L and card_id = %L',
    'OUTSIDE', :'check_tester_id', :'check_card_id'
  ),
  'pool_status accepts OUTSIDE'
);
SELECT tests.throws_sqlstate(
  format(
    'update public.user_card_progress set pool_status = %L where user_id = %L and card_id = %L',
    'INACTIVE', :'check_tester_id', :'check_card_id'
  ),
  '23514', 'pool_status rejects an invalid value'
);

-- relearning_phase: valid value accepted, invalid value rejected.
SELECT lives_ok(
  format(
    'update public.user_card_progress set relearning_phase = %L where user_id = %L and card_id = %L',
    'SPACED_CONFIRMATION_PENDING', :'check_tester_id', :'check_card_id'
  ),
  'relearning_phase accepts SPACED_CONFIRMATION_PENDING'
);
SELECT tests.throws_sqlstate(
  format(
    'update public.user_card_progress set relearning_phase = %L where user_id = %L and card_id = %L',
    'REPAIRING', :'check_tester_id', :'check_card_id'
  ),
  '23514', 'relearning_phase rejects an invalid value'
);

-- user_deck_learning_state.desired_retention bounds (0 < x < 1).
SELECT tests.throws_sqlstate(
  format(
    'insert into public.user_deck_learning_state (user_id, deck_id, desired_retention) values (%L, %L, 0)',
    :'check_tester_id', :'deck_i_id'
  ),
  '23514', 'desired_retention rejects 0'
);
SELECT tests.throws_sqlstate(
  format(
    'insert into public.user_deck_learning_state (user_id, deck_id, desired_retention) values (%L, %L, 1)',
    :'check_tester_id', :'deck_i_id'
  ),
  '23514', 'desired_retention rejects 1'
);
SELECT tests.throws_sqlstate(
  format(
    'insert into public.user_deck_learning_state (user_id, deck_id, desired_retention) values (%L, %L, -0.1)',
    :'check_tester_id', :'deck_i_id'
  ),
  '23514', 'desired_retention rejects a negative value'
);
SELECT lives_ok(
  format(
    'insert into public.user_deck_learning_state (user_id, deck_id, desired_retention) values (%L, %L, 0.92)',
    :'check_tester_id', :'deck_i_id'
  ),
  'desired_retention accepts 0.92 (the retention_loss pain_point value)'
);
SELECT tests.throws_sqlstate(
  format(
    'insert into public.user_deck_learning_state (user_id, deck_id) values (%L, %L)',
    :'check_tester_id', :'deck_i_id'
  ),
  '23505', 'unique (user_id, deck_id) rejects a second row for the same pair'
);

-- =========================================================================
-- Section C: a pre-existing trusted function still works unmodified
-- (duplicate_starter_deck()'s explicit-column INSERT never names any of
-- the 15 new columns, so every one must land on its default/NULL)
-- =========================================================================

SELECT gen_random_uuid() AS fresh_tester_id \gset
SELECT tests.create_test_profile(:'fresh_tester_id'::uuid, 'test_g15_fresh_tester');
SELECT tests.authenticate_as(:'fresh_tester_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS fresh_deck_id \gset
SELECT tests.clear_auth();

SELECT id AS fresh_card_id
  FROM public.cards WHERE deck_id = :'fresh_deck_id'::uuid ORDER BY sort_order LIMIT 1 \gset

SELECT is(
  (SELECT learning_stage FROM public.user_card_progress WHERE user_id = :'fresh_tester_id'::uuid AND card_id = :'fresh_card_id'::uuid),
  NULL, 'freshly duplicated card: learning_stage defaults to NULL'
);
SELECT is(
  (SELECT pool_status FROM public.user_card_progress WHERE user_id = :'fresh_tester_id'::uuid AND card_id = :'fresh_card_id'::uuid),
  NULL, 'freshly duplicated card: pool_status defaults to NULL'
);
SELECT is(
  (SELECT has_ever_been_mastered FROM public.user_card_progress WHERE user_id = :'fresh_tester_id'::uuid AND card_id = :'fresh_card_id'::uuid),
  false, 'freshly duplicated card: has_ever_been_mastered defaults to false'
);
SELECT is(
  (SELECT same_day_seen_count FROM public.user_card_progress WHERE user_id = :'fresh_tester_id'::uuid AND card_id = :'fresh_card_id'::uuid),
  0, 'freshly duplicated card: same_day_seen_count defaults to 0'
);
SELECT is(
  (SELECT repair_pending FROM public.user_card_progress WHERE user_id = :'fresh_tester_id'::uuid AND card_id = :'fresh_card_id'::uuid),
  false, 'freshly duplicated card: repair_pending defaults to false'
);
SELECT is(
  (SELECT fsrs_review_correct_count FROM public.user_card_progress WHERE user_id = :'fresh_tester_id'::uuid AND card_id = :'fresh_card_id'::uuid),
  0, 'freshly duplicated card: fsrs_review_correct_count defaults to 0'
);

-- =========================================================================
-- Section D: new tables -- existence + trusted-state grants/RLS
-- =========================================================================

SELECT has_table('public', 'user_learning_preferences', 'user_learning_preferences table exists');
SELECT has_table('public', 'user_deck_learning_state', 'user_deck_learning_state table exists');

SELECT tests.authenticate_as(:'fresh_tester_id'::uuid);

-- tests.assert_no_write_grants() (fixtures/000_test_helpers.inc) assumes
-- every target table has a plain `id` column -- true for
-- user_deck_learning_state (surrogate uuid PK) but NOT for
-- user_learning_preferences, whose primary key is user_id itself (the
-- natural key for a one-row-per-user table; adding a redundant surrogate
-- id column purely to fit this generic helper would be schema cruft with
-- no product reason). Exercised manually here instead, same 3 verbs/3
-- assertions, targeting a column that actually exists.
SELECT tests.throws_sqlstate(
  'insert into public.user_learning_preferences default values',
  '42501', 'authenticated has no INSERT grant on user_learning_preferences'
);
SELECT tests.throws_sqlstate(
  'update public.user_learning_preferences set exam_date = exam_date',
  '42501', 'authenticated has no UPDATE grant on user_learning_preferences'
);
SELECT tests.throws_sqlstate(
  'delete from public.user_learning_preferences',
  '42501', 'authenticated has no DELETE grant on user_learning_preferences'
);

SELECT tests.assert_no_write_grants('user_deck_learning_state');
SELECT tests.clear_auth();

-- =========================================================================
-- Section E: backfill logic correctness, and RLS isolation across it
--
-- Two testers (A, B). A answers one card correctly (via the existing
-- legacy commit_answer_transaction() path, exactly as production does
-- today) and is then forced back into a "pre-migration-shaped" row
-- (card_status = LEARNED, has_ever_been_mastered = false,
-- first_presented_at = NULL) to stand in for a genuinely pre-existing
-- legacy row. B only duplicates a deck and never answers anything.
-- Re-running the migration's own backfill statements against this data
-- must reproduce exactly what the real migration run documents.
-- =========================================================================

SELECT gen_random_uuid() AS tester_a_id \gset
SELECT gen_random_uuid() AS tester_b_id \gset
SELECT gen_random_uuid() AS admin_id \gset

SELECT tests.create_test_profile(:'tester_a_id'::uuid, 'test_g15_tester_a');
SELECT tests.create_test_profile(:'tester_b_id'::uuid, 'test_g15_tester_b');
SELECT tests.create_test_profile(:'admin_id'::uuid, 'test_g15_admin', 'admin', 'active', true);

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS tester_a_deck \gset
SELECT (public.start_or_resume_session()).id AS tester_a_session \gset
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS tester_b_deck \gset
SELECT tests.clear_auth();

SELECT id AS tester_a_card FROM public.cards WHERE deck_id = :'tester_a_deck'::uuid ORDER BY sort_order LIMIT 1 \gset

SELECT tests.authenticate_as_service_role();
SELECT tests.call_commit_answer(gen_random_uuid(), :'tester_a_id'::uuid, :'tester_a_session'::uuid, :'tester_a_card'::uuid, true);
SELECT tests.clear_auth();

-- Force tester A's card back into the pre-migration legacy shape this
-- backfill is meant to repair.
UPDATE public.user_card_progress
SET card_status = 'LEARNED', has_ever_been_mastered = false, first_presented_at = NULL
WHERE user_id = :'tester_a_id'::uuid AND card_id = :'tester_a_card'::uuid;

-- Re-run the migration's own backfill statements verbatim (see
-- 20261001000000_learning_engine_v1_additive_schema.sql's "Compatibility
-- / backfill" section) against this synthetic legacy-shaped data.
UPDATE public.user_card_progress
SET has_ever_been_mastered = true
WHERE card_status = 'LEARNED' AND has_ever_been_mastered = false;

UPDATE public.user_card_progress ucp
SET first_presented_at = history.first_answered_at
FROM (
  SELECT user_id, card_id, min(answered_at) AS first_answered_at
  FROM public.answer_events
  GROUP BY user_id, card_id
) history
WHERE history.user_id = ucp.user_id
  AND history.card_id = ucp.card_id
  AND ucp.first_presented_at IS NULL;

INSERT INTO public.user_deck_learning_state (
  user_id, deck_id, has_achieved_full_mastery, mastered_count, desired_retention, policy_version
)
SELECT
  ucp.user_id,
  c.deck_id,
  count(*) FILTER (WHERE ucp.card_status = 'LEARNED') = count(*) AS has_achieved_full_mastery,
  count(*) FILTER (WHERE ucp.card_status = 'LEARNED')::integer AS mastered_count,
  0.90,
  'learning-engine-v1.0'
FROM public.user_card_progress ucp
JOIN public.cards c ON c.id = ucp.card_id
WHERE c.deleted_at IS NULL
  AND ucp.user_id IN (:'tester_a_id'::uuid, :'tester_b_id'::uuid)
GROUP BY ucp.user_id, c.deck_id
ON CONFLICT (user_id, deck_id) DO NOTHING;

-- Preference rows (no backfill source exists for these -- inserted
-- directly here to exercise RLS isolation on user_learning_preferences).
INSERT INTO public.user_learning_preferences (user_id, pain_point)
VALUES (:'tester_a_id'::uuid, 'retention_loss'), (:'tester_b_id'::uuid, NULL);

-- --- backfill correctness: tester A (the simulated legacy LEARNED card) ---
SELECT is(
  (SELECT has_ever_been_mastered FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'tester_a_card'::uuid),
  true, 'backfill: LEARNED card gets has_ever_been_mastered = true'
);
SELECT is(
  (SELECT first_presented_at FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'tester_a_card'::uuid)
    = (SELECT min(answered_at) FROM public.answer_events WHERE user_id = :'tester_a_id'::uuid AND card_id = :'tester_a_card'::uuid),
  true, 'backfill: first_presented_at is derived from the earliest answer_events row'
);
SELECT is(
  (SELECT mastered_count FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'tester_a_deck'::uuid),
  1, 'backfill: tester A''s mastered_count is 1'
);
SELECT is(
  (SELECT has_achieved_full_mastery FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'tester_a_deck'::uuid),
  false, 'backfill: tester A''s deck (1/100 mastered) is not Full Mastery'
);

-- --- backfill correctness: tester B (no answers at all) ---
SELECT is(
  (SELECT mastered_count FROM public.user_deck_learning_state WHERE user_id = :'tester_b_id'::uuid AND deck_id = :'tester_b_deck'::uuid),
  0, 'backfill: tester B (never answered) gets mastered_count = 0'
);
SELECT is(
  (SELECT has_achieved_full_mastery FROM public.user_deck_learning_state WHERE user_id = :'tester_b_id'::uuid AND deck_id = :'tester_b_deck'::uuid),
  false, 'backfill: tester B''s deck is not Full Mastery'
);

-- --- RLS isolation on the two new tables ---
SELECT tests.authenticate_as(:'tester_a_id'::uuid);

SELECT is(
  (SELECT count(*)::int FROM public.user_learning_preferences WHERE user_id = :'tester_a_id'::uuid),
  1, 'tester A can read their own user_learning_preferences row'
);
SELECT is(
  (SELECT count(*)::int FROM public.user_learning_preferences WHERE user_id = :'tester_b_id'::uuid),
  0, 'tester A cannot read tester B''s user_learning_preferences row'
);
SELECT is(
  (SELECT count(*)::int FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid),
  1, 'tester A can read their own user_deck_learning_state row'
);
SELECT is(
  (SELECT count(*)::int FROM public.user_deck_learning_state WHERE user_id = :'tester_b_id'::uuid),
  0, 'tester A cannot read tester B''s user_deck_learning_state row'
);

SELECT tests.clear_auth();
SELECT tests.authenticate_as(:'admin_id'::uuid);

SELECT is(
  (SELECT count(*)::int FROM public.user_learning_preferences WHERE user_id IN (:'tester_a_id'::uuid, :'tester_b_id'::uuid)),
  2, 'admin can read both testers'' user_learning_preferences rows'
);
SELECT is(
  (SELECT count(*)::int FROM public.user_deck_learning_state WHERE user_id IN (:'tester_a_id'::uuid, :'tester_b_id'::uuid)),
  2, 'admin can read both testers'' user_deck_learning_state rows'
);

SELECT tests.clear_auth();

SELECT * FROM finish();
ROLLBACK;
