\ir fixtures/000_test_helpers.inc

-- Group 14: Learning-mode Wrong-answer reappearance FLOOR (F1 follow-up
-- product-rule change, 20260927000000_learning_wrong_reappearance_floor.sql).
--
-- Invariant under test: after a Wrong answer at Learning draw N, the card
-- must not be selected again before its reserved forced-reappearance draw
-- (N + gap(6..9), after collision-shifting), and must be selected exactly
-- at that draw. Covers both commit_answer_transaction() (direct-commit
-- rejection/acceptance) and get_next_session_card() (never offers the
-- card early; offers it exactly at the reserved draw) -- the two
-- authoritative surfaces named in the request.

BEGIN;
SELECT plan(16);

SELECT gen_random_uuid() AS tester_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS deck_id \gset
SELECT tests.create_test_profile(:'tester_id'::uuid, 'test_g14_tester');

SELECT tests.authenticate_as(:'tester_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_id'::uuid)).id AS deck \gset
SELECT (public.start_or_resume_session(:'deck'::uuid)).id AS session_id \gset
SELECT tests.clear_auth();

SELECT is(
  (SELECT current_mode FROM public.sessions WHERE id = :'session_id'::uuid),
  'learning', 'fresh deck, no due reviews -- session starts directly in learning mode'
);

SELECT id AS card_w FROM public.cards WHERE deck_id = :'deck'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
SELECT id AS card_w2 FROM public.cards WHERE deck_id = :'deck'::uuid ORDER BY sort_order LIMIT 1 OFFSET 1 \gset
SELECT id AS card_p1 FROM public.cards WHERE deck_id = :'deck'::uuid ORDER BY sort_order LIMIT 1 OFFSET 2 \gset
SELECT id AS card_p2 FROM public.cards WHERE deck_id = :'deck'::uuid ORDER BY sort_order LIMIT 1 OFFSET 3 \gset
SELECT id AS card_p3 FROM public.cards WHERE deck_id = :'deck'::uuid ORDER BY sort_order LIMIT 1 OFFSET 4 \gset
SELECT id AS card_c FROM public.cards WHERE deck_id = :'deck'::uuid ORDER BY sort_order LIMIT 1 OFFSET 5 \gset

-- -----------------------------------------------------------------------
-- Part A: natural (non-collision) Wrong scheduling at draw 1.
-- Items 1, 2, plus the "immediately after" case of items 3/9.
-- -----------------------------------------------------------------------
SELECT tests.authenticate_as_service_role();
SELECT tests.call_commit_answer(gen_random_uuid(), :'tester_id'::uuid, :'session_id'::uuid, :'card_w'::uuid, false, 'learning');
SELECT tests.clear_auth();

SELECT forced_reappear_draw_index, next_eligible_draw_index
  FROM public.session_learning_queue WHERE session_id = :'session_id'::uuid AND card_id = :'card_w'::uuid \gset

SELECT ok(
  :'forced_reappear_draw_index'::int BETWEEN 7 AND 10,
  'item 1: Wrong at draw 1 schedules a forced draw in 1+6..1+9 = 7..10 (no collision yet)'
);
SELECT is(
  :'next_eligible_draw_index'::int, :'forced_reappear_draw_index'::int,
  'item 2: next_eligible_draw_index equals the (collision-shifted) forced_reappear_draw_index'
);

SELECT tests.authenticate_as(:'tester_id'::uuid);
SELECT public.get_next_session_card(:'session_id'::uuid) AS next_immediate \gset
SELECT tests.clear_auth();

SELECT is((:'next_immediate')::jsonb ->> 'status', 'ok', 'items 3/9: a different card is still offered on the very next draw');
SELECT isnt(
  (:'next_immediate')::jsonb ->> 'card_id', :'card_w',
  'items 3/9: the just-Wronged card (card_w) is NOT the one offered on the very next draw'
);

-- -----------------------------------------------------------------------
-- Part B: deterministic collision-shift + exact boundary behavior, on a
-- SEPARATE card (card_w2) so Part A's cooldown never interferes.
-- Covers items 3 (boundary case), 4, 5, 6, 7, 9.
-- -----------------------------------------------------------------------
SELECT tests.clear_auth();
UPDATE public.sessions SET learning_draw_index = 50 WHERE id = :'session_id'::uuid;

-- Next new Learning answer draws at 50 + 1 = 51, so its possible
-- forced-reappear range is {57, 58, 59, 60}. Pre-reserve 3 of the 4 (as 3
-- other, uninvolved cards) so 60 is the only slot left free -- the same
-- deterministic technique as 008_commit_answer_transaction_test.sql Part
-- 6 / 013_get_next_session_card_test.sql Part 5.
INSERT INTO public.session_learning_queue (session_id, card_id, forced_reappear_draw_index)
VALUES
  (:'session_id'::uuid, :'card_p1'::uuid, 57),
  (:'session_id'::uuid, :'card_p2'::uuid, 58),
  (:'session_id'::uuid, :'card_p3'::uuid, 59);

