\ir fixtures/000_test_helpers.inc

-- Group 20: Learning Engine v1, Runtime Cutover RC-C (the Answer Commit
-- Transaction).
-- Maps to supabase/migrations/
-- 20261013000000_learning_engine_v1_runtime_cutover_rc_c_answer_commit.sql.
--
-- Covers: get_learning_engine_v1_answer_context()'s session/claim
-- validation, commit_learning_engine_v1_answer()'s full validation/
-- concurrency/idempotency/mutation contract, and the legacy/v1 answer-
-- path isolation guard added to commit_answer_transaction().
--
-- Deliberately NOT covered here (RC-C scope boundary, already exhaustive
-- at their own layer): the Learning Engine lifecycle/FSRS/repair
-- transition matrix itself (tests/unit/learning-engine-runtime-prepare-answer.test.ts),
-- and any live wiring (nothing here touches app/session/* or
-- get_next_session_card()).

BEGIN;
SELECT plan(73);

-- =========================================================================
-- Fixtures.
--   tester_a / deck_a / session_a (v1)      -- the full successful-commit flow
--   tester_b / deck_b / session_b (legacy)  -- legacy guard / cross-engine rejection
--   tester_c / deck_c / session_c (v1)      -- negative-path validation
-- =========================================================================

SELECT gen_random_uuid() AS tester_a_id \gset
SELECT gen_random_uuid() AS tester_b_id \gset
SELECT gen_random_uuid() AS tester_c_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS official_deck_id \gset

SELECT tests.create_test_profile(:'tester_a_id'::uuid, 'test_g20_tester_a');
SELECT tests.create_test_profile(:'tester_b_id'::uuid, 'test_g20_tester_b');
SELECT tests.create_test_profile(:'tester_c_id'::uuid, 'test_g20_tester_c');

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_a \gset
SELECT (public.start_or_resume_session()).id AS session_a \gset
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_b \gset
SELECT (public.start_or_resume_session()).id AS session_b \gset
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_c_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_c \gset
SELECT (public.start_or_resume_session()).id AS session_c \gset
SELECT tests.clear_auth();

-- session_a/session_c become v1; session_b stays legacy.
UPDATE public.sessions SET engine_version = 'v1' WHERE id IN (:'session_a'::uuid, :'session_c'::uuid);

-- RC-C rollout-invariant corrective (20261014000000): tester_a/tester_c
-- are enrolled in the rollout up front, same as real v1 testers would be,
-- so every OTHER validation layer below (stale position, card-before,
-- ownership, grants) can still be exercised on its own -- the dedicated
-- "no rollout row" rejection itself gets its own isolated tester_d below,
-- never conflated with these.
INSERT INTO public.learning_engine_v1_rollout (user_id) VALUES (:'tester_a_id'::uuid), (:'tester_c_id'::uuid);

SELECT id AS card_a1 FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
SELECT id AS card_a2 FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 1 \gset
SELECT id AS card_b1 FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
SELECT id AS card_c1 FROM public.cards WHERE deck_id = :'deck_c'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset

SELECT tests.authenticate_as_service_role();

-- Local test-only helpers (pg_temp -- dropped automatically on ROLLBACK).
CREATE FUNCTION pg_temp.claim(
  p_user_id uuid,
  p_session_id uuid,
  p_deck_id uuid,
  p_expected_position integer,
  p_expected_revision integer,
  p_card_id uuid
) RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT public.claim_next_learning_engine_card(
    p_user_id, p_session_id, p_deck_id,
    p_expected_position, p_expected_revision,
    p_card_id, 'ACTIVE', 'active_weighted_selection',
    '{}', NULL, NULL, NULL, NULL,
    gen_random_uuid(), now(), 'pre_goal_balanced',
    0, false, 1, 0, 0, 0,
    0, 0, 0, 0,
    1, 0, 0, 0,
    1.0, NULL, NULL,
    false, '{}'::double precision[],
    'learning-engine-v1.0', '{}'::jsonb,
    NULL
  );
$$;

-- Snapshots a LIVE user_card_progress row into the exact jsonb shape
-- commit_learning_engine_v1_answer()'s p_expected_card_before/p_card_after
-- expect (camelCase, matching lib/learning-engine/state.ts's
-- LearningEngineCardState + the ActivePoolCardState/FSRS fields this
-- function validates).
CREATE FUNCTION pg_temp.card_json(p_user_id uuid, p_card_id uuid) RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT jsonb_build_object(
    'cardStatus', ucp.card_status,
    'learningStage', ucp.learning_stage,
    'poolStatus', ucp.pool_status,
    'relearningPhase', ucp.relearning_phase,
    'hasEverBeenMastered', ucp.has_ever_been_mastered,
    'repairPending', ucp.repair_pending,
    'fsrsReviewCorrectCount', ucp.fsrs_review_correct_count,
    'fsrsReviewCorrectStreak', ucp.fsrs_review_correct_streak,
    'correctCooldownUntilPosition', ucp.correct_cooldown_until_position,
    'repairWrongPosition', ucp.repair_wrong_position,
    'repairTargetPosition', ucp.repair_target_position,
    'repairHardCapPosition', ucp.repair_hard_cap_position,
    'fsrsDueAt', ucp.fsrs_due_at,
    'fsrsStability', ucp.fsrs_stability,
    'fsrsDifficulty', ucp.fsrs_difficulty,
    'fsrsElapsedDays', ucp.fsrs_elapsed_days,
    'fsrsScheduledDays', ucp.fsrs_scheduled_days,
    'fsrsReps', ucp.fsrs_reps,
    'fsrsLapses', ucp.fsrs_lapses,
    'fsrsLearningSteps', ucp.fsrs_learning_steps,
    'fsrsState', ucp.fsrs_state,
    'fsrsLastReviewAt', ucp.fsrs_last_review_at
  )
  FROM public.user_card_progress ucp
  WHERE ucp.user_id = p_user_id AND ucp.card_id = p_card_id;
$$;

-- A minimal, valid review-event telemetry bundle.
CREATE FUNCTION pg_temp.review_event_json() RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'timeToFirstActionMs', null,
    'cardsSinceLastSeen', null,
    'secondsSinceLastSeen', null,
    'isRepairRetry', false,
    'isStageAdvancingSuccess', true,
    'fsrsDBefore', null, 'fsrsSBefore', null, 'fsrsRBefore', null,
    'fsrsDAfter', null, 'fsrsSAfter', null, 'fsrsRAfter', null,
    'scheduledIntervalSec', null, 'intervalProgress', null, 'daysOverdue', null,
    'sourceWeightActive', null, 'sourceWeightDue', null, 'sourceWeightNear', null, 'sourceWeightRandomMastered', null,
    'sourceWeightActiveRaw', null, 'sourceWeightDueRaw', null, 'sourceWeightNearRaw', null, 'sourceWeightRandomMasteredRaw', null,
    'candidateCount', 1,
    'policyVersion', 'learning-engine-v1.0', 'fsrsVersion', 'ts-fsrs@5.4.2',
    'parameterSetId', null, 'experimentAssignmentId', null
  );
$$;

-- A thin wrapper around commit_learning_engine_v1_answer() so each
-- scenario only has to name the arguments it actually varies. Correct
-- answers use a trivial, always-valid Battle shape (damage=1, no
-- critical, no defeat); Wrong answers use the zero-damage shape
-- commit_answer_transaction() itself requires.
CREATE FUNCTION pg_temp.answer(
  p_user_id uuid,
  p_session_id uuid,
  p_claim_id uuid,
  p_card_id uuid,
  p_expected_position integer,
  p_expected_card_before jsonb,
  p_card_after jsonb,
  p_correct boolean,
  p_repair_obligation_after jsonb DEFAULT NULL,
  p_client_event_id uuid DEFAULT gen_random_uuid()
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
declare
  v_session public.sessions;
  v_combo_after integer;
  v_enemy_hp_after integer;
  v_enemy_defeated boolean;
begin
  select * into v_session from public.sessions where id = p_session_id;
  v_combo_after := case when p_correct then least(v_session.current_combo + 1, 10) else 0 end;
  v_enemy_hp_after := case when p_correct then greatest(0, v_session.current_enemy_hp - 1) else v_session.current_enemy_hp end;
  v_enemy_defeated := (v_enemy_hp_after = 0);

  return public.commit_learning_engine_v1_answer(
    p_client_event_id, p_user_id, p_session_id, p_claim_id, p_card_id,
    p_expected_position, p_expected_card_before, v_session.current_combo, v_session.current_enemy_hp,
    p_card_after, p_repair_obligation_after,
    p_correct, 1000,
    case when p_correct then 1 else 0 end, 0, false, v_combo_after,
    case when p_correct then 1 else 0 end, v_enemy_hp_after, v_enemy_defeated,
    case when v_enemy_defeated then 'enemy_a' else NULL end,
    case when v_enemy_defeated then 90 else NULL end,
    case when v_enemy_defeated then 90 else NULL end,
    pg_temp.review_event_json()
  );
end;
$$;

-- =========================================================================
-- Section A: get_learning_engine_v1_answer_context()
-- =========================================================================

SELECT tests.throws_sqlstate(
  format('select public.get_learning_engine_v1_answer_context(%L, gen_random_uuid(), gen_random_uuid())', :'tester_a_id'),
  '22023', 'A1: a non-existent session is rejected'
);
SELECT tests.throws_sqlstate(
  format('select public.get_learning_engine_v1_answer_context(%L, %L, gen_random_uuid())', :'tester_b_id', :'session_a'),
  '42501', 'A2: cross-user read is rejected'
);
SELECT tests.throws_sqlstate(
  format('select public.get_learning_engine_v1_answer_context(%L, %L, gen_random_uuid())', :'tester_b_id', :'session_b'),
  '42501', 'A3: a legacy-engine session is rejected'
);
SELECT tests.throws_sqlstate(
  format('select public.get_learning_engine_v1_answer_context(%L, %L, gen_random_uuid())', :'tester_a_id', :'session_a'),
  '42501', 'A4: a non-existent claim_id is rejected'
);

-- Lazily initialize deck_a/deck_c's user_deck_learning_state rows.
SELECT public.get_learning_engine_v1_scheduler_snapshot(:'tester_a_id'::uuid, :'session_a'::uuid);
SELECT public.get_learning_engine_v1_scheduler_snapshot(:'tester_c_id'::uuid, :'session_c'::uuid);

-- card_a1 starts FRESH (LEARNING/FRESH), non-repair-pending.
UPDATE public.user_card_progress SET card_status = 'LEARNING', learning_stage = 'FRESH', pool_status = 'ACTIVE'
WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a1'::uuid;

SELECT pg_temp.claim(:'tester_a_id', :'session_a', :'deck_a', 0, 0, :'card_a1') AS claim_result_a \gset
SELECT (:'claim_result_a'::jsonb -> 'claim' ->> 'id')::uuid AS claim_a1 \gset

SELECT public.get_learning_engine_v1_answer_context(:'tester_a_id'::uuid, :'session_a'::uuid, :'claim_a1'::uuid) AS context_a \gset
SELECT is((:'context_a'::jsonb -> 'claim' ->> 'cardId')::uuid, :'card_a1'::uuid, 'A5: the answer context reflects the given claim''s own card');
SELECT is((:'context_a'::jsonb -> 'card' ->> 'cardStatus'), 'LEARNING', 'A6: the answer context reflects the claimed card''s live state');
SELECT is((:'context_a'::jsonb -> 'trace' ->> 'selectionReason'), 'active_weighted_selection', 'A7: the answer context carries the linked SelectionTrace''s selectionReason');
SELECT tests.clear_auth();
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT tests.throws_sqlstate(
  format('select public.get_learning_engine_v1_answer_context(%L, %L, %L)', :'tester_a_id', :'session_a', :'claim_a1'),
  '42501', 'A8: authenticated has no EXECUTE grant on the answer-context function at all'
);
SELECT tests.clear_auth();
SELECT tests.authenticate_as_service_role();

-- =========================================================================
-- Section A2 (RC-C corrective, 20261014000000): the rollout invariant.
-- A dedicated tester_d, deliberately WITHOUT a learning_engine_v1_rollout
-- row, to prove a fresh v1 answer commit is rejected atomically rather
-- than silently no-op-ing.
-- =========================================================================

SELECT tests.clear_auth();
SELECT gen_random_uuid() AS tester_d_id \gset
SELECT tests.create_test_profile(:'tester_d_id'::uuid, 'test_g20_tester_d');
SELECT tests.authenticate_as(:'tester_d_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_d \gset
SELECT (public.start_or_resume_session()).id AS session_d \gset
SELECT tests.clear_auth();
UPDATE public.sessions SET engine_version = 'v1' WHERE id = :'session_d'::uuid;

SELECT id AS card_d1 FROM public.cards WHERE deck_id = :'deck_d'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
SELECT id AS card_d2 FROM public.cards WHERE deck_id = :'deck_d'::uuid ORDER BY sort_order LIMIT 1 OFFSET 1 \gset

SELECT tests.authenticate_as_service_role();
SELECT public.get_learning_engine_v1_scheduler_snapshot(:'tester_d_id'::uuid, :'session_d'::uuid);

UPDATE public.user_card_progress SET card_status = 'LEARNING', learning_stage = 'FRESH', pool_status = 'ACTIVE'
WHERE user_id = :'tester_d_id'::uuid AND card_id = :'card_d1'::uuid;

SELECT is(
  (SELECT count(*)::integer FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_d_id'::uuid),
  0, 'A2-0: sanity -- tester_d has no rollout row yet'
);

SELECT pg_temp.claim(:'tester_d_id', :'session_d', :'deck_d', 0, 0, :'card_d1') AS claim_result_d \gset
SELECT (:'claim_result_d'::jsonb -> 'claim' ->> 'id')::uuid AS claim_d1 \gset
SELECT pg_temp.card_json(:'tester_d_id'::uuid, :'card_d1'::uuid) AS card_d1_before \gset
SELECT jsonb_set(jsonb_set(:'card_d1_before'::jsonb, '{learningStage}', '"LEARNING_1"'), '{fsrsTouched}', 'false') AS card_d1_after \gset

-- A2-1: the fresh commit is rejected atomically -- no rollout row exists.
SELECT tests.throws_sqlstate(
  format(
    $sql$select pg_temp.answer(%L, %L, %L, %L, 0, %L::jsonb, %L::jsonb, true, NULL, gen_random_uuid())$sql$,
    :'tester_d_id', :'session_d', :'claim_d1', :'card_d1', :'card_d1_before', :'card_d1_after'
  ),
  '42501', 'A2-1: a v1 Session with no learning_engine_v1_rollout row rejects the fresh answer atomically'
);

-- A2-2..A2-8: the rejection left EVERYTHING unchanged.
SELECT is((SELECT status FROM public.selection_claims WHERE id = :'claim_d1'::uuid), 'OPEN', 'A2-2: the claim is still OPEN');
SELECT is(
  (SELECT scheduler_position FROM public.user_deck_learning_state WHERE user_id = :'tester_d_id'::uuid AND deck_id = :'deck_d'::uuid),
  0, 'A2-3: scheduler_position is unchanged'
);
SELECT is(
  (SELECT scheduler_revision FROM public.user_deck_learning_state WHERE user_id = :'tester_d_id'::uuid AND deck_id = :'deck_d'::uuid),
  (SELECT scheduler_revision FROM public.selection_claims WHERE id = :'claim_d1'::uuid),
  'A2-4: scheduler_revision is unchanged'
);
SELECT is(
  (SELECT learning_stage FROM public.user_card_progress WHERE user_id = :'tester_d_id'::uuid AND card_id = :'card_d1'::uuid),
  'FRESH', 'A2-5: card state is unchanged'
);
SELECT is(
  (SELECT count(*)::integer FROM public.answer_events WHERE card_id = :'card_d1'::uuid),
  0, 'A2-6: no answer_events row was inserted'
);
SELECT is(
  (SELECT count(*)::integer FROM public.xp_events WHERE user_id = :'tester_d_id'::uuid),
  0, 'A2-7: no xp_events row was inserted'
);
SELECT is(
  (SELECT total_answers FROM public.sessions WHERE id = :'session_d'::uuid),
  0, 'A2-8: session.total_answers (Battle/Session state) is unchanged'
);

-- A2-9/10: once enrolled, the SAME still-OPEN claim now succeeds, and
-- first_v1_answer_at transitions NULL -> non-null exactly once.
INSERT INTO public.learning_engine_v1_rollout (user_id) VALUES (:'tester_d_id'::uuid);

SELECT pg_temp.answer(
  :'tester_d_id', :'session_d', :'claim_d1', :'card_d1', 0, :'card_d1_before', :'card_d1_after', true,
  NULL, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
) AS first_answer_result_d \gset
SELECT is((:'first_answer_result_d'::jsonb ->> 'is_replay')::boolean, false, 'A2-9: once enrolled, the fresh answer succeeds');
SELECT is(
  (SELECT first_v1_answer_at IS NOT NULL FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_d_id'::uuid),
  true, 'A2-10: first_v1_answer_at transitions to non-null on the first successful v1 answer'
);
SELECT (SELECT first_v1_answer_at FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_d_id'::uuid) AS first_v1_answer_at_d \gset

-- A2-11/12: a SECOND fresh v1 answer succeeds and leaves first_v1_answer_at untouched.
SELECT pg_temp.claim(:'tester_d_id', :'session_d', :'deck_d', 1, 2, :'card_d2') AS claim_result_d2 \gset
SELECT (:'claim_result_d2'::jsonb -> 'claim' ->> 'id')::uuid AS claim_d2 \gset
SELECT pg_temp.card_json(:'tester_d_id'::uuid, :'card_d2'::uuid) AS card_d2_before \gset
SELECT jsonb_set(jsonb_set(:'card_d2_before'::jsonb, '{learningStage}', '"LEARNING_1"'), '{fsrsTouched}', 'false') AS card_d2_after \gset

SELECT pg_temp.answer(:'tester_d_id', :'session_d', :'claim_d2', :'card_d2', 1, :'card_d2_before', :'card_d2_after', true) AS second_answer_result_d \gset
SELECT is((:'second_answer_result_d'::jsonb ->> 'is_replay')::boolean, false, 'A2-11: a second fresh v1 answer succeeds');
SELECT is(
  (SELECT first_v1_answer_at FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_d_id'::uuid),
  :'first_v1_answer_at_d'::timestamptz, 'A2-12: first_v1_answer_at is NOT overwritten by a later answer'
);

-- A2-13/14: replaying the FIRST answer's client_event_id does not touch
-- first_v1_answer_at either.
SELECT pg_temp.answer(
  :'tester_d_id', :'session_d', :'claim_d1', :'card_d1', 0, :'card_d1_before', :'card_d1_after', true,
  NULL, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
) AS replay_result_d \gset
SELECT is((:'replay_result_d'::jsonb ->> 'is_replay')::boolean, true, 'A2-13: replaying the first client_event_id reports is_replay=true');
SELECT is(
  (SELECT first_v1_answer_at FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_d_id'::uuid),
  :'first_v1_answer_at_d'::timestamptz, 'A2-14: the replay does not modify first_v1_answer_at'
);

-- A2-15: the rollout-invariant corrective touches ONLY
-- commit_learning_engine_v1_answer() -- the legacy function's own
-- (unrelated) stale-snapshot validation still runs exactly as before,
-- regardless of tester_b having no rollout row at all (irrelevant to the
-- legacy path).
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.commit_answer_transaction(
      gen_random_uuid(), %L, %L, %L,
      'NEW', 999, 999, 999, NULL, NULL, 999, 999,
      true, 1000, 'learning',
      'Good', now(), 1.0, 1.0, 0, 1, 1, 0, 0, 0, now(),
      1, 0, false, 1, 1, 100, false
    )$sql$,
    :'tester_b_id', :'session_b', :'card_b1'
  ),
  '40001', 'A2-15: legacy commit_answer_transaction() validation is unaffected by the rollout-invariant corrective'
);

-- =========================================================================
-- Section B: commit_learning_engine_v1_answer() -- negative-path validation.
-- =========================================================================

UPDATE public.user_card_progress SET card_status = 'LEARNING', learning_stage = 'FRESH', pool_status = 'ACTIVE'
WHERE user_id = :'tester_c_id'::uuid AND card_id = :'card_c1'::uuid;
SELECT pg_temp.claim(:'tester_c_id', :'session_c', :'deck_c', 0, 0, :'card_c1') AS claim_result_c \gset
SELECT (:'claim_result_c'::jsonb -> 'claim' ->> 'id')::uuid AS claim_c1 \gset
SELECT pg_temp.card_json(:'tester_c_id'::uuid, :'card_c1'::uuid) AS card_c1_before \gset

SELECT tests.throws_sqlstate(
  format(
    $sql$select pg_temp.answer(%L, %L, %L, %L, 0, %L::jsonb, %L::jsonb, true)$sql$,
    :'tester_b_id', :'session_c', :'claim_c1', :'card_c1', :'card_c1_before', :'card_c1_before'
  ),
  '42501', 'B1: a claim/session belonging to a different user is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$select pg_temp.answer(%L, %L, %L, %L, 0, %L::jsonb, %L::jsonb, true)$sql$,
    :'tester_c_id', :'session_a', :'claim_c1', :'card_c1', :'card_c1_before', :'card_c1_before'
  ),
  '42501', 'B2: a claim belonging to a different session is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$select pg_temp.answer(%L, %L, gen_random_uuid(), %L, 0, %L::jsonb, %L::jsonb, true)$sql$,
    :'tester_c_id', :'session_c', :'card_c1', :'card_c1_before', :'card_c1_before'
  ),
  '42501', 'B3: a non-existent claim is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$select pg_temp.answer(%L, %L, %L, %L, 0, %L::jsonb, %L::jsonb, true)$sql$,
    :'tester_c_id', :'session_c', :'claim_c1', :'card_a1', :'card_c1_before', :'card_c1_before'
  ),
  '42501', 'B4: p_card_id not matching the claim''s own card is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$select pg_temp.answer(%L, %L, %L, %L, 999, %L::jsonb, %L::jsonb, true)$sql$,
    :'tester_c_id', :'session_c', :'claim_c1', :'card_c1', :'card_c1_before', :'card_c1_before'
  ),
  '40001', 'B5: a stale expected scheduler_position is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$select pg_temp.answer(%L, %L, %L, %L, 0, %L::jsonb, %L::jsonb, true)$sql$,
    :'tester_c_id', :'session_c', :'claim_c1', :'card_c1',
    jsonb_set(:'card_c1_before'::jsonb, '{fsrsReviewCorrectCount}', '999'), :'card_c1_before'
  ),
  '40001', 'B6: a tampered/stale card-before snapshot is rejected'
);

-- B7: a soft-deleted claimed card is rejected.
SELECT tests.clear_auth();
SELECT tests.authenticate_as(:'tester_c_id'::uuid);
UPDATE public.cards SET deleted_at = now() WHERE id = :'card_c1'::uuid;
SELECT tests.clear_auth();
SELECT tests.authenticate_as_service_role();
SELECT tests.throws_sqlstate(
  format(
    $sql$select pg_temp.answer(%L, %L, %L, %L, 0, %L::jsonb, %L::jsonb, true)$sql$,
    :'tester_c_id', :'session_c', :'claim_c1', :'card_c1', :'card_c1_before', :'card_c1_before'
  ),
  '42501', 'B7: a soft-deleted claimed card is rejected'
);
SELECT tests.clear_auth();
SELECT tests.authenticate_as(:'tester_c_id'::uuid);
UPDATE public.cards SET deleted_at = NULL WHERE id = :'card_c1'::uuid;
SELECT tests.clear_auth();
SELECT tests.authenticate_as_service_role();

-- B8: authenticated (even the claim's own owner) has no EXECUTE grant on
-- the answer-commit function at all -- RC-C pre-check A's "unrelated safe
-- deck mutation while the claim was open must not reject the answer"
-- scenario (the soft-delete/restore above bumped deck_c's
-- scheduler_revision via RC-B's own triggers, but this answer still only
-- validates scheduler_POSITION + the claimed card's own before-state) is
-- exercised positively in Section C below against deck_a instead, to keep
-- this grant probe isolated from any other mutation.
SELECT tests.clear_auth();
SELECT tests.authenticate_as(:'tester_c_id'::uuid);
SELECT tests.throws_sqlstate(
  format(
    $sql$select pg_temp.answer(%L, %L, %L, %L, 0, %L::jsonb, %L::jsonb, true)$sql$,
    :'tester_c_id', :'session_c', :'claim_c1', :'card_c1', :'card_c1_before', :'card_c1_before'
  ),
  '42501', 'B8: authenticated has no EXECUTE grant on the answer-commit function at all'
);
SELECT tests.clear_auth();
SELECT tests.authenticate_as_service_role();

-- =========================================================================
-- Section C: the full successful-commit flow (tester_a/session_a/claim_a1,
-- deck_a is still at a known pristine revision -- no mutation occurred
-- against it in Sections A/B).
-- =========================================================================

SELECT pg_temp.card_json(:'tester_a_id'::uuid, :'card_a1'::uuid) AS card_a1_before \gset
SELECT jsonb_set(jsonb_set(:'card_a1_before'::jsonb, '{learningStage}', '"LEARNING_1"'), '{fsrsTouched}', 'false') AS card_a1_after \gset
SELECT is((:'card_a1_before'::jsonb ->> 'cardStatus'), 'LEARNING', 'C0: sanity -- card_a1 starts LEARNING/FRESH');

SELECT is(
  (SELECT scheduler_position FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid),
  0, 'C0b: sanity -- deck_a starts at scheduler_position 0'
);
SELECT is(
  (SELECT first_v1_answer_at IS NULL FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_a_id'::uuid),
  true, 'C0c: sanity -- tester_a is enrolled in rollout (RC-C rollout-invariant corrective) but has not yet answered'
);

SELECT pg_temp.answer(
  :'tester_a_id', :'session_a', :'claim_a1', :'card_a1', 0, :'card_a1_before', :'card_a1_after', true,
  NULL, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
) AS commit_result_a \gset

SELECT is((:'commit_result_a'::jsonb ->> 'is_replay')::boolean, false, 'C1: a fresh commit reports is_replay=false');
SELECT is((:'commit_result_a'::jsonb -> 'user_card_progress' ->> 'learning_stage'), 'LEARNING_1', 'C2: the card''s learning_stage advances as computed');
SELECT is(
  (SELECT scheduler_position FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid),
  1, 'C3: scheduler_position advances by exactly 1'
);
SELECT is(
  (SELECT scheduler_revision FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid),
  (SELECT scheduler_revision FROM public.selection_claims WHERE id = :'claim_a1'::uuid) + 1,
  'C4: scheduler_revision bumps by exactly 1 from the currently-locked value (never claim.scheduler_revision + 1)'
);
SELECT is(
  (SELECT status FROM public.selection_claims WHERE id = :'claim_a1'::uuid),
  'ANSWERED', 'C5: the claim becomes ANSWERED'
);
SELECT is(
  (SELECT last_presented_scheduler_position FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a1'::uuid),
  1, 'C6: last_presented_scheduler_position becomes the newly committed position'
);
SELECT is(
  (SELECT count(*)::integer FROM public.answer_events WHERE client_event_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid),
  1, 'C7: exactly one review event (answer_events row) is persisted'
);
SELECT is(
  (SELECT selection_trace_id FROM public.answer_events WHERE client_event_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid),
  (SELECT selection_trace_id FROM public.selection_claims WHERE id = :'claim_a1'::uuid),
  'C8: the review event''s selection_trace_id matches the claim''s own trace linkage'
);
SELECT is(
  (SELECT scheduler_position FROM public.answer_events WHERE client_event_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid),
  (SELECT scheduler_position FROM public.selection_claims WHERE id = :'claim_a1'::uuid),
  'C9: the review event''s scheduler_position stays the PRE-answer trace echo, never the newly-committed position'
);
SELECT is(
  (SELECT first_v1_answer_at IS NOT NULL FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_a_id'::uuid),
  true, 'C10: first_v1_answer_at transitions to non-null on tester_a''s own first successful v1 answer'
);
SELECT is(
  (SELECT count(*)::integer FROM public.xp_events WHERE source_answer_event_id = (SELECT id FROM public.answer_events WHERE client_event_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid)),
  1, 'C11: exactly one XP event (correct_answer) -- no mastery/enemy-defeat/daily-goal XP this answer'
);
SELECT is(
  (SELECT amount FROM public.xp_events WHERE source_answer_event_id = (SELECT id FROM public.answer_events WHERE client_event_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid) AND reason = 'correct_answer'),
  2, 'C12: the correct_answer XP event is exactly +2'
);
SELECT is(
  (SELECT total_answers FROM public.sessions WHERE id = :'session_a'::uuid),
  1, 'C13: session.total_answers increments by exactly 1 (Battle state persisted atomically)'
);

-- C14: idempotent replay -- a retry of the SAME client_event_id changes
-- neither scheduler_position/revision, nor the claim, nor XP.
SELECT pg_temp.answer(
  :'tester_a_id', :'session_a', :'claim_a1', :'card_a1', 0, :'card_a1_before', :'card_a1_after', true,
  NULL, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
) AS replay_result_a \gset
SELECT is((:'replay_result_a'::jsonb ->> 'is_replay')::boolean, true, 'C14a: a retry of the same client_event_id replays');
SELECT is(
  (SELECT scheduler_position FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid),
  1, 'C14b: the replay does not advance scheduler_position again'
);
SELECT is(
  (SELECT count(*)::integer FROM public.xp_events WHERE source_answer_event_id = (SELECT id FROM public.answer_events WHERE client_event_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid)),
  1, 'C14c: the replay does not insert a second set of XP events'
);

-- C15: a DIFFERENT client_event_id against the now-ANSWERED claim is
-- rejected -- never treated as a new valid answer against an
-- already-consumed selection (spec section 30).
SELECT tests.throws_sqlstate(
  format(
    $sql$select pg_temp.answer(%L, %L, %L, %L, 1, %L::jsonb, %L::jsonb, true, NULL, gen_random_uuid())$sql$,
    :'tester_a_id', :'session_a', :'claim_a1', :'card_a1', :'card_a1_after', :'card_a1_after'
  ),
  '42501', 'C15: a different client_event_id against an already-ANSWERED claim is rejected, not treated as a new answer'
);

-- =========================================================================
-- Section D: mastery crossing, mastered_count, Full Mastery monotonicity.
-- =========================================================================

-- Claim and answer card_a2 as a qualifying FSRS Due Correct that crosses
-- first-time Mastery (count 2->3, streak 1->2).
UPDATE public.user_card_progress SET
  card_status = 'ACQUIRED', pool_status = 'OUTSIDE', learning_stage = NULL,
  fsrs_review_correct_count = 2, fsrs_review_correct_streak = 1
WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid;

SELECT pg_temp.claim(:'tester_a_id', :'session_a', :'deck_a', 1, 2, :'card_a2') AS claim_result_a2 \gset
SELECT (:'claim_result_a2'::jsonb -> 'claim' ->> 'id')::uuid AS claim_a2 \gset
SELECT pg_temp.card_json(:'tester_a_id'::uuid, :'card_a2'::uuid) AS card_a2_before \gset
SELECT jsonb_set(jsonb_set(jsonb_set(jsonb_set(
    :'card_a2_before'::jsonb, '{cardStatus}', '"LEARNED"'),
    '{fsrsReviewCorrectCount}', '3'), '{fsrsReviewCorrectStreak}', '2'), '{fsrsTouched}', 'false'
  ) AS card_a2_after \gset

SELECT (SELECT count(*)::integer FROM public.cards WHERE deck_id = :'deck_a'::uuid AND deleted_at IS NULL) AS deck_a_total_cards \gset
SELECT is(
  (SELECT mastered_count FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid),
  0, 'D0: sanity -- mastered_count starts at 0 for deck_a'
);

SELECT pg_temp.answer(
  :'tester_a_id', :'session_a', :'claim_a2', :'card_a2', 1, :'card_a2_before', :'card_a2_after', true
) AS commit_result_a2 \gset

SELECT is((:'commit_result_a2'::jsonb ->> 'card_mastered_just_now')::boolean, true, 'D1: card_mastered_just_now is true on the exact ACQUIRED -> LEARNED transition');
SELECT is(
  (SELECT count(*)::integer FROM public.xp_events WHERE source_answer_event_id = (:'commit_result_a2'::jsonb -> 'answer_event' ->> 'id')::uuid AND reason = 'card_learned'),
  1, 'D2: a card_learned XP event (+15) is recorded for the first-time mastery milestone'
);
SELECT is(
  (SELECT mastered_count FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid),
  1, 'D3: mastered_count is recomputed live to 1'
);
SELECT is(
  (SELECT has_achieved_full_mastery FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid),
  (1 = :'deck_a_total_cards'::integer), 'D4: has_achieved_full_mastery reflects whether mastered_count now equals the live total card count'
);

-- =========================================================================
-- Section E: legacy/v1 answer-path isolation (spec section 35).
-- =========================================================================

SELECT tests.throws_sqlstate(
  format(
    $sql$select public.commit_answer_transaction(
      gen_random_uuid(), %L, %L, %L,
      'NEW', 0, 0, 0, NULL, NULL, 0, 0,
      true, 1000, 'learning',
      'Good', now(), 1.0, 1.0, 0, 1, 1, 0, 0, 0, now(),
      1, 0, false, 1, 1, 100, false
    )$sql$,
    :'tester_a_id', :'session_a', :'card_a1'
  ),
  '42501', 'E1: commit_answer_transaction() (legacy) rejects a v1-engine session'
);

-- =========================================================================
-- Section G (corrective, 20261015000000): the one-way rollout guard
-- trigger, exercised directly against public.learning_engine_v1_rollout
-- -- enforced for EVERY role, including service_role (RLS/grants do not
-- apply to a bypassrls role, so the trigger itself is the only thing that
-- can protect this boundary). Items 7-10 of the corrective's own test
-- list are already covered by Section A2 above (the real
-- commit_learning_engine_v1_answer() first-answer/later-answer/replay/
-- legacy-unaffected flows); this section covers the trigger's own raw
-- DELETE/UPDATE semantics (items 1-6).
-- =========================================================================

SELECT tests.clear_auth();
SELECT gen_random_uuid() AS tester_e_id \gset
SELECT tests.create_test_profile(:'tester_e_id'::uuid, 'test_g20_tester_e');
SELECT tests.clear_auth();
SELECT tests.authenticate_as_service_role();

INSERT INTO public.learning_engine_v1_rollout (user_id) VALUES (:'tester_e_id'::uuid);

-- G1 (item 1): a row with first_v1_answer_at = NULL can be deleted.
SELECT lives_ok(
  format('delete from public.learning_engine_v1_rollout where user_id = %L', :'tester_e_id'),
  'G1: a rollout row with first_v1_answer_at IS NULL can be deleted (rollout may still be cancelled pre-commitment)'
);

-- G2 (item 3): NULL -> a first timestamp succeeds.
INSERT INTO public.learning_engine_v1_rollout (user_id) VALUES (:'tester_e_id'::uuid);
SELECT lives_ok(
  format($sql$update public.learning_engine_v1_rollout set first_v1_answer_at = now() where user_id = %L$sql$, :'tester_e_id'),
  'G2: first_v1_answer_at transitioning NULL -> a timestamp is allowed'
);
SELECT (SELECT first_v1_answer_at FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_e_id'::uuid) AS tester_e_first_answer_at \gset

-- G3 (item 4): non-NULL -> NULL is rejected.
SELECT tests.throws_sqlstate(
  format($sql$update public.learning_engine_v1_rollout set first_v1_answer_at = null where user_id = %L$sql$, :'tester_e_id'),
  '42501', 'G3: first_v1_answer_at transitioning non-NULL -> NULL is rejected'
);

-- G4 (item 5): non-NULL -> a DIFFERENT timestamp is rejected.
SELECT tests.throws_sqlstate(
  format($sql$update public.learning_engine_v1_rollout set first_v1_answer_at = now() + interval '1 hour' where user_id = %L$sql$, :'tester_e_id'),
  '42501', 'G4: first_v1_answer_at transitioning non-NULL -> a different timestamp is rejected'
);

-- G5 (item 6): non-NULL -> the SAME value does not violate the invariant
-- -- including an update that only touches an unrelated column.
SELECT lives_ok(
  format(
    $sql$update public.learning_engine_v1_rollout set first_v1_answer_at = %L::timestamptz where user_id = %L$sql$,
    :'tester_e_first_answer_at', :'tester_e_id'
  ),
  'G5a: first_v1_answer_at set to its own current (unchanged) value does not violate the invariant'
);
SELECT lives_ok(
  format($sql$update public.learning_engine_v1_rollout set enabled_at = now() where user_id = %L$sql$, :'tester_e_id'),
  'G5b: an unrelated column update on an already-permanent row is unaffected by the guard'
);
SELECT is(
  (SELECT first_v1_answer_at FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_e_id'::uuid),
  :'tester_e_first_answer_at'::timestamptz, 'G5c: first_v1_answer_at is still exactly its original value after both no-op updates'
);

-- G6 (item 2): a row with first_v1_answer_at != NULL cannot be deleted --
-- for service_role, the exact role every trusted Learning Engine v1
-- function (including commit_learning_engine_v1_answer() itself) runs
-- as. This is the core of the fix: the boundary holds even here.
SELECT tests.throws_sqlstate(
  format('delete from public.learning_engine_v1_rollout where user_id = %L', :'tester_e_id'),
  '42501', 'G6: a rollout row with first_v1_answer_at IS NOT NULL cannot be deleted, even by service_role'
);

-- G7 (item 10): a tester with no v1 history at all (tester_b, legacy) is
-- completely unaffected by this guard -- it has no rollout row and never
-- will via any normal v1 path.
SELECT is(
  (SELECT count(*)::integer FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_b_id'::uuid),
  0, 'G7: a legacy-only tester with no v1 history has no rollout row and is unaffected by the guard'
);

-- =========================================================================
-- Section H (corrective, 20261016000000): full account deletion of a
-- user whose rollout row is permanent -- the one sanctioned bypass,
-- proving "cannot revert a live v1 user to legacy" never means "cannot
-- delete the user's account." tester_e (from Section G) already has a
-- permanent rollout row (first_v1_answer_at IS NOT NULL) at this point.
-- =========================================================================

-- H1 (item 5): the sanctioned bypass function succeeds even though the
-- row is permanent.
SELECT lives_ok(
  format('select public.delete_learning_engine_v1_rollout_for_account_deletion(%L::uuid)', :'tester_e_id'),
  'H1: delete_learning_engine_v1_rollout_for_account_deletion() succeeds for a user with first_v1_answer_at IS NOT NULL'
);

-- H2 (item 6/9): the rollout row is actually gone -- no orphan left behind.
SELECT is(
  (SELECT count(*)::integer FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_e_id'::uuid),
  0, 'H2: the rollout row is removed as part of the full deletion, with no orphan remaining'
);

-- H3 (item 2, re-affirmed): the bypass is scoped to that one function
-- call, transaction-local -- it does NOT leave deletion of OTHER
-- permanent rows open for the rest of this transaction. tester_d (claim
-- flow tester) also has a permanent rollout row by this point in the
-- file (Section A2) -- a direct delete against ITS row must still be
-- rejected.
SELECT tests.throws_sqlstate(
  format('delete from public.learning_engine_v1_rollout where user_id = %L', :'tester_d_id'),
  '42501', 'H3: the account-deletion bypass does not leak -- a DIFFERENT permanent rollout row is still protected in the same transaction'
);

-- H4 (item 7): with the rollout row gone, the profile can now be deleted
-- (profiles.id -> auth.users.id is on delete restrict, so this must
-- happen before the auth.users row).
SELECT lives_ok(
  format('delete from public.profiles where id = %L', :'tester_e_id'),
  'H4: the profile can be deleted once the rollout row is gone'
);

-- H5 (item 8): auth.users deletion itself is exclusively exercised via
-- the real Supabase Admin API (admin.auth.admin.deleteUser()) in the
-- integration suite -- service_role has no raw SQL grant on auth.users
-- in this local stack (confirmed by audit: GoTrue manages that table
-- internally), so it is not meaningfully testable at the pgTAP/SQL layer.
-- See tests/integration/16-learning-engine-v1-rc-c-answer-commit.test.ts's
-- "a full account deletion of a user who has entered the one-way zone
-- succeeds end-to-end" for that proof, and
-- tests/integration/fixtures/setup.ts's teardownIntegrationFixtures(),
-- which every integration run already exercises for testerA/testerB.

-- H6 (item 9, sweep over what IS reachable at this layer): no orphan
-- rollout row or profile remains for this user.
SELECT is((SELECT count(*)::integer FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_e_id'::uuid), 0, 'H6a: no orphan rollout row');
SELECT is((SELECT count(*)::integer FROM public.profiles WHERE id = :'tester_e_id'::uuid), 0, 'H6b: no orphan profile');

SELECT tests.clear_auth();

SELECT * FROM finish();
ROLLBACK;
