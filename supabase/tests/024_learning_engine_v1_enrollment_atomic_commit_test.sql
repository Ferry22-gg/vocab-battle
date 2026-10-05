\ir fixtures/000_test_helpers.inc

-- Group 24: Learning Engine v1, pre-RC-E corrective (second pass) --
-- commit_learning_engine_v1_enrollment(), the single atomic enrollment
-- transaction.
-- Maps to supabase/migrations/
-- 20261020000000_learning_engine_v1_enrollment_atomic_commit.sql.
--
-- Covers the actual TOCTOU race this migration closes: an active legacy
-- Session blocks enrollment with ZERO normalization writes (never "catch
-- it too late, after normalization already committed"); an
-- already-enrolled user's live v1 state is never re-normalized; a
-- drifted/invalid card in the payload rolls back the ENTIRE transaction,
-- including any other card in the same payload that would otherwise
-- have been validly normalized; and, end to end, finishing the blocking
-- Session and retrying lets enrollment succeed, after which a genuinely
-- NEW Session for that user is engine_version='v1'.
--
-- The TypeScript-side orchestration (enroll.ts's fast-path pre-checks,
-- and how it maps this function's three-way status envelope back to its
-- own result/error contract) is covered at its own layer by
-- tests/unit/learning-engine-cutover-enroll.test.ts. True concurrent
-- backends racing this function's profile-row lock are not exercised
-- here (pgTAP runs one psql session per file) -- the lock itself is the
-- same FOR UPDATE pattern start_or_resume_session() already uses and is
-- not re-derived or re-tested here.

BEGIN;
SELECT plan(24);

-- =========================================================================
-- Fixtures
-- =========================================================================
-- tester_j: ACTIVE legacy session at enrollment time -> rejected, zero writes.
SELECT gen_random_uuid() AS tester_j_id \gset
-- tester_k: already enrolled, with live v1 progress on one card -> re-enrollment is a true no-op.
SELECT gen_random_uuid() AS tester_k_id \gset
-- tester_l: ordinary first-time enrollment, then an idempotent duplicate call.
SELECT gen_random_uuid() AS tester_l_id \gset
-- tester_m: a drifted/invalid card in the payload -> whole transaction rolls back.
SELECT gen_random_uuid() AS tester_m_id \gset
-- tester_n: end-to-end -- finish the blocking session, enroll, then a new session is v1.
SELECT gen_random_uuid() AS tester_n_id \gset

SELECT tests.official_deck_id('Advanced English Vocabulary I') AS official_deck_id \gset

SELECT tests.create_test_profile(:'tester_j_id'::uuid, 'test_g24_tester_j');
SELECT tests.create_test_profile(:'tester_k_id'::uuid, 'test_g24_tester_k');
SELECT tests.create_test_profile(:'tester_l_id'::uuid, 'test_g24_tester_l');
SELECT tests.create_test_profile(:'tester_m_id'::uuid, 'test_g24_tester_m');
SELECT tests.create_test_profile(:'tester_n_id'::uuid, 'test_g24_tester_n');

-- =========================================================================
-- Section A: an ACTIVE legacy session blocks the atomic transaction with
-- ZERO normalization writes -- never "normalize first, reject later."
-- =========================================================================

SELECT tests.authenticate_as(:'tester_j_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_j \gset
SELECT (public.start_or_resume_session()).id AS session_j \gset
SELECT tests.clear_auth();

SELECT id AS card_j1 FROM public.cards WHERE deck_id = :'deck_j'::uuid ORDER BY sort_order LIMIT 1 \gset

SELECT tests.authenticate_as_service_role();
UPDATE public.user_card_progress SET card_status = 'LEARNING' WHERE user_id = :'tester_j_id'::uuid AND card_id = :'card_j1'::uuid;
SELECT tests.clear_auth();

SELECT is(
  (SELECT status FROM public.sessions WHERE id = :'session_j'::uuid),
  'active', 'A0: session_j is active (sanity check)'
);
SELECT is(
  (SELECT engine_version FROM public.sessions WHERE id = :'session_j'::uuid),
  'legacy', 'A1: session_j is legacy (sanity check)'
);

SELECT tests.authenticate_as_service_role();
SELECT public.commit_learning_engine_v1_enrollment(
  :'tester_j_id'::uuid,
  'test-normalization-version',
  jsonb_build_array(jsonb_build_object(
    'cardId', :'card_j1', 'expectedLegacyCardStatus', 'LEARNING',
    'cardStatus', 'LEARNING', 'learningStage', 'FRESH', 'poolStatus', 'ACTIVE', 'relearningPhase', null,
    'hasEverBeenMastered', false, 'repairPending', false,
    'repairWrongPosition', null, 'repairTargetPosition', null, 'repairHardCapPosition', null
  )),
  to_jsonb(array[:'deck_j'::text])
) AS result_j \gset
SELECT tests.clear_auth();

SELECT is(
  (:'result_j'::jsonb ->> 'status'),
  'active_legacy_session', 'A2: commit_learning_engine_v1_enrollment rejects with active_legacy_session'
);
SELECT is(
  (:'result_j'::jsonb ->> 'session_id')::uuid,
  :'session_j'::uuid, 'A3: the returned session_id identifies the actual blocking session'
);
SELECT is(
  (SELECT count(*)::integer FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_j_id'::uuid),
  0, 'A4: no rollout row was created'
);
SELECT is(
  (SELECT learning_stage FROM public.user_card_progress WHERE user_id = :'tester_j_id'::uuid AND card_id = :'card_j1'::uuid),
  NULL, 'A5: the card was never normalized -- learning_stage is still null, not the FRESH the payload specified'
);

-- =========================================================================
-- Section B: an already-enrolled user's live v1 progress is NEVER
-- re-normalized, even when the atomic transaction is called again with a
-- (deliberately stale/arbitrary) payload.
-- =========================================================================

SELECT tests.authenticate_as(:'tester_k_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_k \gset
SELECT tests.clear_auth();

SELECT id AS card_k1 FROM public.cards WHERE deck_id = :'deck_k'::uuid ORDER BY sort_order LIMIT 1 \gset

SELECT tests.authenticate_as_service_role();
-- Simulate genuine live v1 progress: this card has already advanced to
-- LEARNING_2 under the real v1 engine since this user was enrolled.
UPDATE public.user_card_progress
  SET card_status = 'LEARNING', learning_stage = 'LEARNING_2', pool_status = 'ACTIVE'
  WHERE user_id = :'tester_k_id'::uuid AND card_id = :'card_k1'::uuid;
INSERT INTO public.learning_engine_v1_rollout (user_id) VALUES (:'tester_k_id'::uuid);
SELECT tests.clear_auth();

SELECT is(
  (SELECT count(*)::integer FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_k_id'::uuid),
  1, 'B0: tester_k is already enrolled (sanity check)'
);

SELECT tests.authenticate_as_service_role();
SELECT public.commit_learning_engine_v1_enrollment(
  :'tester_k_id'::uuid,
  'test-normalization-version',
  jsonb_build_array(jsonb_build_object(
    'cardId', :'card_k1', 'expectedLegacyCardStatus', 'LEARNING',
    'cardStatus', 'LEARNING', 'learningStage', 'FRESH', 'poolStatus', 'ACTIVE', 'relearningPhase', null,
    'hasEverBeenMastered', false, 'repairPending', false,
    'repairWrongPosition', null, 'repairTargetPosition', null, 'repairHardCapPosition', null
  )),
  to_jsonb(array[:'deck_k'::text])
) AS result_k \gset
SELECT tests.clear_auth();

SELECT is(
  (:'result_k'::jsonb ->> 'status'),
  'already_enrolled', 'B1: commit_learning_engine_v1_enrollment returns already_enrolled (true no-op)'
);
SELECT is(
  (SELECT learning_stage FROM public.user_card_progress WHERE user_id = :'tester_k_id'::uuid AND card_id = :'card_k1'::uuid),
  'LEARNING_2', 'B2: live v1 progress is byte-identical -- NOT regressed to the payload''s FRESH'
);
SELECT is(
  ((:'result_k'::jsonb ->> 'cards_normalized')::integer),
  0, 'B3: cards_normalized is 0 -- nothing was re-normalized'
);

-- =========================================================================
-- Section C: ordinary first-time enrollment succeeds, and a duplicate
-- call afterward (simulating a concurrent/retried enrollment) converges
-- to the same idempotent no-op without a second normalization pass.
-- =========================================================================

SELECT tests.authenticate_as(:'tester_l_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_l \gset
SELECT tests.clear_auth();

SELECT id AS card_l1 FROM public.cards WHERE deck_id = :'deck_l'::uuid ORDER BY sort_order LIMIT 1 \gset

SELECT tests.authenticate_as_service_role();
UPDATE public.user_card_progress SET card_status = 'LEARNING' WHERE user_id = :'tester_l_id'::uuid AND card_id = :'card_l1'::uuid;
SELECT tests.clear_auth();

SELECT is(
  (SELECT count(*)::integer FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_l_id'::uuid),
  0, 'C0: tester_l has no rollout row yet (sanity check)'
);

SELECT tests.authenticate_as_service_role();
SELECT public.commit_learning_engine_v1_enrollment(
  :'tester_l_id'::uuid,
  'test-normalization-version',
  jsonb_build_array(jsonb_build_object(
    'cardId', :'card_l1', 'expectedLegacyCardStatus', 'LEARNING',
    'cardStatus', 'LEARNING', 'learningStage', 'FRESH', 'poolStatus', 'ACTIVE', 'relearningPhase', null,
    'hasEverBeenMastered', false, 'repairPending', false,
    'repairWrongPosition', null, 'repairTargetPosition', null, 'repairHardCapPosition', null
  )),
  to_jsonb(array[:'deck_l'::text])
) AS result_l1 \gset
SELECT tests.clear_auth();

SELECT is((:'result_l1'::jsonb ->> 'status'), 'ok', 'C1: first-time enrollment commits (status ok)');
SELECT is(
  (SELECT count(*)::integer FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_l_id'::uuid),
  1, 'C2: the rollout row now exists'
);
SELECT is(
  (SELECT learning_stage FROM public.user_card_progress WHERE user_id = :'tester_l_id'::uuid AND card_id = :'card_l1'::uuid),
  'FRESH', 'C3: the card was normalized to the prepared target'
);
SELECT is(
  (SELECT pool_status FROM public.user_card_progress WHERE user_id = :'tester_l_id'::uuid AND card_id = :'card_l1'::uuid),
  'ACTIVE', 'C3b: pool_status was normalized too'
);
SELECT is(
  ((:'result_l1'::jsonb ->> 'decks_recomputed')::integer),
  1, 'C4: exactly one deck was recomputed'
);

SELECT tests.authenticate_as_service_role();
SELECT public.commit_learning_engine_v1_enrollment(
  :'tester_l_id'::uuid,
  'test-normalization-version',
  jsonb_build_array(jsonb_build_object(
    'cardId', :'card_l1', 'expectedLegacyCardStatus', 'LEARNING',
    'cardStatus', 'LEARNING', 'learningStage', 'FRESH', 'poolStatus', 'ACTIVE', 'relearningPhase', null,
    'hasEverBeenMastered', false, 'repairPending', false,
    'repairWrongPosition', null, 'repairTargetPosition', null, 'repairHardCapPosition', null
  )),
  to_jsonb(array[:'deck_l'::text])
) AS result_l2 \gset
SELECT tests.clear_auth();

SELECT is((:'result_l2'::jsonb ->> 'status'), 'already_enrolled', 'C5: a duplicate enrollment call converges to the same idempotent no-op');
SELECT is(
  (SELECT learning_stage FROM public.user_card_progress WHERE user_id = :'tester_l_id'::uuid AND card_id = :'card_l1'::uuid),
  'FRESH', 'C6: the duplicate call left the already-normalized card unchanged'
);

-- =========================================================================
-- Section D: a drifted/invalid card anywhere in the payload rolls back
-- the ENTIRE transaction -- including an otherwise-valid card earlier in
-- the same payload.
-- =========================================================================

SELECT tests.authenticate_as(:'tester_m_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_m \gset
SELECT tests.clear_auth();

SELECT id AS card_m1 FROM public.cards WHERE deck_id = :'deck_m'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
SELECT id AS card_m2 FROM public.cards WHERE deck_id = :'deck_m'::uuid ORDER BY sort_order LIMIT 1 OFFSET 1 \gset

SELECT tests.authenticate_as_service_role();
-- card_m1 is genuinely LEARNING (the payload below will correctly expect
-- that). card_m2 is also genuinely LEARNING, but the payload below will
-- claim it expects LEARNED (a drifted/stale expectation) -- that is the
-- entry that must fail and roll back card_m1's otherwise-valid write too.
UPDATE public.user_card_progress SET card_status = 'LEARNING' WHERE user_id = :'tester_m_id'::uuid AND card_id IN (:'card_m1'::uuid, :'card_m2'::uuid);
SELECT tests.clear_auth();

SELECT tests.authenticate_as_service_role();
SELECT tests.throws_sqlstate(
  format(
    $sql$select public.commit_learning_engine_v1_enrollment(
      %L, 'test-normalization-version',
      jsonb_build_array(
        jsonb_build_object(
          'cardId', %L, 'expectedLegacyCardStatus', 'LEARNING',
          'cardStatus', 'LEARNING', 'learningStage', 'FRESH', 'poolStatus', 'ACTIVE', 'relearningPhase', null,
          'hasEverBeenMastered', false, 'repairPending', false,
          'repairWrongPosition', null, 'repairTargetPosition', null, 'repairHardCapPosition', null
        ),
        jsonb_build_object(
          'cardId', %L, 'expectedLegacyCardStatus', 'LEARNED',
          'cardStatus', 'LEARNING', 'learningStage', 'FRESH', 'poolStatus', 'ACTIVE', 'relearningPhase', null,
          'hasEverBeenMastered', false, 'repairPending', false,
          'repairWrongPosition', null, 'repairTargetPosition', null, 'repairHardCapPosition', null
        )
      ),
      %L::jsonb
    )$sql$,
    :'tester_m_id', :'card_m1', :'card_m2', to_jsonb(array[:'deck_m'::text])::text
  ),
  '40001', 'D0: a drifted expectedLegacyCardStatus anywhere in the payload raises 40001'
);
SELECT tests.clear_auth();

SELECT is(
  (SELECT count(*)::integer FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_m_id'::uuid),
  0, 'D1: no rollout row was created'
);
SELECT is(
  (SELECT learning_stage FROM public.user_card_progress WHERE user_id = :'tester_m_id'::uuid AND card_id = :'card_m1'::uuid),
  NULL, 'D2: card_m1''s otherwise-valid normalization was rolled back along with the whole transaction'
);

-- =========================================================================
-- Section E: end to end -- finish the blocking legacy session, enroll,
-- then a genuinely NEW session for that user is engine_version='v1'.
-- =========================================================================

SELECT tests.authenticate_as(:'tester_n_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_n \gset
SELECT (public.start_or_resume_session()).id AS session_n1 \gset
SELECT public.finish_session(:'session_n1'::uuid);
SELECT tests.clear_auth();

SELECT is(
  (SELECT status FROM public.sessions WHERE id = :'session_n1'::uuid),
  'completed', 'E0: the blocking session has been finished'
);

SELECT tests.authenticate_as_service_role();
SELECT public.commit_learning_engine_v1_enrollment(
  :'tester_n_id'::uuid, 'test-normalization-version', '[]'::jsonb, to_jsonb(array[:'deck_n'::text])
) AS result_n \gset
SELECT tests.clear_auth();

SELECT is((:'result_n'::jsonb ->> 'status'), 'ok', 'E1: enrollment now succeeds once the blocking session is finished');

SELECT tests.authenticate_as(:'tester_n_id'::uuid);
SELECT (public.start_or_resume_session()).id AS session_n2 \gset
SELECT tests.clear_auth();

SELECT is(
  (SELECT engine_version FROM public.sessions WHERE id = :'session_n2'::uuid),
  'v1', 'E2: a genuinely new session for this user is now engine_version=v1'
);

SELECT * FROM finish();
ROLLBACK;
