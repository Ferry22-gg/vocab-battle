\ir fixtures/000_test_helpers.inc

-- Group 19: Learning Engine v1, Runtime Cutover RC-B (the Selection Claim
-- Transaction).
-- Maps to the RC-B task brief and supabase/migrations/
-- 20261009000000_learning_engine_v1_runtime_cutover_rc_b_selection_claim.sql.
--
-- Covers: the forward-only selection_trace_id uniqueness correction (A),
-- get_learning_engine_v1_scheduler_snapshot()'s session validation, lazy
-- user_deck_learning_state init, Daily Goal defaulting, non-deleted-card
-- filtering, and openClaim reflection (B), and
-- claim_next_learning_engine_card()'s full validation/concurrency/
-- idempotency/mutation-scoping contract (C).
--
-- Deliberately NOT covered here (RC-B scope boundary): chooseNextCard()
-- itself (already exhaustively unit-tested), and any live wiring --
-- nothing in this file touches app/session/*, get_next_session_card(), or
-- commit_answer_transaction().

BEGIN;
SELECT plan(65);

-- =========================================================================
-- Fixtures: four testers.
--   tester_a / deck_a / session_a (v1)  -- ownership/deck/card mismatch tests
--   tester_b / deck_b / session_b (legacy) -- legacy-session rejection
--   tester_c / deck_c / session_c (v1, then finished) -- inactive-session rejection
--   tester_d / deck_d / session_d (v1) -- the full successful-claim flow
-- =========================================================================

SELECT gen_random_uuid() AS tester_a_id \gset
SELECT gen_random_uuid() AS tester_b_id \gset
SELECT gen_random_uuid() AS tester_c_id \gset
SELECT gen_random_uuid() AS tester_d_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS official_deck_id \gset

SELECT tests.create_test_profile(:'tester_a_id'::uuid, 'test_g19_tester_a');
SELECT tests.create_test_profile(:'tester_b_id'::uuid, 'test_g19_tester_b');
SELECT tests.create_test_profile(:'tester_c_id'::uuid, 'test_g19_tester_c');
SELECT tests.create_test_profile(:'tester_d_id'::uuid, 'test_g19_tester_d');

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

SELECT tests.authenticate_as(:'tester_d_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_d \gset
SELECT (public.start_or_resume_session()).id AS session_d \gset
SELECT tests.clear_auth();

-- session_a/session_c/session_d become v1; session_b stays legacy
-- (default) for the legacy-rejection tests.
UPDATE public.sessions SET engine_version = 'v1' WHERE id IN (:'session_a'::uuid, :'session_c'::uuid, :'session_d'::uuid);

-- session_c is finished immediately -- an inactive v1 session.
SELECT tests.authenticate_as(:'tester_c_id'::uuid);
SELECT public.finish_session(:'session_c'::uuid);
SELECT tests.clear_auth();

SELECT id AS card_a1 FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
SELECT id AS card_a2 FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 1 \gset
SELECT id AS card_b1 FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
SELECT id AS card_d1 FROM public.cards WHERE deck_id = :'deck_d'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
SELECT id AS card_d2 FROM public.cards WHERE deck_id = :'deck_d'::uuid ORDER BY sort_order LIMIT 1 OFFSET 1 \gset
SELECT id AS card_d3 FROM public.cards WHERE deck_id = :'deck_d'::uuid ORDER BY sort_order LIMIT 1 OFFSET 2 \gset

-- Local test-only helper (pg_temp -- dropped automatically on ROLLBACK):
-- a thin wrapper around claim_next_learning_engine_card() so each
-- scenario only has to name the arguments it actually varies.
CREATE FUNCTION pg_temp.claim(
  p_user_id uuid,
  p_session_id uuid,
  p_deck_id uuid,
  p_expected_position integer,
  p_expected_revision integer,
  p_card_id uuid DEFAULT NULL,
  p_admitted_card_ids uuid[] DEFAULT '{}',
  p_first_pass_queue_before uuid[] DEFAULT NULL,
  p_first_pass_queue_after uuid[] DEFAULT NULL,
  p_shuffle_bag_before uuid[] DEFAULT NULL,
  p_shuffle_bag_after uuid[] DEFAULT NULL,
  p_trace_id uuid DEFAULT gen_random_uuid()
) RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT public.claim_next_learning_engine_card(
    p_user_id, p_session_id, p_deck_id,
    p_expected_position, p_expected_revision,
    p_card_id,
    CASE WHEN p_card_id IS NULL THEN NULL ELSE 'ACTIVE' END,
    'active_weighted_selection',
    p_admitted_card_ids,
    p_first_pass_queue_before, p_first_pass_queue_after,
    p_shuffle_bag_before, p_shuffle_bag_after,
    p_trace_id, now(), 'pre_goal_balanced',
    0, false, 0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    NULL, NULL, NULL,
    false, '{}'::double precision[],
    'learning-engine-v1.0', '{}'::jsonb
  );
$$;

SELECT tests.authenticate_as_service_role();

-- =========================================================================
-- Section A: forward-only correction -- selection_trace_id is now
-- DB-enforced 1:1 with selection_claims.
-- =========================================================================

SELECT gen_random_uuid() AS lone_trace_id \gset
SELECT public.insert_learning_engine_selection_trace(
  :'lone_trace_id', :'tester_a_id', :'deck_a', :'card_a1', :'session_a', now(),
  0, 0, 'ACTIVE', 'active_weighted_selection', 'pre_goal_balanced',
  0, false, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  null, null, null, '{}', null, null, null, null, false, '{}',
  'learning-engine-v1.0', '{}'::jsonb
);

SELECT tests.clear_auth();
SELECT lives_ok(
  format(
    $sql$insert into public.selection_claims (user_id, deck_id, session_id, card_id, selection_trace_id, scheduler_position, scheduler_revision, status)
         values (%L, %L, %L, %L, %L, 0, 1, 'ANSWERED')$sql$,
    :'tester_a_id', :'deck_a', :'session_a', :'card_a1', :'lone_trace_id'
  ),
  'A1: first claim referencing a trace is accepted'
);
SELECT tests.throws_sqlstate(
  format(
    $sql$insert into public.selection_claims (user_id, deck_id, session_id, card_id, selection_trace_id, scheduler_position, scheduler_revision, status)
         values (%L, %L, %L, %L, %L, 0, 1, 'ANSWERED')$sql$,
    :'tester_a_id', :'deck_a', :'session_a', :'card_a2', :'lone_trace_id'
  ),
  '23505', 'A2: a second claim referencing the SAME trace is rejected (forward-only 1:1 correction)'
);
-- Clean up this probe row so it does not interfere with Section C's
-- OPEN-claim-fast-path assertions against session_a later in this file.
DELETE FROM public.selection_claims WHERE selection_trace_id = :'lone_trace_id'::uuid;

SELECT tests.authenticate_as_service_role();

-- =========================================================================
-- Section B: get_learning_engine_v1_scheduler_snapshot()
-- =========================================================================

SELECT tests.throws_sqlstate(
  format('select public.get_learning_engine_v1_scheduler_snapshot(%L, gen_random_uuid())', :'tester_a_id'),
  '22023', 'B1: a non-existent session is rejected'
);
SELECT tests.throws_sqlstate(
  format('select public.get_learning_engine_v1_scheduler_snapshot(%L, %L)', :'tester_b_id', :'session_a'),
  '42501', 'B2: cross-user snapshot read is rejected'
);
SELECT tests.throws_sqlstate(
  format('select public.get_learning_engine_v1_scheduler_snapshot(%L, %L)', :'tester_c_id', :'session_c'),
  '42501', 'B3: an inactive (finished) session is rejected'
);
SELECT tests.throws_sqlstate(
  format('select public.get_learning_engine_v1_scheduler_snapshot(%L, %L)', :'tester_b_id', :'session_b'),
  '42501', 'B4: a legacy-engine session is rejected'
);

SELECT is(
  (SELECT count(*)::integer FROM public.user_deck_learning_state WHERE user_id = :'tester_d_id'::uuid AND deck_id = :'deck_d'::uuid),
  0, 'B5: no user_deck_learning_state row exists yet for deck_d (duplicated after the Phase 1 backfill ran)'
);

SELECT public.get_learning_engine_v1_scheduler_snapshot(:'tester_d_id'::uuid, :'session_d'::uuid) AS snapshot_d \gset

SELECT is(
  (SELECT count(*)::integer FROM public.user_deck_learning_state WHERE user_id = :'tester_d_id'::uuid AND deck_id = :'deck_d'::uuid),
  1, 'B6: the snapshot read lazily created a user_deck_learning_state row with already-correct defaults'
);
SELECT is(
  (SELECT scheduler_position FROM public.user_deck_learning_state WHERE user_id = :'tester_d_id'::uuid AND deck_id = :'deck_d'::uuid),
  0, 'B7: the lazily-created row starts at scheduler_position 0'
);
SELECT is(
  ((:'snapshot_d'::jsonb -> 'dailyGoal' ->> 'enemiesDefeatedToday')::integer),
  0, 'B8: dailyGoal defaults enemiesDefeatedToday to 0'
);
SELECT is(
  ((:'snapshot_d'::jsonb -> 'dailyGoal' ->> 'completed')::boolean),
  false, 'B9: dailyGoal defaults completed to false'
);
SELECT is(
  (jsonb_array_length(:'snapshot_d'::jsonb -> 'cards')),
  (SELECT count(*)::integer FROM public.cards WHERE deck_id = :'deck_d'::uuid AND deleted_at IS NULL),
  'B10: the snapshot returns every non-deleted card in the deck'
);
SELECT is(
  (:'snapshot_d'::jsonb -> 'openClaim'),
  'null'::jsonb, 'B11: openClaim is null when no OPEN claim exists for the session'
);

-- B12: a soft-deleted card is excluded from the snapshot. Deliberately
-- run against its OWN dedicated, disposable tester/deck/session (never
-- deck_d) -- per the review correction (Section D below), soft-deleting
-- a card now itself bumps that deck's scheduler_revision, and deck_d's
-- own revision bookkeeping in Sections C/D depends on starting from a
-- known, pristine value. Isolating this snapshot-shape check keeps that
-- arithmetic simple and keeps card_d3 (used later as a genuinely live,
-- successfully-claimed card in Section D) undeleted.
SELECT tests.clear_auth();
SELECT gen_random_uuid() AS tester_e_id \gset
SELECT tests.create_test_profile(:'tester_e_id'::uuid, 'test_g19_tester_e');
SELECT tests.authenticate_as(:'tester_e_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS deck_e \gset
SELECT (public.start_or_resume_session()).id AS session_e \gset
SELECT tests.clear_auth();
UPDATE public.sessions SET engine_version = 'v1' WHERE id = :'session_e'::uuid;

SELECT id AS card_e1 FROM public.cards WHERE deck_id = :'deck_e'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset

SELECT tests.authenticate_as(:'tester_e_id'::uuid);
UPDATE public.cards SET deleted_at = now() WHERE id = :'card_e1'::uuid;
SELECT tests.clear_auth();
SELECT tests.authenticate_as_service_role();

SELECT public.get_learning_engine_v1_scheduler_snapshot(:'tester_e_id'::uuid, :'session_e'::uuid) AS snapshot_e \gset
SELECT is(
  (jsonb_array_length(:'snapshot_e'::jsonb -> 'cards')),
  (SELECT count(*)::integer FROM public.cards WHERE deck_id = :'deck_e'::uuid AND deleted_at IS NULL),
  'B12: a soft-deleted card no longer appears in the snapshot'
);

SELECT tests.clear_auth();
SELECT tests.authenticate_as(:'tester_d_id'::uuid);
SELECT tests.throws_sqlstate(
  format('select public.get_learning_engine_v1_scheduler_snapshot(%L, %L)', :'tester_d_id', :'session_d'),
  '42501', 'B13: authenticated has no EXECUTE grant on the snapshot function at all'
);
SELECT tests.clear_auth();
SELECT tests.authenticate_as_service_role();
-- =========================================================================
-- Section C: claim_next_learning_engine_card()
-- =========================================================================

-- C1-C5: ownership/session-state/deck/card validation.
SELECT tests.throws_sqlstate(
  format('select pg_temp.claim(%L, %L, %L, 0, 0, %L)', :'tester_b_id', :'session_a', :'deck_a', :'card_a1'),
  '42501', 'C1: cross-user claim is rejected'
);
SELECT tests.throws_sqlstate(
  format('select pg_temp.claim(%L, %L, %L, 0, 0)', :'tester_c_id', :'session_c', :'deck_c'),
  '42501', 'C2: an inactive (finished) session is rejected'
);
SELECT tests.throws_sqlstate(
  format('select pg_temp.claim(%L, %L, %L, 0, 0, %L)', :'tester_b_id', :'session_b', :'deck_b', :'card_b1'),
  '42501', 'C3: a legacy-engine session is rejected'
);
SELECT tests.throws_sqlstate(
  format('select pg_temp.claim(%L, %L, %L, 0, 0, %L)', :'tester_a_id', :'session_a', :'deck_b', :'card_a1'),
  '42501', 'C4: p_deck_id not matching the session''s own deck is rejected'
);
SELECT tests.throws_sqlstate(
  format('select pg_temp.claim(%L, %L, %L, 0, 0, %L)', :'tester_a_id', :'session_a', :'deck_a', :'card_b1'),
  '42501', 'C5: a selected card belonging to a different deck is rejected'
);

-- Lazily initialize deck_a's user_deck_learning_state row (mirrors the
-- real orchestrator: a snapshot read always precedes a claim attempt).
SELECT public.get_learning_engine_v1_scheduler_snapshot(:'tester_a_id'::uuid, :'session_a'::uuid);

-- C6-C7: the optimistic-concurrency token, checked while session_a still
-- has no OPEN claim at all (so the fast path cannot intercept these).
SELECT tests.throws_sqlstate(
  format('select pg_temp.claim(%L, %L, %L, 999, 0, %L)', :'tester_a_id', :'session_a', :'deck_a', :'card_a1'),
  '40001', 'C6: a stale expected scheduler_position is rejected'
);
SELECT tests.throws_sqlstate(
  format('select pg_temp.claim(%L, %L, %L, 0, 999, %L)', :'tester_a_id', :'session_a', :'deck_a', :'card_a1'),
  '40001', 'C7: a stale expected scheduler_revision is rejected'
);

-- C8-C11: entity validation, likewise checked before session_a has any
-- OPEN claim (so entity validation is actually reached, not shadowed by
-- the fast path -- an OPEN claim would intercept every subsequent call
-- for this session regardless of the arguments passed).
SELECT tests.throws_sqlstate(
  format('select pg_temp.claim(%L, %L, %L, 0, 0, NULL, ARRAY[%L]::uuid[])', :'tester_a_id', :'session_a', :'deck_a', :'card_b1'),
  '42501', 'C8: admitting a card that belongs to a DIFFERENT deck is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    'select pg_temp.claim(%L, %L, %L, 0, 0, NULL, ''{}'', NULL, ARRAY[%L]::uuid[])',
    :'tester_a_id', :'session_a', :'deck_a', :'card_b1'
  ),
  '42501', 'C9: a first-pass queue referencing a card from a different deck is rejected'
);
SELECT tests.throws_sqlstate(
  format(
    'select pg_temp.claim(%L, %L, %L, 0, 0, NULL, ''{}'', NULL, NULL, NULL, ARRAY[%L]::uuid[])',
    :'tester_a_id', :'session_a', :'deck_a', :'card_b1'
  ),
  '42501', 'C10: a shuffle bag referencing a card from a different deck is rejected'
);

-- Force card_a1 out of NEW status directly (simulating a card that has
-- since been answered) to prove admission validation checks card_status,
-- not merely deck membership.
UPDATE public.user_card_progress SET card_status = 'LEARNING', learning_stage = 'FRESH'
WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a1'::uuid;

SELECT tests.throws_sqlstate(
  format('select pg_temp.claim(%L, %L, %L, 0, 0, NULL, ARRAY[%L]::uuid[])', :'tester_a_id', :'session_a', :'deck_a', :'card_a1'),
  '42501', 'C11: admitting a card that is no longer NEW is rejected'
);

-- C12: a no-card decision with no other mutation persists a historical
-- trace but creates no claim and does not bump scheduler_revision (every
-- call above was rejected, so deck_a's state is still fully pristine:
-- position 0, revision 0).
SELECT gen_random_uuid() AS no_card_trace_id \gset
SELECT pg_temp.claim(:'tester_a_id', :'session_a', :'deck_a', 0, 0, NULL, '{}', NULL, NULL, NULL, NULL, :'no_card_trace_id') AS no_card_result \gset

SELECT is((:'no_card_result'::jsonb ->> 'reused')::boolean, false, 'C12a: a no-card decision reports reused=false');
SELECT is((:'no_card_result'::jsonb -> 'claim'), 'null'::jsonb, 'C12b: a no-card decision with no other mutation creates no claim');
SELECT is(
  (SELECT card_id FROM public.learning_engine_selection_traces WHERE id = :'no_card_trace_id'::uuid),
  NULL, 'C12c: the no-card trace is persisted with card_id = NULL'
);
SELECT is(
  (SELECT scheduler_revision FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid),
  0, 'C12d: scheduler_revision is unchanged after a no-card decision with no state mutation'
);
SELECT is(
  (SELECT count(*)::integer FROM public.selection_claims WHERE session_id = :'session_a'::uuid),
  0, 'C12e: no selection_claims row exists for session_a yet'
);

-- C13: a no-card decision that DOES admit a NEW card still bumps
-- scheduler_revision and admits the card, even though card_id is null
-- (brief section 10's literal rule -- a claim-time mutation is not only
-- "a card was claimed").
SELECT pg_temp.claim(:'tester_a_id', :'session_a', :'deck_a', 0, 0, NULL, ARRAY[:'card_a2']::uuid[]) AS admit_only_result \gset
SELECT is((:'admit_only_result'::jsonb -> 'claim'), 'null'::jsonb, 'C13a: admitting a card without selecting one still creates no claim');
SELECT is(
  (SELECT pool_status FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_a2'::uuid),
  'ACTIVE', 'C13b: the admitted card''s pool_status becomes ACTIVE'
);
SELECT is(
  (SELECT scheduler_revision FROM public.user_deck_learning_state WHERE user_id = :'tester_a_id'::uuid AND deck_id = :'deck_a'::uuid),
  1, 'C13c: scheduler_revision increments exactly once for the admission-only mutation'
);

-- C14-C25: the full successful-claim flow, against tester_d/deck_d/
-- session_d (lazily initialized already in Section B).
SELECT gen_random_uuid() AS claim_trace_id \gset
SELECT pg_temp.claim(
  :'tester_d_id', :'session_d', :'deck_d', 0, 0, :'card_d1',
  ARRAY[:'card_d2']::uuid[],
  NULL, ARRAY[:'card_d1', :'card_d2']::uuid[],
  NULL, ARRAY[:'card_d2']::uuid[],
  :'claim_trace_id'
) AS claim_result \gset

SELECT is((:'claim_result'::jsonb ->> 'reused')::boolean, false, 'C14: a successful new claim reports reused=false');
SELECT is((:'claim_result'::jsonb -> 'claim' ->> 'card_id')::uuid, :'card_d1'::uuid, 'C15: the claim row references the claimed card');
SELECT is((:'claim_result'::jsonb -> 'claim' ->> 'status'), 'OPEN', 'C16: the new claim is OPEN');
SELECT is((:'claim_result'::jsonb -> 'claim' ->> 'scheduler_position')::integer, 0, 'C17: scheduler_position is unchanged on the claim row (never advanced at claim time)');
SELECT is((:'claim_result'::jsonb -> 'claim' ->> 'scheduler_revision')::integer, 1, 'C18: the claim row carries the POST-claim scheduler_revision (1)');
SELECT is(
  (SELECT scheduler_position FROM public.user_deck_learning_state WHERE user_id = :'tester_d_id'::uuid AND deck_id = :'deck_d'::uuid),
  0, 'C19: deck_d''s scheduler_position remains unchanged after a successful claim'
);
SELECT is(
  (SELECT scheduler_revision FROM public.user_deck_learning_state WHERE user_id = :'tester_d_id'::uuid AND deck_id = :'deck_d'::uuid),
  1, 'C20: deck_d''s scheduler_revision increments by exactly 1'
);
SELECT is(
  (SELECT pool_status FROM public.user_card_progress WHERE user_id = :'tester_d_id'::uuid AND card_id = :'card_d2'::uuid),
  'ACTIVE', 'C21: the admitted card is persisted as ACTIVE'
);
SELECT is(
  (SELECT first_pass_queue FROM public.user_deck_learning_state WHERE user_id = :'tester_d_id'::uuid AND deck_id = :'deck_d'::uuid),
  to_jsonb(ARRAY[:'card_d1', :'card_d2']::uuid[]), 'C22: the first-pass queue persists exactly as decided'
);
SELECT is(
  (SELECT post_mastery_shuffle_bag_state FROM public.user_deck_learning_state WHERE user_id = :'tester_d_id'::uuid AND deck_id = :'deck_d'::uuid),
  to_jsonb(ARRAY[:'card_d2']::uuid[]), 'C23: the shuffle bag persists exactly as decided'
);
SELECT is(
  (SELECT scheduler_position FROM public.learning_engine_selection_traces WHERE id = :'claim_trace_id'::uuid),
  0, 'C24: SelectionTrace.scheduler_position records the PRE-claim value'
);
SELECT is(
  (SELECT scheduler_revision FROM public.learning_engine_selection_traces WHERE id = :'claim_trace_id'::uuid),
  0, 'C25: SelectionTrace.scheduler_revision records the PRE-claim value (section 13 semantics -- distinct from the claim''s own POST-claim revision)'
);

-- C26-C30: the OPEN-claim fast path -- retry converges on the SAME claim
-- while it is still OPEN, never creating a second trace/claim or bumping
-- revision again, even when the retry attempt names a DIFFERENT card and
-- passes an outdated expected revision.
SELECT gen_random_uuid() AS retry_trace_id \gset
SELECT pg_temp.claim(:'tester_d_id', :'session_d', :'deck_d', 0, 0, :'card_d3', '{}', NULL, NULL, NULL, NULL, :'retry_trace_id') AS retry_result \gset

SELECT is((:'retry_result'::jsonb ->> 'reused')::boolean, true, 'C26: the retry hits the OPEN-claim fast path');
SELECT is((:'retry_result'::jsonb -> 'claim' ->> 'card_id')::uuid, :'card_d1'::uuid, 'C27: the fast path returns the ORIGINAL claimed card, not the retry''s attempted card');
SELECT is(
  (SELECT count(*)::integer FROM public.selection_claims WHERE session_id = :'session_d'::uuid),
  1, 'C28: the retry created no second claim row'
);
SELECT is(
  (SELECT scheduler_revision FROM public.user_deck_learning_state WHERE user_id = :'tester_d_id'::uuid AND deck_id = :'deck_d'::uuid),
  1, 'C29: the retry did not bump scheduler_revision again'
);
SELECT is(
  (SELECT count(*)::integer FROM public.learning_engine_selection_traces WHERE id = :'retry_trace_id'::uuid),
  0, 'C30: the retry''s own trace was never persisted (fast path never calls insert_learning_engine_selection_trace)'
);

-- C31: once the claim is closed (simulating a future RC-C answer-commit),
-- the session no longer has an OPEN claim, so a genuinely stale-revision
-- attempt now correctly reaches the revision check and is rejected.
UPDATE public.selection_claims SET status = 'ANSWERED', closed_at = now()
WHERE session_id = :'session_d'::uuid AND status = 'OPEN';

SELECT tests.throws_sqlstate(
  format('select pg_temp.claim(%L, %L, %L, 0, 0, %L)', :'tester_d_id', :'session_d', :'deck_d', :'card_d3'),
  '40001', 'C31: a stale expected scheduler_revision is rejected once the prior claim is no longer OPEN'
);

-- C32: direct authenticated execute is rejected (the permission check
-- happens before any session/claim state is even read, so this holds
-- regardless of session_d's current claim status).
SELECT tests.clear_auth();
SELECT tests.authenticate_as(:'tester_d_id'::uuid);
SELECT tests.throws_sqlstate(
  format('select pg_temp.claim(%L, %L, %L, 0, 1, %L)', :'tester_d_id', :'session_d', :'deck_d', :'card_d3'),
  '42501', 'C32: authenticated has no EXECUTE grant on the claim function at all'
);
SELECT tests.clear_auth();

-- =========================================================================
-- Section D (review correction): scheduler_revision must also cover
-- changes to the SCHEDULABLE CARD SET itself (card insert / deleted_at
-- transition), not only changes to ids a decision referenced. Maps to
-- supabase/migrations/
-- 20261010000000_learning_engine_v1_runtime_cutover_rc_b_card_set_revision_bump.sql.
-- =========================================================================

-- D0: sanity baseline -- deck_d is at revision 1 here (the successful
-- claim in Section C's C14-C25; every subsequent attempt against
-- deck_d/session_d in Section C was rejected and mutated nothing).
SELECT is(
  (SELECT scheduler_revision FROM public.user_deck_learning_state WHERE user_id = :'tester_d_id'::uuid AND deck_id = :'deck_d'::uuid),
  1, 'D0: sanity baseline -- deck_d starts Section D at revision 1'
);

-- D1: adding a card (add_card_to_deck(), the real trusted write path)
-- bumps scheduler_revision by exactly 1.
SELECT tests.clear_auth();
SELECT tests.authenticate_as(:'tester_d_id'::uuid);
SELECT (public.add_card_to_deck(:'deck_d'::uuid, 'rc-b-section-d-front', 'rc-b-section-d-back')).id AS card_d_new \gset
SELECT tests.clear_auth();
SELECT tests.authenticate_as_service_role();

SELECT is(
  (SELECT scheduler_revision FROM public.user_deck_learning_state WHERE user_id = :'tester_d_id'::uuid AND deck_id = :'deck_d'::uuid),
  2, 'D1: add_card_to_deck() bumps scheduler_revision by exactly 1'
);

-- D2: soft-deleting a LIVE card (the direct authenticated deleted_at
-- UPDATE path) bumps scheduler_revision by exactly 1.
SELECT tests.clear_auth();
SELECT tests.authenticate_as(:'tester_d_id'::uuid);
UPDATE public.cards SET deleted_at = now() WHERE id = :'card_d_new'::uuid;
SELECT tests.clear_auth();
SELECT tests.authenticate_as_service_role();

SELECT is(
  (SELECT scheduler_revision FROM public.user_deck_learning_state WHERE user_id = :'tester_d_id'::uuid AND deck_id = :'deck_d'::uuid),
  3, 'D2: soft-deleting a live card bumps scheduler_revision by exactly 1'
);

-- D3: restoring that card (deleted_at -> NULL) bumps scheduler_revision
-- by exactly 1 again.
SELECT tests.clear_auth();
SELECT tests.authenticate_as(:'tester_d_id'::uuid);
UPDATE public.cards SET deleted_at = NULL WHERE id = :'card_d_new'::uuid;
SELECT tests.clear_auth();
SELECT tests.authenticate_as_service_role();

SELECT is(
  (SELECT scheduler_revision FROM public.user_deck_learning_state WHERE user_id = :'tester_d_id'::uuid AND deck_id = :'deck_d'::uuid),
  4, 'D3: restoring a soft-deleted card bumps scheduler_revision by exactly 1'
);

-- D4: an unrelated content edit (front text only, deleted_at untouched)
-- does NOT bump scheduler_revision.
SELECT tests.clear_auth();
SELECT tests.authenticate_as(:'tester_d_id'::uuid);
UPDATE public.cards SET front = 'rc-b-section-d-front-edited' WHERE id = :'card_d_new'::uuid;
SELECT tests.clear_auth();
SELECT tests.authenticate_as_service_role();

SELECT is(
  (SELECT scheduler_revision FROM public.user_deck_learning_state WHERE user_id = :'tester_d_id'::uuid AND deck_id = :'deck_d'::uuid),
  4, 'D4: an unrelated front-text edit does NOT bump scheduler_revision'
);

-- D5: a claim computed against the now-stale PRE-mutation revision (1)
-- is rejected -- proving the gap the review identified is now closed by
-- scheduler_revision itself, not merely by referenced-id revalidation.
-- card_d3 is never referenced by, nor does it overlap with, any of the
-- D1-D4 mutations above -- this proves the rejection is driven purely by
-- the card-SET change, not by any referenced-id conflict.
SELECT tests.throws_sqlstate(
  format('select pg_temp.claim(%L, %L, %L, 0, 1, %L)', :'tester_d_id', :'session_d', :'deck_d', :'card_d3'),
  '40001', 'D5: a claim computed against the pre-mutation revision (1) is rejected as stale, even though it never referenced the added/deleted/restored card at all'
);

-- D6: the orchestrator's own retry now succeeds against the CURRENT
-- revision (4) -- the DB side of "re-read, re-decide, retry". The
-- TypeScript retry MECHANISM itself (re-read, re-run chooseNextCard(),
-- see a changed card set in the re-decision) is unit-tested directly in
-- tests/unit/learning-engine-runtime-claim-next-card.test.ts.
SELECT pg_temp.claim(:'tester_d_id', :'session_d', :'deck_d', 0, 4, :'card_d3') AS fresh_claim_result \gset
SELECT is((:'fresh_claim_result'::jsonb ->> 'reused')::boolean, false, 'D6: a claim against the CURRENT revision (4) succeeds');
SELECT is((:'fresh_claim_result'::jsonb -> 'claim' ->> 'scheduler_revision')::integer, 5, 'D6b: the successful claim bumps revision to 5');

-- =========================================================================
-- Section E (review correction, item 10): legacy runtime is unaffected --
-- the new triggers fire unconditionally on every cards mutation, but must
-- be a true no-op for a tester who has never touched the v1 engine at
-- all (no user_deck_learning_state row exists for them).
-- =========================================================================
SELECT tests.clear_auth();
SELECT gen_random_uuid() AS legacy_tester_id \gset
SELECT tests.create_test_profile(:'legacy_tester_id'::uuid, 'test_g19_legacy_e');
SELECT tests.authenticate_as(:'legacy_tester_id'::uuid);
SELECT (public.duplicate_starter_deck(:'official_deck_id'::uuid)).id AS legacy_deck \gset
SELECT tests.clear_auth();

SELECT is(
  (SELECT count(*)::integer FROM public.user_deck_learning_state WHERE user_id = :'legacy_tester_id'::uuid),
  0, 'E0: sanity -- a pure-legacy tester has no user_deck_learning_state row at all'
);

SELECT tests.authenticate_as(:'legacy_tester_id'::uuid);
SELECT lives_ok(
  format('select public.add_card_to_deck(%L, %L, %L)', :'legacy_deck', 'legacy-front', 'legacy-back'),
  'E1: add_card_to_deck() still succeeds for a pure-legacy tester (the insert trigger no-ops safely with no matching row)'
);
SELECT id AS legacy_card FROM public.cards WHERE deck_id = :'legacy_deck'::uuid ORDER BY sort_order DESC LIMIT 1 \gset
SELECT lives_ok(
  format('update public.cards set deleted_at = now() where id = %L', :'legacy_card'),
  'E2: a direct soft-delete still succeeds for a pure-legacy tester (the delete-toggle trigger no-ops safely)'
);
SELECT tests.clear_auth();

SELECT is(
  (SELECT count(*)::integer FROM public.user_deck_learning_state WHERE user_id = :'legacy_tester_id'::uuid),
  0, 'E3: no user_deck_learning_state row was ever fabricated for the pure-legacy tester'
);

SELECT * FROM finish();
ROLLBACK;
