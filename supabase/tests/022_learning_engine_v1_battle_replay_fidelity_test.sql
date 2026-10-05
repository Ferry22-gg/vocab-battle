\ir fixtures/000_test_helpers.inc

-- Group 22: Learning Engine v1 -- Runtime Cutover RC-D correction:
-- v1 answer replay Battle fidelity.
-- Maps to supabase/migrations/
-- 20261018000000_learning_engine_v1_battle_replay_fidelity.sql.
--
-- Covers: commit_learning_engine_v1_answer() now persists
-- base_damage/speed_bonus/critical/combo/damage/enemy_hp_before/
-- enemy_hp_after onto its own answer_events row (previously always
-- 0/false/NULL for every v1 row), and a genuine client_event_id replay
-- returns those EXACT persisted values -- even after further answers
-- have since changed the session/deck's current Battle/scheduler state
-- -- never recomputed, never derived from current state.

BEGIN;
SELECT plan(14);

SELECT gen_random_uuid() AS tester_a_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS official_deck_id \gset

SELECT tests.create_test_profile(:'tester_a_id'::uuid, 'test_g22_tester_a');
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_a \gset
SELECT (public.start_or_resume_session()).id AS session_a \gset
SELECT tests.clear_auth();

INSERT INTO public.learning_engine_v1_rollout (user_id) VALUES (:'tester_a_id'::uuid);
UPDATE public.sessions SET engine_version = 'v1' WHERE id = :'session_a'::uuid;

SELECT id AS card_a1 FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
SELECT id AS card_a2 FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 1 \gset

-- Record the enemy's starting HP (shared Battle/session init, unrelated
-- to engine) -- the authoritative "before" value this test proves the
-- replay must keep reporting even after it has since changed.
SELECT current_enemy_hp AS enemy_hp_start FROM public.sessions WHERE id = :'session_a'::uuid \gset

SELECT tests.authenticate_as_service_role();

SELECT public.get_learning_engine_v1_scheduler_snapshot(:'tester_a_id'::uuid, :'session_a'::uuid);

UPDATE public.user_card_progress SET card_status = 'LEARNING', learning_stage = 'FRESH', pool_status = 'ACTIVE'
WHERE user_id = :'tester_a_id'::uuid AND card_id IN (:'card_a1'::uuid, :'card_a2'::uuid);

