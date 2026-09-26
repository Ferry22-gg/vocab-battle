\ir fixtures/000_test_helpers.inc

-- Group 13: get_next_session_card() (Phase F0, plus the Active Pool
-- target-size follow-up fix).
-- Maps to DATABASE_SCHEMA.md §4.4/4.6/4.7/9.1/10.3 ("Review-mode
-- validation" / "Learning-mode eligibility") / §11.

BEGIN;
SELECT plan(47);

SELECT gen_random_uuid() AS tester_a_id \gset
SELECT gen_random_uuid() AS tester_b_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS deck_i_id \gset

SELECT tests.create_test_profile(:'tester_a_id'::uuid, 'test_g13_tester_a');
SELECT tests.create_test_profile(:'tester_b_id'::uuid, 'test_g13_tester_b');

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS deck_a \gset
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS deck_b \gset
SELECT tests.clear_auth();

-- -----------------------------------------------------------------------
-- Part 0: grant layer (security) -- tester-facing read only, never
-- service_role, never anon/PUBLIC.
-- -----------------------------------------------------------------------
SELECT ok(
  has_function_privilege('authenticated', 'public.get_next_session_card(uuid)', 'EXECUTE'),
  'authenticated CAN execute get_next_session_card() (grant layer)'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.get_next_session_card(uuid)', 'EXECUTE'),
  'anon cannot execute get_next_session_card() (grant layer)'
);
SELECT ok(
  NOT has_function_privilege('service_role', 'public.get_next_session_card(uuid)', 'EXECUTE'),
  'service_role has no grant -- this is a tester/RLS-scoped read, not a service-role RPC'
);

CREATE ROLE tests_g13_probe_role NOLOGIN;
SELECT ok(
  NOT has_function_privilege('tests_g13_probe_role', 'public.get_next_session_card(uuid)', 'EXECUTE'),
  'PUBLIC has no EXECUTE on get_next_session_card() (probed via a role with no grants of its own)'
);

-- -----------------------------------------------------------------------
-- Part 1: RLS isolation -- a session id genuinely belonging to another
-- tester must never leak that user's existence or card content.
-- -----------------------------------------------------------------------
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT (public.start_or_resume_session(:'deck_a'::uuid)).id AS probe_session_a \gset
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT public.get_next_session_card(:'probe_session_a'::uuid) AS probe_result \gset
SELECT tests.clear_auth();

SELECT is(
  (:'probe_result')::jsonb ->> 'status', 'not_found',
  'tester B reading tester A''s session_id gets not_found, never another user''s card content'
);

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT public.finish_session(:'probe_session_a'::uuid);
SELECT tests.clear_auth();

SELECT is(
  (SELECT status FROM public.sessions WHERE id = :'probe_session_a'::uuid),
  'completed', 'probe session A finished/cleaned up before the real review scenario below'
);

-- -----------------------------------------------------------------------
-- Part 2: Review mode -- returns the earliest incomplete queue_order,
-- correctly skips completed/requeued rows, matches actual card content,
-- and this function never performs the Review -> Learning transition
-- itself (only observes it once commit_answer_transaction() has already
-- done it).
-- -----------------------------------------------------------------------
SELECT id AS card_r1 FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
SELECT id AS card_r2 FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 1 \gset
SELECT id AS card_r3 FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 2 \gset

UPDATE public.user_card_progress
   SET card_status = 'LEARNED', seen_count = 5, correct_streak = 4, fsrs_due_at = now() - interval '3 days'
 WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_r1'::uuid;
UPDATE public.user_card_progress
   SET card_status = 'LEARNED', seen_count = 5, correct_streak = 4, fsrs_due_at = now() - interval '2 days'
 WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_r2'::uuid;
UPDATE public.user_card_progress
   SET card_status = 'LEARNED', seen_count = 5, correct_streak = 4, fsrs_due_at = now() - interval '1 day'
 WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card_r3'::uuid;

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT (public.start_or_resume_session(:'deck_a'::uuid)).id AS session_a \gset
SELECT tests.clear_auth();

SELECT is(
  (SELECT current_mode FROM public.sessions WHERE id = :'session_a'::uuid),
  'review', 'session A starts in review mode with 3 due LEARNED cards'
);

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT public.get_next_session_card(:'session_a'::uuid) AS next1 \gset
SELECT tests.clear_auth();

SELECT is((:'next1')::jsonb ->> 'status', 'ok', 'review: status ok when an incomplete row exists');
SELECT is((:'next1')::jsonb ->> 'session_mode', 'review', 'review: session_mode reflects the session');
SELECT is((:'next1')::jsonb ->> 'card_id', :'card_r1', 'review: returns the earliest queue_order (card_r1) first');
SELECT is(
  (:'next1')::jsonb ->> 'front', (SELECT front FROM public.cards WHERE id = :'card_r1'::uuid),
  'review: returned front matches the actual card row'
);
SELECT is(
  (:'next1')::jsonb ->> 'back', (SELECT back FROM public.cards WHERE id = :'card_r1'::uuid),
  'review: returned back matches the actual card row'
);

-- First Wrong on card_r1 requeues it to the back (still incomplete) --
-- confirm get_next_session_card skips it and returns card_r2 next.
SELECT tests.authenticate_as_service_role();
SELECT tests.call_commit_answer(gen_random_uuid(), :'tester_a_id'::uuid, :'session_a'::uuid, :'card_r1'::uuid, false, 'review');
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT public.get_next_session_card(:'session_a'::uuid) AS next2 \gset
SELECT tests.clear_auth();

SELECT is(
  (:'next2')::jsonb ->> 'card_id', :'card_r2',
  'review: after card_r1 requeues (first Wrong), get_next_session_card skips it and returns card_r2'
);

-- Correct on card_r2 completes it; card_r3 is next, and mode stays review
-- while any row remains open.
SELECT tests.authenticate_as_service_role();
SELECT tests.call_commit_answer(gen_random_uuid(), :'tester_a_id'::uuid, :'session_a'::uuid, :'card_r2'::uuid, true, 'review');
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT public.get_next_session_card(:'session_a'::uuid) AS next3 \gset
SELECT tests.clear_auth();

SELECT is((:'next3')::jsonb ->> 'card_id', :'card_r3', 'review: card_r2 completed -> next incomplete is card_r3');
SELECT is((:'next3')::jsonb ->> 'session_mode', 'review', 'review: mode stays review while card_r1/card_r3 remain open');

SELECT tests.authenticate_as_service_role();
SELECT tests.call_commit_answer(gen_random_uuid(), :'tester_a_id'::uuid, :'session_a'::uuid, :'card_r3'::uuid, true, 'review');
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT public.get_next_session_card(:'session_a'::uuid) AS next4 \gset
SELECT tests.clear_auth();

SELECT is((:'next4')::jsonb ->> 'card_id', :'card_r1', 'review: card_r3 completed -> only the requeued card_r1 remains open');
SELECT is((:'next4')::jsonb ->> 'session_mode', 'review', 'review: mode is still review -- card_r1 is the last open row');

-- Second Wrong on card_r1 -> FORGOTTEN, completes the review queue, and
-- commit_answer_transaction() itself (never this function) flips
-- current_mode to learning.
SELECT tests.authenticate_as_service_role();
SELECT tests.call_commit_answer(gen_random_uuid(), :'tester_a_id'::uuid, :'session_a'::uuid, :'card_r1'::uuid, false, 'review');
SELECT tests.clear_auth();

SELECT is(
  (SELECT current_mode FROM public.sessions WHERE id = :'session_a'::uuid),
  'learning', 'review queue now empty -- commit_answer_transaction() flipped the session to learning'
);

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT public.get_next_session_card(:'session_a'::uuid) AS next5 \gset
SELECT tests.clear_auth();

SELECT is((:'next5')::jsonb ->> 'status', 'ok', 'learning: status ok once the session is in learning mode');
SELECT is((:'next5')::jsonb ->> 'session_mode', 'learning', 'learning: session_mode reflects the flipped mode');
SELECT is(
  (:'next5')::jsonb ->> 'card_id', :'card_r1',
  'learning: FORGOTTEN card_r1 outranks LEARNED card_r2/card_r3 (excluded entirely) by Active Pool priority'
);

-- -----------------------------------------------------------------------
-- Part 3: malformed session state is surfaced, never fabricated.
-- -----------------------------------------------------------------------
UPDATE public.sessions SET current_enemy_hp = null WHERE id = :'session_a'::uuid;

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT public.get_next_session_card(:'session_a'::uuid) AS next_malformed \gset
SELECT tests.clear_auth();

SELECT is((:'next_malformed')::jsonb ->> 'status', 'error', 'malformed session (null enemy_hp) returns status error');
SELECT is(
  (:'next_malformed')::jsonb ->> 'reason', 'SESSION_MISSING_BATTLE_STATE',
  'malformed session reason is SESSION_MISSING_BATTLE_STATE'
);

UPDATE public.sessions SET current_enemy_hp = current_enemy_max_hp WHERE id = :'session_a'::uuid;
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT public.finish_session(:'session_a'::uuid);
SELECT tests.clear_auth();

-- -----------------------------------------------------------------------
-- Part 4: Learning mode -- NEW-tier deterministic tie-break, no-mutation,
-- consistency with commit_answer_transaction(), and cooldown exclusion.
-- Fresh tester/session: deck_b has no due reviews, so it starts directly
-- in learning mode.
-- -----------------------------------------------------------------------
SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT (public.start_or_resume_session(:'deck_b'::uuid)).id AS session_b \gset
SELECT tests.clear_auth();

SELECT is(
  (SELECT current_mode FROM public.sessions WHERE id = :'session_b'::uuid),
  'learning', 'session B has no due reviews -- starts directly in learning mode'
);

SELECT id AS card_b1 FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
SELECT id AS card_b2 FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 1 \gset

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT public.get_next_session_card(:'session_b'::uuid) AS nextb1 \gset
SELECT tests.clear_auth();

SELECT is(
  (:'nextb1')::jsonb ->> 'card_id', :'card_b1',
  'learning: among all-NEW cards, lowest sort_order wins the deterministic tie-break'
);

-- No-mutation: calling get_next_session_card twice with no answer
-- submitted in between must not change session/queue state at all.
SELECT learning_draw_index AS ldi_before, current_enemy_hp AS hp_before
  FROM public.sessions WHERE id = :'session_b'::uuid \gset
SELECT count(*)::int AS queue_rows_before FROM public.session_learning_queue WHERE session_id = :'session_b'::uuid \gset

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT public.get_next_session_card(:'session_b'::uuid) AS nextb1_again \gset
SELECT tests.clear_auth();

SELECT is((:'nextb1_again')::jsonb ->> 'card_id', :'card_b1', 'learning: repeating the read (no answer submitted) returns the same card');
SELECT is(
  (SELECT learning_draw_index FROM public.sessions WHERE id = :'session_b'::uuid),
  :'ldi_before'::int, 'reading get_next_session_card does not advance learning_draw_index'
);
SELECT is(
  (SELECT current_enemy_hp FROM public.sessions WHERE id = :'session_b'::uuid),
  :'hp_before'::int, 'reading get_next_session_card does not change enemy HP'
);
SELECT is(
  (SELECT count(*)::int FROM public.session_learning_queue WHERE session_id = :'session_b'::uuid),
  :'queue_rows_before'::int, 'reading get_next_session_card does not create/modify session_learning_queue rows'
);

-- Consistency: the exact card get_next_session_card returned is accepted
-- by commit_answer_transaction() under unchanged state.
SELECT tests.authenticate_as_service_role();
SELECT lives_ok(
  format('select tests.call_commit_answer(gen_random_uuid(), %L, %L, %L, true, %L)',
    :'tester_b_id', :'session_b', :'card_b1', 'learning'),
  'the card get_next_session_card returned is accepted by commit_answer_transaction() unchanged'
);
SELECT tests.clear_auth();

-- Cooldown: card_b1 was just answered Correct (next_eligible_draw_index =
-- 1 + 11 = 12) -- the very next read must not return it again.
SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT public.get_next_session_card(:'session_b'::uuid) AS nextb2 \gset
SELECT tests.clear_auth();

SELECT is(
  (:'nextb2')::jsonb ->> 'card_id', :'card_b2',
  'learning: card_b1 is excluded (on cooldown) -- the next eligible NEW card (card_b2) is returned instead'
);

-- -----------------------------------------------------------------------
-- Part 5: forced-reappearance overrides normal Active Pool priority.
-- card_bIntruder is pre-set to LEARNING (higher priority than NEW) with
-- no cooldown, so it WOULD win Gate 2 on priority alone -- proving Gate 1
-- (the forced reservation) is what actually decides the outcome.
-- Deterministic via the same pre-reserve-3-of-4-slots technique as
-- supabase/tests/008_commit_answer_transaction_test.sql Part 6.
-- -----------------------------------------------------------------------
SELECT id AS card_bforced FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 2 \gset
SELECT id AS card_bintruder FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 3 \gset
SELECT id AS card_bplaceholder1 FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 4 \gset
SELECT id AS card_bplaceholder2 FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 5 \gset
SELECT id AS card_bplaceholder3 FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 6 \gset

UPDATE public.user_card_progress
   SET card_status = 'LEARNING', seen_count = 1
 WHERE user_id = :'tester_b_id'::uuid AND card_id = :'card_bintruder'::uuid;

UPDATE public.sessions SET learning_draw_index = 200 WHERE id = :'session_b'::uuid;

-- Next new Learning answer draws at 200 + 1 = 201, so its possible
-- forced-reappear range is {207, 208, 209, 210}. Pre-reserve 3 of the 4
-- (as 3 other, uninvolved cards) so 210 is the only slot left free.
INSERT INTO public.session_learning_queue (session_id, card_id, forced_reappear_draw_index)
VALUES
  (:'session_b'::uuid, :'card_bplaceholder1'::uuid, 207),
  (:'session_b'::uuid, :'card_bplaceholder2'::uuid, 208),
  (:'session_b'::uuid, :'card_bplaceholder3'::uuid, 209);

SELECT tests.authenticate_as_service_role();
SELECT tests.call_commit_answer(gen_random_uuid(), :'tester_b_id'::uuid, :'session_b'::uuid, :'card_bforced'::uuid, false, 'learning');
SELECT tests.clear_auth();

-- Jump learning_draw_index (privileged) so the NEXT draw is exactly 210
-- (card_bforced's deterministically-collision-shifted reserved slot).
UPDATE public.sessions SET learning_draw_index = 209 WHERE id = :'session_b'::uuid;

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT public.get_next_session_card(:'session_b'::uuid) AS nextb_forced \gset
SELECT tests.clear_auth();

SELECT is(
  (:'nextb_forced')::jsonb ->> 'card_id', :'card_bforced',
  'learning: forced-reappearance reservation overrides card_bintruder''s higher (LEARNING) natural priority'
);

SELECT tests.authenticate_as_service_role();
SELECT tests.throws_sqlstate(
  format('select tests.call_commit_answer(gen_random_uuid(), %L, %L, %L, true, %L)',
    :'tester_b_id', :'session_b', :'card_bintruder', 'learning'),
  '22023',
  'consistency: the higher-priority card get_next_session_card did NOT return is rejected by commit_answer_transaction() at this draw'
);
SELECT lives_ok(
  format('select tests.call_commit_answer(gen_random_uuid(), %L, %L, %L, true, %L)',
    :'tester_b_id', :'session_b', :'card_bforced', 'learning'),
  'consistency: the reserved card get_next_session_card DID return is accepted at this exact draw'
);
SELECT tests.clear_auth();

-- -----------------------------------------------------------------------
-- Part 6: no-answerable-card reasons are distinguished -- "eligible cards
-- exist but all on cooldown" vs. "genuinely nothing eligible in the deck".
-- -----------------------------------------------------------------------
UPDATE public.user_card_progress ucp
   SET card_status = 'LEARNING', seen_count = greatest(ucp.seen_count, 1)
 WHERE ucp.user_id = :'tester_b_id'::uuid
   AND ucp.card_id IN (SELECT id FROM public.cards WHERE deck_id = :'deck_b'::uuid)
   AND ucp.card_status <> 'LEARNED';

SELECT learning_draw_index FROM public.sessions WHERE id = :'session_b'::uuid \gset

INSERT INTO public.session_learning_queue (session_id, card_id, next_eligible_draw_index)
SELECT :'session_b'::uuid, ucp.card_id, :'learning_draw_index'::int + 1000
FROM public.user_card_progress ucp
WHERE ucp.user_id = :'tester_b_id'::uuid
  AND ucp.card_id IN (SELECT id FROM public.cards WHERE deck_id = :'deck_b'::uuid)
  AND ucp.card_status IN ('NEW', 'LEARNING', 'FORGOTTEN')
ON CONFLICT (session_id, card_id) DO UPDATE
  SET next_eligible_draw_index = excluded.next_eligible_draw_index,
      forced_reappear_draw_index = null;

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT public.get_next_session_card(:'session_b'::uuid) AS nextb_cooldown \gset
SELECT tests.clear_auth();

SELECT is((:'nextb_cooldown')::jsonb ->> 'status', 'no_card', 'learning: every eligible card on cooldown -> status no_card');
SELECT is(
  (:'nextb_cooldown')::jsonb ->> 'reason', 'LEARNING_ALL_ON_COOLDOWN',
  'learning: reason is LEARNING_ALL_ON_COOLDOWN when eligible cards exist but all are currently blocked'
);

UPDATE public.user_card_progress
   SET card_status = 'LEARNED', seen_count = greatest(seen_count, 5), correct_streak = greatest(correct_streak, 4)
 WHERE user_id = :'tester_b_id'::uuid
   AND card_id IN (SELECT id FROM public.cards WHERE deck_id = :'deck_b'::uuid);

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT public.get_next_session_card(:'session_b'::uuid) AS nextb_none \gset
SELECT tests.clear_auth();

SELECT is((:'nextb_none')::jsonb ->> 'status', 'no_card', 'learning: deck fully LEARNED -> status no_card');
SELECT is(
  (:'nextb_none')::jsonb ->> 'reason', 'LEARNING_NO_ELIGIBLE_CARDS',
  'learning: reason is LEARNING_NO_ELIGIBLE_CARDS when nothing is status-eligible at all'
);

-- -----------------------------------------------------------------------
-- Part 7: Active Pool target size (F0 follow-up fix). NEW cards are
-- eligible only as refill while the effective pool (LEARNING+FORGOTTEN
-- count) has room below the ~30 target; FORGOTTEN remains eligible and
-- may push the effective pool above target ("not a hard cap" -- MVP_SPEC_
-- FOR_CLAUDE.md section 9 / DATABASE_SCHEMA.md 4.4/9.1). A fresh tester
-- keeps this fixture independent of every scenario above.
-- -----------------------------------------------------------------------
SELECT gen_random_uuid() AS tester_c_id \gset
SELECT tests.create_test_profile(:'tester_c_id'::uuid, 'test_g13_tester_c');

SELECT tests.authenticate_as(:'tester_c_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS deck_c \gset
SELECT (public.start_or_resume_session(:'deck_c'::uuid)).id AS session_c \gset
SELECT tests.clear_auth();

SELECT is(
  (SELECT current_mode FROM public.sessions WHERE id = :'session_c'::uuid),
  'learning', 'session C has no due reviews -- starts directly in learning mode'
);

-- Item 1: pool below target (5 LEARNING, all on cooldown) -- a NEW card
-- (the lowest-sort_order untouched card, card_c5) may still refill.
UPDATE public.user_card_progress ucp
   SET card_status = 'LEARNING', seen_count = 1
 WHERE ucp.user_id = :'tester_c_id'::uuid
   AND ucp.card_id IN (
     SELECT id FROM public.cards WHERE deck_id = :'deck_c'::uuid ORDER BY sort_order LIMIT 5 OFFSET 0
   );
INSERT INTO public.session_learning_queue (session_id, card_id, next_eligible_draw_index)
SELECT :'session_c'::uuid, id, 999
FROM public.cards WHERE deck_id = :'deck_c'::uuid ORDER BY sort_order LIMIT 5 OFFSET 0;

SELECT id AS card_c5 FROM public.cards WHERE deck_id = :'deck_c'::uuid ORDER BY sort_order LIMIT 1 OFFSET 5 \gset

SELECT tests.authenticate_as(:'tester_c_id'::uuid);
SELECT public.get_next_session_card(:'session_c'::uuid) AS nextc_below \gset
SELECT tests.clear_auth();

SELECT is(
  (:'nextc_below')::jsonb ->> 'status', 'ok',
  'pool below target (5/30): a card is still offered'
);
SELECT is(
  (:'nextc_below')::jsonb ->> 'card_id', :'card_c5',
  'pool below target (5/30): the lowest-sort_order NEW card (card_c5) refills, since the 5 LEARNING cards are all on cooldown'
);

-- Item 2: pool at target (30 LEARNING, all on cooldown) -- NEW is no
-- longer offered; the only legitimate outcome is no_card.
UPDATE public.user_card_progress ucp
   SET card_status = 'LEARNING', seen_count = 1
 WHERE ucp.user_id = :'tester_c_id'::uuid
   AND ucp.card_id IN (
     SELECT id FROM public.cards WHERE deck_id = :'deck_c'::uuid ORDER BY sort_order LIMIT 25 OFFSET 5
   );
INSERT INTO public.session_learning_queue (session_id, card_id, next_eligible_draw_index)
SELECT :'session_c'::uuid, id, 999
FROM public.cards WHERE deck_id = :'deck_c'::uuid ORDER BY sort_order LIMIT 25 OFFSET 5;

SELECT tests.authenticate_as(:'tester_c_id'::uuid);
SELECT public.get_next_session_card(:'session_c'::uuid) AS nextc_attarget \gset
SELECT tests.clear_auth();

SELECT is(
  (:'nextc_attarget')::jsonb ->> 'status', 'no_card',
  'pool at target (30/30), all on cooldown: NEW is not selected -- status no_card'
);
SELECT is(
  (:'nextc_attarget')::jsonb ->> 'reason', 'LEARNING_ALL_ON_COOLDOWN',
  'pool at target (30/30): reason is LEARNING_ALL_ON_COOLDOWN, confirming NEW was withheld by the pool-size gate rather than miscounted as ineligible'
);

-- Item 4: one LEARNING card becomes LEARNED (mastered) and leaves the
-- pool -- the freed slot (29/30) lets a NEW card refill again.
SELECT id AS card_c0 FROM public.cards WHERE deck_id = :'deck_c'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
UPDATE public.user_card_progress
   SET card_status = 'LEARNED', seen_count = 5, correct_streak = 4
 WHERE user_id = :'tester_c_id'::uuid AND card_id = :'card_c0'::uuid;

SELECT id AS card_c30 FROM public.cards WHERE deck_id = :'deck_c'::uuid ORDER BY sort_order LIMIT 1 OFFSET 30 \gset

SELECT tests.authenticate_as(:'tester_c_id'::uuid);
SELECT public.get_next_session_card(:'session_c'::uuid) AS nextc_freed \gset
SELECT tests.clear_auth();

SELECT is(
  (:'nextc_freed')::jsonb ->> 'status', 'ok',
  'one LEARNING card left the pool (now 29/30): a card is offered again'
);
SELECT is(
  (:'nextc_freed')::jsonb ->> 'card_id', :'card_c30',
  'one LEARNING card left the pool (now 29/30): the next NEW card (card_c30) refills the freed slot'
);

-- Item 3: FORGOTTEN cards remain eligible even once the pool (29 LEARNING
-- + 3 FORGOTTEN = 32) exceeds the 30 target -- "not a hard cap". Reuses
-- card_c30 (currently NEW, just returned above) plus two more, all
-- flipped to FORGOTTEN.
UPDATE public.user_card_progress ucp
   SET card_status = 'FORGOTTEN', seen_count = 5, correct_streak = 0
 WHERE ucp.user_id = :'tester_c_id'::uuid
   AND ucp.card_id IN (
     SELECT id FROM public.cards WHERE deck_id = :'deck_c'::uuid ORDER BY sort_order LIMIT 3 OFFSET 30
   );

SELECT tests.authenticate_as(:'tester_c_id'::uuid);
SELECT public.get_next_session_card(:'session_c'::uuid) AS nextc_forgotten \gset
SELECT tests.clear_auth();

SELECT is(
  (:'nextc_forgotten')::jsonb ->> 'status', 'ok',
  'pool now above target (32/30) due to FORGOTTEN cards: a card is still offered'
);
SELECT is(
  (:'nextc_forgotten')::jsonb ->> 'card_id', :'card_c30',
  'pool above target due to FORGOTTEN: card_c30 (now FORGOTTEN) is selected -- FORGOTTEN is never blocked by the pool-size gate'
);

SELECT * FROM finish();
ROLLBACK;
