\ir fixtures/000_test_helpers.sql

-- Group 8: commit_answer_transaction() integrity guarantees.
-- Maps to DATABASE_SCHEMA.md §17 / §10.3-10.5 / §11.
-- All commit_answer_transaction() calls run as service_role (10.3, 10.6) --
-- never as `authenticated` -- via tests.authenticate_as_service_role().

BEGIN;
SELECT plan(42);

SELECT gen_random_uuid() AS tester_a_id \gset
SELECT gen_random_uuid() AS tester_b_id \gset
SELECT gen_random_uuid() AS admin_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS deck_i_id \gset

SELECT tests.create_test_profile(:'tester_a_id'::uuid, 'test_g8_tester_a');
SELECT tests.create_test_profile(:'tester_b_id'::uuid, 'test_g8_tester_b');
SELECT tests.create_test_profile(:'admin_id'::uuid, 'test_g8_admin', 'admin', 'active', true);

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS deck_a \gset
SELECT (public.start_or_resume_session()).id AS session1 \gset
SELECT tests.clear_auth();

SELECT id AS card1 FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
SELECT id AS card2 FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 1 \gset
SELECT id AS card3 FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 2 \gset
SELECT id AS card4 FROM public.cards WHERE deck_id = :'deck_a'::uuid ORDER BY sort_order LIMIT 1 OFFSET 3 \gset
SELECT gen_random_uuid() AS e1 \gset
SELECT gen_random_uuid() AS e2 \gset
SELECT gen_random_uuid() AS e3 \gset
SELECT gen_random_uuid() AS e4 \gset

SELECT tests.authenticate_as_service_role();