SELECT tests.authenticate_as_service_role();
SELECT tests.call_commit_answer(gen_random_uuid(), :'tester_id'::uuid, :'session_id'::uuid, :'card_w2'::uuid, false, 'learning');
SELECT tests.clear_auth();

SELECT forced_reappear_draw_index, next_eligible_draw_index
  FROM public.session_learning_queue WHERE session_id = :'session_id'::uuid AND card_id = :'card_w2'::uuid \gset

SELECT is(
  :'forced_reappear_draw_index'::int, 60,
  'item 7: collision-shift deterministically walks forced_reappear_draw_index to the one free slot (60)'
);
SELECT is(
  :'next_eligible_draw_index'::int, 60,
  'item 7: collision-shift updates next_eligible_draw_index to the SAME shifted final slot (60), not the pre-shift value'
);

-- One draw before the reserved slot (draw 59): direct commit is rejected,
-- and get_next_session_card() still offers a different card.
UPDATE public.sessions SET learning_draw_index = 58 WHERE id = :'session_id'::uuid;

SELECT tests.authenticate_as_service_role();
SELECT tests.throws_sqlstate(
  format('select tests.call_commit_answer(gen_random_uuid(), %L, %L, %L, true, %L)',
    :'tester_id', :'session_id', :'card_w2', 'learning'),
  '22023',
  'item 4: committing card_w2 one draw before its reserved slot (draw 59) is rejected'
);
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_id'::uuid);
SELECT public.get_next_session_card(:'session_id'::uuid) AS next_before_reserved \gset
SELECT tests.clear_auth();

SELECT is((:'next_before_reserved')::jsonb ->> 'status', 'ok', 'items 3/9: a different card is still offered one draw before the reserved slot');
SELECT isnt(
  (:'next_before_reserved')::jsonb ->> 'card_id', :'card_w2',
  'item 3: card_w2 is NOT offered one draw before its reserved slot (draw 59)'
);

-- Exactly at the reserved slot (draw 60): get_next_session_card() forces
-- card_w2, and committing it succeeds.
SELECT tests.clear_auth();
UPDATE public.sessions SET learning_draw_index = 59 WHERE id = :'session_id'::uuid;

SELECT tests.authenticate_as(:'tester_id'::uuid);
SELECT public.get_next_session_card(:'session_id'::uuid) AS next_at_reserved \gset
SELECT tests.clear_auth();

SELECT is(
  (:'next_at_reserved')::jsonb ->> 'card_id', :'card_w2',
  'item 5: get_next_session_card() returns exactly card_w2 at its reserved draw (60)'
);

SELECT tests.authenticate_as_service_role();
SELECT lives_ok(
  format('select tests.call_commit_answer(gen_random_uuid(), %L, %L, %L, true, %L)',
    :'tester_id', :'session_id', :'card_w2', 'learning'),
  'item 6: committing card_w2 at its exact reserved draw (60) succeeds'
);

-- Re-mastering at the reserved draw still runs the ordinary Correct path
-- (sanity: the floor logic did not corrupt the Correct branch for a
-- previously-Wronged card). NULL-possible column checked via a direct
-- subquery, not \gset (psql's \gset silently skips a NULL column,
-- leaving the variable unset rather than empty).
SELECT is(
  (SELECT next_eligible_draw_index FROM public.session_learning_queue
    WHERE session_id = :'session_id'::uuid AND card_id = :'card_w2'::uuid),
  71, 'after the Correct re-answer at draw 60, next_eligible_draw_index = 60 + 11'
);
SELECT ok(
  (SELECT forced_reappear_draw_index FROM public.session_learning_queue
    WHERE session_id = :'session_id'::uuid AND card_id = :'card_w2'::uuid) IS NULL,
  'after the Correct re-answer, forced_reappear_draw_index is cleared'
);

SELECT tests.clear_auth();

-- -----------------------------------------------------------------------
-- Part D (item 8): Correct-answer cooldown is unchanged for an ordinary,
-- never-Wronged card.
-- -----------------------------------------------------------------------
SELECT tests.authenticate_as_service_role();
SELECT tests.call_commit_answer(gen_random_uuid(), :'tester_id'::uuid, :'session_id'::uuid, :'card_c'::uuid, true, 'learning');
SELECT tests.clear_auth();

SELECT learning_draw_index FROM public.sessions WHERE id = :'session_id'::uuid \gset

SELECT is(
  (SELECT next_eligible_draw_index FROM public.session_learning_queue
    WHERE session_id = :'session_id'::uuid AND card_id = :'card_c'::uuid),
  :'learning_draw_index'::int + 11,
  'item 8: Correct-answer cooldown is unchanged -- next_eligible_draw_index = draw + 11'
);
SELECT ok(
  (SELECT forced_reappear_draw_index FROM public.session_learning_queue
    WHERE session_id = :'session_id'::uuid AND card_id = :'card_c'::uuid) IS NULL,
  'item 8: Correct-answer cooldown is unchanged -- forced_reappear_draw_index stays NULL'
);

SELECT * FROM finish();
ROLLBACK;
