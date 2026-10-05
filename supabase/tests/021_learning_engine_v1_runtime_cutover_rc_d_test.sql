\ir fixtures/000_test_helpers.inc

-- Group 21: Learning Engine v1, Runtime Cutover RC-D (Live Session
-- Routing / Cutover Wiring).
-- Maps to supabase/migrations/
-- 20261017000000_learning_engine_v1_runtime_cutover_rc_d.sql.
--
-- Covers: start_or_resume_session()'s engine_version assignment/pinning
-- rule, finish_session()'s v1 OPEN-claim abandonment, and
-- admit_user_to_learning_engine_v1()'s grants/idempotency.
--
-- Deliberately NOT re-covered here (already exhaustive at their own
-- layer): RC-B/RC-C's own cross-entity validation (019/020), the
-- scheduler/FSRS/repair transition matrix (unit tests), and the
-- TypeScript routing/adapter layer (lib/learning/engine-router.ts --
-- tests/unit/engine-router.test.ts and the real-stack integration test).

BEGIN;
SELECT plan(24);

-- =========================================================================
-- Fixtures
-- =========================================================================
-- tester_a: never enrolled -> legacy.
SELECT gen_random_uuid() AS tester_a_id \gset
-- tester_b: enrolled before first session -> v1.
SELECT gen_random_uuid() AS tester_b_id \gset
-- tester_c: enrolled AND one-way before first session -> v1.
SELECT gen_random_uuid() AS tester_c_id \gset
-- tester_d: legacy session created first, enrolled WHILE active -> resume stays legacy.
SELECT gen_random_uuid() AS tester_d_id \gset
-- tester_e: v1 claim-abandonment-on-finish.
SELECT gen_random_uuid() AS tester_e_id \gset
-- tester_f: admit_user_to_learning_engine_v1 grants/idempotency.
SELECT gen_random_uuid() AS tester_f_id \gset
-- admin: admit_user_to_learning_engine_v1 tester-only guard.
SELECT gen_random_uuid() AS admin_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS official_deck_id \gset

SELECT tests.create_test_profile(:'tester_a_id'::uuid, 'test_g21_tester_a');
SELECT tests.create_test_profile(:'tester_b_id'::uuid, 'test_g21_tester_b');
SELECT tests.create_test_profile(:'tester_c_id'::uuid, 'test_g21_tester_c');
SELECT tests.create_test_profile(:'tester_d_id'::uuid, 'test_g21_tester_d');
SELECT tests.create_test_profile(:'tester_e_id'::uuid, 'test_g21_tester_e');
SELECT tests.create_test_profile(:'tester_f_id'::uuid, 'test_g21_tester_f');
SELECT tests.create_test_profile(:'admin_id'::uuid, 'test_g21_admin', 'admin');

-- =========================================================================
-- Section A: new-Session engine assignment follows the rollout rule.
-- =========================================================================

-- A1: a never-enrolled tester's brand-new session is 'legacy'.
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_a \gset
SELECT (public.start_or_resume_session()).id AS session_a \gset
SELECT tests.clear_auth();

SELECT is(
  (SELECT engine_version FROM public.sessions WHERE id = :'session_a'::uuid),
  'legacy', 'A1: a non-enrolled tester''s brand-new session is legacy'
);

-- A2: a tester with a learning_engine_v1_rollout row BEFORE their first
-- session gets engine_version = 'v1' -- mere row existence is the
-- signal, regardless of first_v1_answer_at (still null here).
SELECT tests.authenticate_as_service_role();
INSERT INTO public.learning_engine_v1_rollout (user_id) VALUES (:'tester_b_id'::uuid);
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_b \gset
SELECT (public.start_or_resume_session()).id AS session_b \gset
SELECT tests.clear_auth();

SELECT is(
  (SELECT engine_version FROM public.sessions WHERE id = :'session_b'::uuid),
  'v1', 'A2: a rollout-admitted tester''s brand-new session is v1 (first_v1_answer_at still null)'
);

-- A3: a one-way tester (first_v1_answer_at already set) ALSO gets v1 for
-- a brand-new session -- never a legacy fallback for a one-way user.
SELECT tests.authenticate_as_service_role();
INSERT INTO public.learning_engine_v1_rollout (user_id, first_v1_answer_at) VALUES (:'tester_c_id'::uuid, now());
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_c_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_c \gset
SELECT (public.start_or_resume_session()).id AS session_c \gset
SELECT tests.clear_auth();

SELECT is(
  (SELECT engine_version FROM public.sessions WHERE id = :'session_c'::uuid),
  'v1', 'A3: a one-way (first_v1_answer_at set) tester''s brand-new session is v1'
);