-- -----------------------------------------------------------------------
-- Part 1: fresh valid answer, replay, no double-application
-- -----------------------------------------------------------------------
SELECT tests.call_commit_answer(:'e1'::uuid, :'tester_a_id'::uuid, :'session1'::uuid, :'card1'::uuid, true) AS r1 \gset
SELECT is((:'r1')::jsonb ->> 'is_replay', 'false', 'a fresh answer commits with is_replay = false');
SELECT is(
  (SELECT count(*)::int FROM public.answer_events WHERE client_event_id = :'e1'::uuid),
  1, 'exactly one answer_events row was inserted for the fresh client_event_id'
);
SELECT is(
  (SELECT seen_count FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card1'::uuid),
  1, 'seen_count advanced to 1 after the fresh answer'
);
SELECT is(
  (SELECT correct_streak FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card1'::uuid),
  1, 'correct_streak advanced to 1 after the fresh Correct answer'
);

SELECT total_xp AS xp_after_first FROM public.profiles WHERE id = :'tester_a_id'::uuid \gset

-- replay: same client_event_id, must not double-apply
SELECT tests.call_commit_answer(:'e1'::uuid, :'tester_a_id'::uuid, :'session1'::uuid, :'card1'::uuid, true) AS r2 \gset
SELECT is((:'r2')::jsonb ->> 'is_replay', 'true', 'resubmitting the same client_event_id replays instead of re-applying');
SELECT is(
  (SELECT seen_count FROM public.user_card_progress WHERE user_id = :'tester_a_id'::uuid AND card_id = :'card1'::uuid),
  1, 'seen_count is unchanged by the replay (not double-applied)'
);
SELECT is(
  (SELECT total_xp FROM public.profiles WHERE id = :'tester_a_id'::uuid),
  :'xp_after_first'::int, 'total_xp is unchanged by the replay (XP not double-awarded)'
);

-- -----------------------------------------------------------------------
-- Part 2: stale pre-answer snapshot -> SQLSTATE 40001
-- -----------------------------------------------------------------------
SELECT current_enemy_hp AS s1_hp, current_combo AS s1_combo, learning_draw_index AS s1_ldi
  FROM public.sessions WHERE id = :'session1'::uuid \gset

SELECT throws_ok(
  format(
    $sql$select public.commit_answer_transaction(
      p_client_event_id => %L, p_user_id => %L, p_session_id => %L, p_card_id => %L,
      p_expected_card_status_before => 'NEW', p_expected_seen_count_before => 999,
      p_expected_correct_streak_before => 0, p_expected_wrong_streak_before => 0,
      p_expected_fsrs_due_before => null,
      p_expected_session_enemy_hp_before => %L, p_expected_session_combo_before => %L,
      p_expected_session_learning_draw_index => %L,
      p_correct => true, p_response_time_ms => 1000, p_session_mode => 'learning',
      p_fsrs_rating => 'Good', p_fsrs_due_at => now(), p_fsrs_stability => 2.5, p_fsrs_difficulty => 5.0,
      p_fsrs_elapsed_days => 0, p_fsrs_scheduled_days => 1, p_fsrs_reps => 1, p_fsrs_lapses => 0,
      p_fsrs_learning_steps => 0, p_fsrs_state => 2, p_fsrs_last_review_at => now(),
      p_base_damage => 10, p_speed_bonus => 0, p_critical => false, p_combo_after => 1,
      p_damage => 10, p_enemy_hp_after => %L, p_enemy_defeated => false
    )$sql$,
    :'e2', :'tester_a_id', :'session1', :'card2',
    :'s1_hp', :'s1_combo', :'s1_ldi',
    (:'s1_hp')::int - 10
  ),
  '40001',
  'a stale pre-answer snapshot (wrong expected_seen_count_before) is rejected with SQLSTATE 40001'
);

-- -----------------------------------------------------------------------
-- Part 3: admin learner answer persistence is rejected
-- -----------------------------------------------------------------------
SELECT throws_ok(
  format(
    $sql$select public.commit_answer_transaction(
      p_client_event_id => gen_random_uuid(), p_user_id => %L,
      p_session_id => gen_random_uuid(), p_card_id => gen_random_uuid(),
      p_expected_card_status_before => 'NEW', p_expected_seen_count_before => 0,
      p_expected_correct_streak_before => 0, p_expected_wrong_streak_before => 0,
      p_expected_fsrs_due_before => null,
      p_expected_session_enemy_hp_before => 90, p_expected_session_combo_before => 0,
      p_expected_session_learning_draw_index => 0,
      p_correct => true, p_response_time_ms => 1000, p_session_mode => 'learning',
      p_fsrs_rating => 'Good', p_fsrs_due_at => now(), p_fsrs_stability => 2.5, p_fsrs_difficulty => 5.0,
      p_fsrs_elapsed_days => 0, p_fsrs_scheduled_days => 1, p_fsrs_reps => 1, p_fsrs_lapses => 0,
      p_fsrs_learning_steps => 0, p_fsrs_state => 2, p_fsrs_last_review_at => now(),
      p_base_damage => 20, p_speed_bonus => 0, p_critical => false, p_combo_after => 1,
      p_damage => 20, p_enemy_hp_after => 70, p_enemy_defeated => false
    )$sql$,
    :'admin_id'
  ),
  '28000',
  'admin cannot persist a learner answer through commit_answer_transaction()'
);

-- -----------------------------------------------------------------------
-- Part 3b: the EXECUTE-grant layer itself (DATABASE_SCHEMA.md §17:
-- "commit_answer_transaction() is not executable by PUBLIC, anon, or
-- authenticated -- only by the future trusted server-only caller").
-- This is a DIFFERENT guarantee from Part 3 above: Part 3 proves the
-- function's own internal tester/role check rejects an admin's user_id
-- when called BY service_role; this proves the Postgres EXECUTE
-- privilege itself is absent for every other role, independent of what
-- p_user_id would have been passed. has_function_privilege() inspects
-- the grant directly, without invoking the function body at all, so it
-- cannot be confused with the internal validation Part 3 covers.
-- -----------------------------------------------------------------------
SELECT ok(
  has_function_privilege('service_role', 'public.commit_answer_transaction(
    uuid, uuid, uuid, uuid,
    text, integer, integer, integer, timestamptz, integer, integer, integer,
    boolean, integer, text,
    text, timestamptz, double precision, double precision, integer, integer, integer, integer, integer, integer, timestamptz,
    integer, integer, boolean, integer, integer, integer, boolean, text, integer, integer
  )', 'EXECUTE'),
  'service_role CAN execute commit_answer_transaction() (grant layer)'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.commit_answer_transaction(
    uuid, uuid, uuid, uuid,
    text, integer, integer, integer, timestamptz, integer, integer, integer,
    boolean, integer, text,
    text, timestamptz, double precision, double precision, integer, integer, integer, integer, integer, integer, timestamptz,
    integer, integer, boolean, integer, integer, integer, boolean, text, integer, integer
  )', 'EXECUTE'),
  'anon cannot execute commit_answer_transaction() (grant layer)'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.commit_answer_transaction(
    uuid, uuid, uuid, uuid,
    text, integer, integer, integer, timestamptz, integer, integer, integer,
    boolean, integer, text,
    text, timestamptz, double precision, double precision, integer, integer, integer, integer, integer, integer, timestamptz,
    integer, integer, boolean, integer, integer, integer, boolean, text, integer, integer
  )', 'EXECUTE'),
  'authenticated cannot execute commit_answer_transaction() (grant layer, not the internal role check)'
);

-- PUBLIC has no grant of its own: probe with a throwaway role that has no
-- explicit grants at all (CREATE ROLE is transactional, so this never
-- outlives this file's BEGIN/ROLLBACK). If PUBLIC had EXECUTE, this role
-- would inherit it despite having no grant of its own. CREATE ROLE needs
-- CREATEROLE/superuser -- service_role has neither, so this must run as
-- the privileged connecting role, not as service_role (has_function_
-- privilege() itself is a plain information function and needs no
-- specific active role, so this switch only matters for CREATE ROLE).
SELECT tests.clear_auth();
CREATE ROLE tests_g8_probe_role NOLOGIN;
SELECT ok(
  NOT has_function_privilege('tests_g8_probe_role', 'public.commit_answer_transaction(
    uuid, uuid, uuid, uuid,
    text, integer, integer, integer, timestamptz, integer, integer, integer,
    boolean, integer, text,
    text, timestamptz, double precision, double precision, integer, integer, integer, integer, integer, integer, timestamptz,
    integer, integer, boolean, integer, integer, integer, boolean, text, integer, integer
  )', 'EXECUTE'),
  'PUBLIC has no EXECUTE on commit_answer_transaction() (probed via a role with no grants of its own)'
);

-- Belt-and-suspenders: an actual live call attempt as authenticated is
-- rejected at the permission-check stage (42501), before the function
-- body -- and therefore its internal tester/role check -- ever runs.
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT throws_ok(
  $sql$select public.commit_answer_transaction(
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
    'NEW', 0, 0, 0, null, 90, 0, 0,
    true, 1000, 'learning',
    'Good', now(), 2.5, 5.0, 0, 1, 1, 0, 0, 2, now(),
    20, 0, false, 1, 20, 70, false
  )$sql$,
  '42501',
  'a live call attempt as authenticated is rejected by the EXECUTE grant itself'
);
SELECT tests.clear_auth();
SELECT tests.authenticate_as_service_role();

-- -----------------------------------------------------------------------
-- Part 4: a Wrong answer cannot claim inconsistent damage/critical
-- -----------------------------------------------------------------------
SELECT throws_ok(
  format(
    'select tests.call_commit_answer(%L, %L, %L, %L, false, %L, 1500, null, 10)',
    :'e3', :'tester_a_id', :'session1', :'card3', 'learning'
  ),
  '22023',
  'a Wrong answer claiming nonzero damage is rejected'
);
SELECT throws_ok(
  format(
    'select tests.call_commit_answer(%L, %L, %L, %L, false, %L, 1500, null, null, null, null, null, null, true)',
    :'e4', :'tester_a_id', :'session1', :'card4', 'learning'
  ),
  '22023',
  'a Wrong answer claiming critical = true is rejected'
);

-- -----------------------------------------------------------------------
-- Part 5: Review mode -- first Wrong requeues, second Wrong -> FORGOTTEN,
-- final review completion transitions the session to Learning
-- -----------------------------------------------------------------------
SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS deck_b \gset
SELECT tests.clear_auth();

SELECT id AS card_r1 FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
SELECT id AS card_r2 FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 1 \gset

-- Fixture setup (privileged, bypasses RLS): make two cards LEARNED and due
-- so the session starts in review mode with a fixed 2-card queue.
UPDATE public.user_card_progress
   SET card_status = 'LEARNED', fsrs_due_at = now() - interval '1 day', seen_count = 5, correct_streak = 4
 WHERE user_id = :'tester_b_id'::uuid AND card_id IN (:'card_r1'::uuid, :'card_r2'::uuid);

SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT (public.start_or_resume_session()).id AS session_r \gset
SELECT tests.clear_auth();

SELECT is(
  (SELECT current_mode FROM public.sessions WHERE id = :'session_r'::uuid),
  'review', 'a session with 2 due LEARNED cards starts in review mode'
);
SELECT is(
  (SELECT count(*)::int FROM public.session_review_cards WHERE session_id = :'session_r'::uuid),
  2, 'the fixed review queue contains exactly the 2 due cards'
);

SELECT tests.authenticate_as_service_role();

-- first Wrong on card_r1: requeues (moves to back), stays LEARNED
SELECT tests.call_commit_answer(gen_random_uuid(), :'tester_b_id'::uuid, :'session_r'::uuid, :'card_r1'::uuid, false, 'review');

SELECT is(
  (SELECT wrong_count FROM public.session_review_cards WHERE session_id = :'session_r'::uuid AND card_id = :'card_r1'::uuid),
  1, 'first Wrong in the review portion sets wrong_count = 1'
);
SELECT is(
  (SELECT completed FROM public.session_review_cards WHERE session_id = :'session_r'::uuid AND card_id = :'card_r1'::uuid),
  false, 'first Wrong does not complete the review-queue row'
);
SELECT is(
  (SELECT queue_order FROM public.session_review_cards WHERE session_id = :'session_r'::uuid AND card_id = :'card_r1'::uuid),
  2, 'first Wrong moves the card to the back of the review queue'
);
SELECT is(
  (SELECT card_status FROM public.user_card_progress WHERE user_id = :'tester_b_id'::uuid AND card_id = :'card_r1'::uuid),
  'LEARNED', 'first Wrong in a review portion does not change card_status'
);

-- Correct on card_r2: completes it, but card_r1 is still open -> no
-- mode transition yet
SELECT tests.call_commit_answer(gen_random_uuid(), :'tester_b_id'::uuid, :'session_r'::uuid, :'card_r2'::uuid, true, 'review');

SELECT is(
  (SELECT completed FROM public.session_review_cards WHERE session_id = :'session_r'::uuid AND card_id = :'card_r2'::uuid),
  true, 'a Correct review answer completes that card''s review-queue row'
);
SELECT is(
  (SELECT current_mode FROM public.sessions WHERE id = :'session_r'::uuid),
  'review', 'session stays in review mode while card_r1 is still incomplete'
);

-- second Wrong on card_r1: FORGOTTEN, completed, and this was the last
-- incomplete review row -> transitions the session to Learning
SELECT tests.call_commit_answer(gen_random_uuid(), :'tester_b_id'::uuid, :'session_r'::uuid, :'card_r1'::uuid, false, 'review');

SELECT is(
  (SELECT wrong_count FROM public.session_review_cards WHERE session_id = :'session_r'::uuid AND card_id = :'card_r1'::uuid),
  2, 'second Wrong in the review portion sets wrong_count = 2'
);
SELECT is(
  (SELECT completed FROM public.session_review_cards WHERE session_id = :'session_r'::uuid AND card_id = :'card_r1'::uuid),
  true, 'second Wrong completes the review-queue row'
);
SELECT is(
  (SELECT card_status FROM public.user_card_progress WHERE user_id = :'tester_b_id'::uuid AND card_id = :'card_r1'::uuid),
  'FORGOTTEN', 'second Wrong within one review portion transitions the card to FORGOTTEN'
);
SELECT is(
  (SELECT current_mode FROM public.sessions WHERE id = :'session_r'::uuid),
  'learning', 'completing the last review-queue row transitions the session to Learning'
);
SELECT ok(
  (SELECT reviews_completed_at FROM public.sessions WHERE id = :'session_r'::uuid) IS NOT NULL,
  'reviews_completed_at is stamped once the review portion finishes'
);

-- -----------------------------------------------------------------------
-- Part 6: Learning draw index, cooldown, forced reappearance, and
-- collision-shift uniqueness
-- -----------------------------------------------------------------------
SELECT is(
  (SELECT learning_draw_index FROM public.sessions WHERE id = :'session_r'::uuid),
  0, 'learning_draw_index is still 0 -- review answers never advance it'
);

SELECT id AS card_l1 FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 2 \gset
SELECT id AS card_l2 FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 3 \gset

SELECT gen_random_uuid() AS el1 \gset
SELECT tests.call_commit_answer(:'el1'::uuid, :'tester_b_id'::uuid, :'session_r'::uuid, :'card_l1'::uuid, true, 'learning');

SELECT is(
  (SELECT learning_draw_index FROM public.sessions WHERE id = :'session_r'::uuid),
  1, 'a new Correct Learning answer advances learning_draw_index to 1'
);
SELECT is(
  (SELECT next_eligible_draw_index FROM public.session_learning_queue
    WHERE session_id = :'session_r'::uuid AND card_id = :'card_l1'::uuid),
  12, 'a Correct Learning answer at draw 1 sets next_eligible_draw_index = 1 + 11'
);
SELECT ok(
  (SELECT forced_reappear_draw_index FROM public.session_learning_queue
    WHERE session_id = :'session_r'::uuid AND card_id = :'card_l1'::uuid) IS NULL,
  'a Correct Learning answer leaves forced_reappear_draw_index NULL'
);

SELECT gen_random_uuid() AS el2 \gset
SELECT tests.call_commit_answer(:'el2'::uuid, :'tester_b_id'::uuid, :'session_r'::uuid, :'card_l2'::uuid, false, 'learning');

SELECT is(
  (SELECT learning_draw_index FROM public.sessions WHERE id = :'session_r'::uuid),
  2, 'a new Wrong Learning answer advances learning_draw_index to 2'
);
SELECT ok(
  (SELECT forced_reappear_draw_index FROM public.session_learning_queue
    WHERE session_id = :'session_r'::uuid AND card_id = :'card_l2'::uuid) BETWEEN 8 AND 11,
  'a Wrong Learning answer at draw 2 schedules forced reappearance 6-9 draws later (between 8 and 11)'
);

-- replay: learning_draw_index must NOT advance again for an
-- already-processed client_event_id
SELECT tests.call_commit_answer(:'el2'::uuid, :'tester_b_id'::uuid, :'session_r'::uuid, :'card_l2'::uuid, false, 'learning') AS replay_result \gset
SELECT is((:'replay_result')::jsonb ->> 'is_replay', 'true', 'resubmitting el2 replays');
SELECT is(
  (SELECT learning_draw_index FROM public.sessions WHERE id = :'session_r'::uuid),
  2, 'learning_draw_index only advances on a NEW Learning answer, never on a replay'
);

-- Correct Learning cooldown is respected: card_l1 (next_eligible = 12)
-- cannot be answered again yet (we are only at draw 3)
SELECT throws_ok(
  format(
    'select tests.call_commit_answer(gen_random_uuid(), %L, %L, %L, true, %L)',
    :'tester_b_id', :'session_r', :'card_l1', 'learning'
  ),
  '22023',
  'answering a card still inside its Learning cooldown window is rejected'
);

-- -----------------------------------------------------------------------
-- Forced-position reservation enforcement + collision-shift, made
-- deterministic. (Review finding: the previous version blindly answered
-- a card at a fixed draw number that had a real, unguarded 25% chance of
-- colliding with card_l2's randomly-scheduled forced position, aborting
-- the whole transaction when it did -- not wrapped in throws_ok/lives_ok.)
--
-- Fix: jump learning_draw_index far past anything el1/el2 could have
-- scheduled (el2's max possible forced position is draw 2 + 9 = 11), then
-- PRE-RESERVE 3 of the 4 possible forced-reappear slots a fresh Wrong
-- answer at the new draw number could land on. Whichever of the 4 the
-- server's random() actually picks, commit_answer_transaction()'s real
-- collision-shift loop is guaranteed to walk it forward to the one
-- remaining free slot -- so the final position is 100% deterministic
-- regardless of the random draw, while still genuinely exercising the
-- production collision-shift code (not a reimplementation of it). The
-- learning_draw_index jump and the placeholder reservations are fixture
-- setup, done as the privileged role (tests.clear_auth()), matching the
-- pattern used for every other direct fixture mutation in this suite --
-- not as service_role, which is not verified to hold a direct write
-- grant on these tables (see the review-finding comment on
-- tests.authenticate_as_service_role() in fixtures/000_test_helpers.sql).
-- -----------------------------------------------------------------------
SELECT tests.clear_auth();
UPDATE public.sessions SET learning_draw_index = 100 WHERE id = :'session_r'::uuid;

SELECT id AS card_placeholder1 FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 4 \gset
SELECT id AS card_placeholder2 FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 5 \gset
SELECT id AS card_placeholder3 FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 6 \gset
SELECT id AS card_target FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 7 \gset
SELECT id AS card_intruder FROM public.cards WHERE deck_id = :'deck_b'::uuid ORDER BY sort_order LIMIT 1 OFFSET 8 \gset

-- The next new Learning answer draws at 100 + 1 = 101, so its possible
-- forced-reappear range is {107, 108, 109, 110}. Pre-reserve 3 of the 4
-- (as 3 other, uninvolved cards) so 110 is the only slot left free.
INSERT INTO public.session_learning_queue (session_id, card_id, forced_reappear_draw_index)
VALUES
  (:'session_r'::uuid, :'card_placeholder1'::uuid, 107),
  (:'session_r'::uuid, :'card_placeholder2'::uuid, 108),
  (:'session_r'::uuid, :'card_placeholder3'::uuid, 109);

SELECT tests.authenticate_as_service_role();
SELECT tests.call_commit_answer(gen_random_uuid(), :'tester_b_id'::uuid, :'session_r'::uuid, :'card_target'::uuid, false, 'learning');

SELECT is(
  (SELECT forced_reappear_draw_index FROM public.session_learning_queue
    WHERE session_id = :'session_r'::uuid AND card_id = :'card_target'::uuid),
  110, 'collision-shift deterministically walks the new Wrong answer forward to the one free slot (110), regardless of the random draw'
);

-- Reservation enforcement: jump learning_draw_index (privileged) so the
-- NEXT draw is exactly 110 (card_target's reserved slot), then confirm a
-- DIFFERENT card cannot be drawn into it.
SELECT tests.clear_auth();
UPDATE public.sessions SET learning_draw_index = 109 WHERE id = :'session_r'::uuid;
SELECT tests.authenticate_as_service_role();

SELECT throws_ok(
  format(
    'select tests.call_commit_answer(gen_random_uuid(), %L, %L, %L, true, %L)',
    :'tester_b_id', :'session_r', :'card_intruder', 'learning'
  ),
  '22023',
  'a different card cannot be drawn into a draw number reserved by another card''s forced reappearance'
);

-- ...but the card the reservation actually belongs to CAN be answered at
-- that exact draw -- the reservation is for that card, not a generic block
SELECT lives_ok(
  format('select tests.call_commit_answer(gen_random_uuid(), %L, %L, %L, true, %L)',
    :'tester_b_id', :'session_r', :'card_target', 'learning'),
  'the reserved card itself CAN be answered at its own forced-reappearance draw'
);
SELECT is(
  (SELECT learning_draw_index FROM public.sessions WHERE id = :'session_r'::uuid),
  110, 'learning_draw_index correctly reaches 110 after card_target is answered at its reserved draw'
);

SELECT tests.clear_auth();

SELECT * FROM finish();
ROLLBACK;