CREATE FUNCTION pg_temp.claim(
  p_user_id uuid, p_session_id uuid, p_deck_id uuid,
  p_expected_position integer, p_expected_revision integer, p_card_id uuid
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

-- Mirrors supabase/tests/020's own pg_temp.answer() exactly: a trivial,
-- always-valid Correct-answer Battle shape (damage=1, no critical, no
-- defeat) -- deliberately non-zero/non-default, so this test can tell a
-- genuinely persisted value apart from the old silent 0/false default.
CREATE FUNCTION pg_temp.answer(
  p_user_id uuid,
  p_session_id uuid,
  p_claim_id uuid,
  p_card_id uuid,
  p_expected_position integer,
  p_expected_card_before jsonb,
  p_card_after jsonb,
  p_client_event_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
declare
  v_session public.sessions;
  v_combo_after integer;
  v_enemy_hp_after integer;
begin
  select * into v_session from public.sessions where id = p_session_id;
  v_combo_after := least(v_session.current_combo + 1, 10);
  v_enemy_hp_after := greatest(0, v_session.current_enemy_hp - 1);

  return public.commit_learning_engine_v1_answer(
    p_client_event_id, p_user_id, p_session_id, p_claim_id, p_card_id,
    p_expected_position, p_expected_card_before, v_session.current_combo, v_session.current_enemy_hp,
    p_card_after, NULL,
    true, 1000,
    1, 0, false, v_combo_after,
    1, v_enemy_hp_after, (v_enemy_hp_after = 0),
    NULL, NULL, NULL,
    pg_temp.review_event_json()
  );
end;
$$;

SELECT pg_temp.claim(:'tester_a_id', :'session_a', :'deck_a', 0, 0, :'card_a1') AS claim_result_1 \gset
SELECT (:'claim_result_1'::jsonb -> 'claim' ->> 'id')::uuid AS claim_1 \gset
SELECT pg_temp.card_json(:'tester_a_id'::uuid, :'card_a1'::uuid) AS card_1_before \gset
SELECT jsonb_set(jsonb_set(:'card_1_before'::jsonb, '{learningStage}', '"LEARNING_1"'), '{fsrsTouched}', 'false') AS card_1_after \gset

-- The FIRST (original) answer. Fixed client_event_id -- this is the one
-- that will later be replayed.
SELECT pg_temp.answer(
  :'tester_a_id', :'session_a', :'claim_1', :'card_a1', 0, :'card_1_before', :'card_1_after',
  'dddddddd-dddd-dddd-dddd-dddddddddddd'
) AS first_result \gset

SELECT is((:'first_result'::jsonb ->> 'is_replay')::boolean, false, '1: the first (fresh) commit succeeds');

-- 2-6: the fix itself -- the fresh row now carries the real Battle
-- result, not the old 0/false default.
SELECT is(
  (SELECT damage FROM public.answer_events WHERE client_event_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid),
  1, '2: the fresh v1 answer_events row persists the real damage (1), not the old silent default (0)'
);
SELECT is(
  (SELECT combo FROM public.answer_events WHERE client_event_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid),
  1, '3: the fresh row persists the real comboAfter (1)'
);
SELECT is(
  (SELECT critical FROM public.answer_events WHERE client_event_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid),
  false, '4: the fresh row persists critical (false, as submitted)'
);
SELECT is(
  (SELECT enemy_hp_before FROM public.answer_events WHERE client_event_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid),
  :'enemy_hp_start'::integer, '5: the fresh row persists enemy_hp_before'
);
SELECT is(
  (SELECT enemy_hp_after FROM public.answer_events WHERE client_event_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid),
  :'enemy_hp_start'::integer - 1, '6: the fresh row persists enemy_hp_after'
);

-- 7: a SECOND, DIFFERENT answer (different card, different
-- client_event_id) changes scheduler_position/session combo/enemy HP
-- further -- current state now genuinely diverges from what it was
-- right after the first answer.
SELECT pg_temp.claim(:'tester_a_id', :'session_a', :'deck_a', 1, 2, :'card_a2') AS claim_result_2 \gset
SELECT (:'claim_result_2'::jsonb -> 'claim' ->> 'id')::uuid AS claim_2 \gset
SELECT pg_temp.card_json(:'tester_a_id'::uuid, :'card_a2'::uuid) AS card_2_before \gset
SELECT jsonb_set(jsonb_set(:'card_2_before'::jsonb, '{learningStage}', '"LEARNING_1"'), '{fsrsTouched}', 'false') AS card_2_after \gset

SELECT pg_temp.answer(
  :'tester_a_id', :'session_a', :'claim_2', :'card_a2', 1, :'card_2_before', :'card_2_after',
  gen_random_uuid()
) AS second_result \gset
SELECT is((:'second_result'::jsonb ->> 'is_replay')::boolean, false, '7: the second (different) answer also succeeds, advancing state further');

-- Snapshot the now-diverged scheduler/session state, to prove the
-- replay below does not move it again.
SELECT scheduler_position AS sched_pos_after_second, scheduler_revision AS sched_rev_after_second
  FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid \gset
SELECT total_answers AS total_answers_after_second, current_combo AS combo_after_second, current_enemy_hp AS enemy_hp_after_second
  FROM public.sessions WHERE id = :'session_a'::uuid \gset
SELECT (SELECT count(*)::integer FROM public.xp_events WHERE user_id = :'tester_a_id'::uuid) AS xp_count_after_second \gset

-- 8: REPLAY the FIRST client_event_id -- same logical answer, resubmitted
-- (e.g. a lost-response retry). Current session combo/enemy HP/
-- scheduler_position are now genuinely different from what they were
-- when the original answer was committed.
SELECT pg_temp.answer(
  :'tester_a_id', :'session_a', :'claim_1', :'card_a1', 0, :'card_1_before', :'card_1_after',
  'dddddddd-dddd-dddd-dddd-dddddddddddd'
) AS replay_result \gset

SELECT is((:'replay_result'::jsonb ->> 'is_replay')::boolean, true, '8: the replay is correctly recognized as a replay');

-- 9-11: the replay's returned Battle result matches the ORIGINAL
-- first-answer values EXACTLY, not the diverged current state (damage
-- would be a different number entirely if recomputed against the
-- now-lower enemy HP; comboAfter would be wrong if taken from the
-- session's current combo of 2).
SELECT is(
  (:'replay_result'::jsonb -> 'answer_event' ->> 'damage')::integer,
  1, '9: replay reports the ORIGINAL damage (1), never recomputed'
);
SELECT is(
  (:'replay_result'::jsonb -> 'answer_event' ->> 'combo')::integer,
  1, '10: replay reports the ORIGINAL comboAfter (1), not the session''s current combo (2)'
);
SELECT is(
  (:'replay_result'::jsonb -> 'answer_event' ->> 'enemy_hp_after')::integer,
  :'enemy_hp_start'::integer - 1, '11: replay reports the ORIGINAL enemy_hp_after, not the session''s current (further-reduced) enemy HP'
);

-- 12-14: the replay itself caused NO further mutation of anything --
-- scheduler position/revision, session Battle state, and XP totals are
-- exactly what they were right after the SECOND answer, untouched by
-- replaying the first.
SELECT is(
  row(
    (SELECT scheduler_position FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid),
    (SELECT scheduler_revision FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid)
  ),
  row(:'sched_pos_after_second'::integer, :'sched_rev_after_second'::integer),
  '12: the replay does not advance scheduler_position/scheduler_revision'
);
SELECT is(
  row(
    (SELECT total_answers FROM public.sessions WHERE id = :'session_a'::uuid),
    (SELECT current_combo FROM public.sessions WHERE id = :'session_a'::uuid),
    (SELECT current_enemy_hp FROM public.sessions WHERE id = :'session_a'::uuid)
  ),
  row(:'total_answers_after_second'::integer, :'combo_after_second'::integer, :'enemy_hp_after_second'::integer),
  '13: the replay does not mutate session Battle/answer-count state'
);
SELECT is(
  (SELECT count(*)::integer FROM public.xp_events WHERE user_id = :'tester_a_id'::uuid),
  :'xp_count_after_second'::integer, '14: the replay does not award duplicate XP'
);

SELECT * FROM finish();
ROLLBACK;