-- =========================================================================
-- Section B: engine_version is pinned at creation -- a resume never
-- re-evaluates it, even if rollout state changes while the session is
-- still active.
-- =========================================================================

-- B1: tester_d starts a session while NOT enrolled (legacy)...
SELECT tests.authenticate_as(:'tester_d_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_d \gset
SELECT (public.start_or_resume_session()).id AS session_d1 \gset
SELECT tests.clear_auth();

-- ...then becomes rollout-admitted WHILE that session is still active...
SELECT tests.authenticate_as_service_role();
INSERT INTO public.learning_engine_v1_rollout (user_id) VALUES (:'tester_d_id'::uuid);
SELECT tests.clear_auth();

-- ...and resuming (not creating a new session) must return the SAME
-- session, still 'legacy'.
SELECT tests.authenticate_as(:'tester_d_id'::uuid);
SELECT (public.start_or_resume_session()).id AS session_d2 \gset
SELECT tests.clear_auth();

SELECT is(:'session_d2'::uuid, :'session_d1'::uuid, 'B1: resuming returns the SAME session (no second session created)');
SELECT is(
  (SELECT engine_version FROM public.sessions WHERE id = :'session_d1'::uuid),
  'legacy', 'B2: the resumed session''s engine_version is still legacy -- rollout admission while active changed nothing'
);
SELECT is(
  (SELECT resume_count FROM public.sessions WHERE id = :'session_d1'::uuid),
  1, 'B3: resume_count was bumped by the resume (confirms start_or_resume_session really took the resume branch, not a fresh insert)'
);

-- =========================================================================
-- Section C: finish_session() abandons a v1 session's OPEN claim.
-- =========================================================================

SELECT tests.authenticate_as_service_role();
INSERT INTO public.learning_engine_v1_rollout (user_id) VALUES (:'tester_e_id'::uuid);
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_e_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_e \gset
SELECT (public.start_or_resume_session()).id AS session_e \gset
SELECT tests.clear_auth();

SELECT is(
  (SELECT engine_version FROM public.sessions WHERE id = :'session_e'::uuid),
  'v1', 'C0: session_e is a v1 session (sanity check before claiming)'
);

SELECT id AS card_e1 FROM public.cards WHERE deck_id = :'deck_e'::uuid ORDER BY sort_order LIMIT 1 \gset

SELECT tests.authenticate_as_service_role();

-- Lazily creates user_deck_learning_state (RC-B precedent) -- required
-- before claim_next_learning_engine_card() can run.
SELECT public.get_learning_engine_v1_scheduler_snapshot(:'tester_e_id'::uuid, :'session_e'::uuid);

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

SELECT pg_temp.claim(:'tester_e_id', :'session_e', :'deck_e', 0, 0, :'card_e1') AS claim_result_e \gset
SELECT (:'claim_result_e'::jsonb -> 'claim' ->> 'id')::uuid AS claim_e1 \gset

SELECT tests.clear_auth();

SELECT is(
  (SELECT status FROM public.selection_claims WHERE id = :'claim_e1'::uuid),
  'OPEN', 'C1: the claim is OPEN before finish'
);

-- Snapshot scheduler_position/revision BEFORE finish, to prove
-- abandonment never advances them.
SELECT scheduler_position AS sched_pos_before, scheduler_revision AS sched_rev_before
  FROM public.user_deck_learning_state WHERE user_id = :'tester_e_id'::uuid AND deck_id = :'deck_e'::uuid \gset
SELECT (SELECT count(*)::integer FROM public.learning_engine_selection_traces WHERE id = (SELECT selection_trace_id FROM public.selection_claims WHERE id = :'claim_e1'::uuid)) AS trace_count_before \gset

SELECT tests.authenticate_as(:'tester_e_id'::uuid);
SELECT public.finish_session(:'session_e'::uuid);
SELECT tests.clear_auth();

SELECT is(
  (SELECT status FROM public.selection_claims WHERE id = :'claim_e1'::uuid),
  'ABANDONED', 'C2: explicit finish transitions the OPEN claim to ABANDONED'
);
SELECT isnt(
  (SELECT closed_at FROM public.selection_claims WHERE id = :'claim_e1'::uuid),
  NULL, 'C3: closed_at is set on abandonment'
);
SELECT is(
  (SELECT scheduler_position FROM public.user_deck_learning_state WHERE user_id = :'tester_e_id'::uuid AND deck_id = :'deck_e'::uuid),
  :'sched_pos_before'::integer, 'C4: abandonment never advances scheduler_position'
);
SELECT is(
  (SELECT scheduler_revision FROM public.user_deck_learning_state WHERE user_id = :'tester_e_id'::uuid AND deck_id = :'deck_e'::uuid),
  :'sched_rev_before'::integer, 'C5: abandonment never advances scheduler_revision'
);
SELECT is(
  (SELECT count(*)::integer FROM public.learning_engine_selection_traces WHERE id = (SELECT selection_trace_id FROM public.selection_claims WHERE id = :'claim_e1'::uuid)),
  :'trace_count_before'::integer, 'C6: abandonment never deletes the linked SelectionTrace -- "selected but never answered", not "never happened"'
);
SELECT is(
  (SELECT count(*)::integer FROM public.answer_events WHERE card_id = :'card_e1'::uuid AND session_id = :'session_e'::uuid),
  0, 'C7: abandonment never creates an answer_events row -- no answer was applied'
);
SELECT is(
  (SELECT status FROM public.sessions WHERE id = :'session_e'::uuid),
  'completed', 'C8: the session itself is completed by finish_session(), same as before RC-D'
);

-- C9: no second claim after the session is finished -- claim_next_learning_engine_card()
-- re-validates `status = 'active'` independently and rejects an inactive session.
SELECT tests.authenticate_as_service_role();
SELECT tests.throws_sqlstate(
  format(
    $sql$select pg_temp.claim(%L, %L, %L, 0, 0, %L)$sql$,
    :'tester_e_id', :'session_e', :'deck_e', :'card_e1'
  ),
  '42501', 'C9: claiming against a finished session is rejected'
);
SELECT tests.clear_auth();

-- =========================================================================
-- Section D: finish_session() on a LEGACY session is unaffected (no
-- selection_claims involvement at all).
-- =========================================================================
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT public.finish_session(:'session_a'::uuid);
SELECT tests.clear_auth();

SELECT is(
  (SELECT status FROM public.sessions WHERE id = :'session_a'::uuid),
  'completed', 'D1: finish_session() on a legacy session still completes it normally'
);
SELECT is(
  (SELECT count(*)::integer FROM public.selection_claims WHERE session_id = :'session_a'::uuid),
  0, 'D2: a legacy session never has any selection_claims rows, before or after finish'
);

-- =========================================================================
-- Section E: admit_user_to_learning_engine_v1() grants and idempotency.
-- =========================================================================

SELECT tests.authenticate_as_service_role();

SELECT is(
  (SELECT count(*)::integer FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_f_id'::uuid),
  0, 'E1: tester_f has no rollout row yet'
);
SELECT public.admit_user_to_learning_engine_v1(:'tester_f_id'::uuid);
SELECT is(
  (SELECT count(*)::integer FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_f_id'::uuid),
  1, 'E2: admit_user_to_learning_engine_v1 inserts exactly one row'
);
-- E3: idempotent -- calling it again is a safe no-op, still exactly one row.
SELECT public.admit_user_to_learning_engine_v1(:'tester_f_id'::uuid);
SELECT is(
  (SELECT count(*)::integer FROM public.learning_engine_v1_rollout WHERE user_id = :'tester_f_id'::uuid),
  1, 'E3: calling admit_user_to_learning_engine_v1 twice is idempotent'
);

SELECT tests.throws_sqlstate(
  format('select public.admit_user_to_learning_engine_v1(%L)', :'admin_id'),
  '28000', 'E4: admit_user_to_learning_engine_v1 rejects a non-tester (admin) account'
);

SELECT tests.clear_auth();

-- E5: no normal authenticated tester can self-enroll -- EXECUTE was never
-- granted to `authenticated` at all (42501, permission denied).
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT tests.throws_sqlstate(
  format('select public.admit_user_to_learning_engine_v1(%L)', :'tester_a_id'),
  '42501', 'E5: an authenticated tester cannot call admit_user_to_learning_engine_v1 directly'
);
SELECT tests.clear_auth();

-- =========================================================================
-- Section F: a normal authenticated tester cannot forge engine_version
-- (pre-existing table-grant guarantee, re-confirmed as an RC-D regression
-- guard -- `sessions` has never granted authenticated any write at all).
-- =========================================================================
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT tests.throws_sqlstate(
  format('update public.sessions set engine_version = %L where id = %L', 'v1', :'session_a'),
  '42501', 'F1: an authenticated tester cannot directly UPDATE sessions.engine_version'
);
SELECT tests.clear_auth();

SELECT * FROM finish();
ROLLBACK;
