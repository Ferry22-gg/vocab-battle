\ir fixtures/000_test_helpers.sql

-- Group 9: XP / level.
-- Maps to DATABASE_SCHEMA.md §17 / §10.4 (XP idempotency, exact amounts)
-- and the "Level calculation" subsection of §10.3.

BEGIN;
SELECT plan(13);

SELECT gen_random_uuid() AS tester_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS deck_i_id \gset
SELECT tests.create_test_profile(:'tester_id'::uuid, 'test_g9_tester');

SELECT tests.authenticate_as(:'tester_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS deck_x \gset
SELECT (public.start_or_resume_session()).id AS session_x \gset
SELECT tests.clear_auth();

SELECT id AS card_a FROM public.cards WHERE deck_id = :'deck_x'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
SELECT id AS card_b FROM public.cards WHERE deck_id = :'deck_x'::uuid ORDER BY sort_order LIMIT 1 OFFSET 1 \gset
SELECT id AS card_c FROM public.cards WHERE deck_id = :'deck_x'::uuid ORDER BY sort_order LIMIT 1 OFFSET 2 \gset
SELECT id AS card_d FROM public.cards WHERE deck_id = :'deck_x'::uuid ORDER BY sort_order LIMIT 1 OFFSET 3 \gset
SELECT id AS card_e FROM public.cards WHERE deck_id = :'deck_x'::uuid ORDER BY sort_order LIMIT 1 OFFSET 4 \gset

-- Fixture setup (privileged): pre-position card_b/card_c one Correct
-- answer away from (re-)mastery.
UPDATE public.user_card_progress SET card_status = 'LEARNING', seen_count = 4, correct_streak = 3
 WHERE user_id = :'tester_id'::uuid AND card_id = :'card_b'::uuid;
UPDATE public.user_card_progress SET card_status = 'FORGOTTEN', seen_count = 4, correct_streak = 3
 WHERE user_id = :'tester_id'::uuid AND card_id = :'card_c'::uuid;

SELECT tests.authenticate_as_service_role();

-- Correct answer -> +2 (correct_answer)
SELECT gen_random_uuid() AS ea \gset
SELECT tests.call_commit_answer(:'ea'::uuid, :'tester_id'::uuid, :'session_x'::uuid, :'card_a'::uuid, true, 'learning') AS ra \gset
SELECT is(
  (SELECT amount FROM public.xp_events WHERE source_answer_event_id = ((:'ra')::jsonb -> 'answer_event' ->> 'id')::uuid AND reason = 'correct_answer'),
  2, 'a Correct answer awards +2 XP (correct_answer)'
);

-- First mastery -> +15 (card_learned)
SELECT gen_random_uuid() AS eb \gset
SELECT tests.call_commit_answer(:'eb'::uuid, :'tester_id'::uuid, :'session_x'::uuid, :'card_b'::uuid, true, 'learning') AS rb \gset
SELECT is(
  (SELECT card_status FROM public.user_card_progress WHERE user_id = :'tester_id'::uuid AND card_id = :'card_b'::uuid),
  'LEARNED', 'card_b reaches LEARNED on the mastering answer'
);
SELECT is(
  (SELECT amount FROM public.xp_events WHERE source_answer_event_id = ((:'rb')::jsonb -> 'answer_event' ->> 'id')::uuid AND reason = 'card_learned'),
  15, 'first-ever mastery awards +15 XP (card_learned)'
);

-- Re-mastery (FORGOTTEN -> LEARNED) -> +15 (card_relearned)
SELECT gen_random_uuid() AS ec \gset
SELECT tests.call_commit_answer(:'ec'::uuid, :'tester_id'::uuid, :'session_x'::uuid, :'card_c'::uuid, true, 'learning') AS rc \gset
SELECT is(
  (SELECT card_status FROM public.user_card_progress WHERE user_id = :'tester_id'::uuid AND card_id = :'card_c'::uuid),
  'LEARNED', 'card_c (FORGOTTEN) reaches LEARNED again on the re-mastering answer'
);
SELECT is(
  (SELECT amount FROM public.xp_events WHERE source_answer_event_id = ((:'rc')::jsonb -> 'answer_event' ->> 'id')::uuid AND reason = 'card_relearned'),
  15, 're-mastery awards +15 XP (card_relearned)'
);

-- Enemy defeated -> +20 (enemy_defeated)
SELECT current_enemy_hp AS enemy_hp_x FROM public.sessions WHERE id = :'session_x'::uuid \gset
SELECT gen_random_uuid() AS ed \gset
SELECT tests.call_commit_answer(:'ed'::uuid, :'tester_id'::uuid, :'session_x'::uuid, :'card_d'::uuid, true, 'learning', 1500, null, :'enemy_hp_x'::int, true) AS rd \gset
SELECT is(
  (SELECT amount FROM public.xp_events WHERE source_answer_event_id = ((:'rd')::jsonb -> 'answer_event' ->> 'id')::uuid AND reason = 'enemy_defeated'),
  20, 'defeating the enemy awards +20 XP (enemy_defeated)'
);

-- Daily Goal completion -> +30 (daily_goal_completed), exactly once
SELECT tests.clear_auth();
UPDATE public.daily_user_stats
   SET enemies_defeated = 4, daily_goal_completed = false, daily_goal_completed_at = null
 WHERE user_id = :'tester_id'::uuid AND stat_date = (now() AT TIME ZONE 'Asia/Tokyo')::date;
SELECT tests.authenticate_as_service_role();

SELECT current_enemy_hp AS enemy_hp_x2 FROM public.sessions WHERE id = :'session_x'::uuid \gset
SELECT gen_random_uuid() AS ee \gset
SELECT tests.call_commit_answer(:'ee'::uuid, :'tester_id'::uuid, :'session_x'::uuid, :'card_e'::uuid, true, 'learning', 1500, null, :'enemy_hp_x2'::int, true) AS re \gset

SELECT is(
  (SELECT daily_goal_completed FROM public.daily_user_stats
    WHERE user_id = :'tester_id'::uuid AND stat_date = (now() AT TIME ZONE 'Asia/Tokyo')::date),
  true, 'the 5th enemy of the day completes the Daily Goal'
);
SELECT is(
  (SELECT amount FROM public.xp_events WHERE source_answer_event_id = ((:'re')::jsonb -> 'answer_event' ->> 'id')::uuid AND reason = 'daily_goal_completed'),
  30, 'Daily Goal completion awards +30 XP exactly once'
);

-- Replay never double-awards XP (re-submit the very first answer, ea)
SELECT total_xp AS xp_before_replay FROM public.profiles WHERE id = :'tester_id'::uuid \gset
SELECT tests.call_commit_answer(:'ea'::uuid, :'tester_id'::uuid, :'session_x'::uuid, :'card_a'::uuid, true, 'learning');

SELECT is(
  (SELECT count(*)::int FROM public.xp_events
    WHERE source_answer_event_id = ((:'ra')::jsonb -> 'answer_event' ->> 'id')::uuid AND reason = 'correct_answer'),
  1, 'replaying ea does not create a second correct_answer xp_events row'
);
SELECT is(
  (SELECT total_xp FROM public.profiles WHERE id = :'tester_id'::uuid),
  :'xp_before_replay'::int, 'total_xp is unchanged by the replay'
);

-- total_xp reconciles exactly against the sum of this user's xp_events
SELECT is(
  (SELECT total_xp FROM public.profiles WHERE id = :'tester_id'::uuid),
  (SELECT coalesce(sum(amount), 0)::int FROM public.xp_events WHERE user_id = :'tester_id'::uuid),
  'profiles.total_xp matches the sum of this user''s xp_events'
);

SELECT tests.clear_auth();

-- -----------------------------------------------------------------------
-- Level thresholds follow cumulative(L) = 200*(L-1) + 25*(L-1)*(L-2):
-- cumulative(2) = 200, so total_xp = 200 must be level 2 and
-- total_xp = 198 must still be level 1. Directly set total_xp (privileged)
-- to isolate the formula from any particular XP-earning scenario.
-- -----------------------------------------------------------------------
UPDATE public.profiles SET total_xp = 198, level = 1 WHERE id = :'tester_id'::uuid;
SELECT tests.authenticate_as_service_role();
SELECT gen_random_uuid() AS ef \gset
SELECT tests.call_commit_answer(:'ef'::uuid, :'tester_id'::uuid, :'session_x'::uuid,
  (SELECT id FROM public.cards WHERE deck_id = :'deck_x'::uuid ORDER BY sort_order LIMIT 1 OFFSET 5)::uuid,
  false, 'learning');
SELECT tests.clear_auth();

SELECT is(
  (SELECT level FROM public.profiles WHERE id = :'tester_id'::uuid),
  1, 'total_xp = 198 (below the 200 threshold) stays at level 1'
);

UPDATE public.profiles SET total_xp = 198, level = 1 WHERE id = :'tester_id'::uuid;
SELECT tests.authenticate_as_service_role();
SELECT gen_random_uuid() AS eg \gset
SELECT tests.call_commit_answer(:'eg'::uuid, :'tester_id'::uuid, :'session_x'::uuid,
  (SELECT id FROM public.cards WHERE deck_id = :'deck_x'::uuid ORDER BY sort_order LIMIT 1 OFFSET 6)::uuid,
  true, 'learning');
SELECT tests.clear_auth();

SELECT is(
  (SELECT level FROM public.profiles WHERE id = :'tester_id'::uuid),
  2, 'total_xp crossing 200 (198 + 2 from a Correct answer) advances to level 2'
);

SELECT * FROM finish();
ROLLBACK;
