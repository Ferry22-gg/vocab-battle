\ir fixtures/000_test_helpers.sql

-- Group 10: Daily Goal / streak.
-- Maps to DATABASE_SCHEMA.md §17 / §10.5 (Daily Goal idempotency, streak
-- rule, post-goal continuation).
--
-- "Next day" / "gap day" / "yesterday" are simulated by directly setting
-- profiles.last_daily_goal_completed_on and resetting today's
-- daily_user_stats row (privileged, bypasses RLS) -- commit_answer_
-- transaction() always uses the real current Asia/Tokyo date for
-- stat_date, so there is no way to make it believe a different real date
-- has passed; this simulates the *comparison inputs* to the streak rule
-- (§10.5) instead, which is what is actually under test here.

BEGIN;
SELECT plan(11);

SELECT gen_random_uuid() AS tester_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS deck_i_id \gset
SELECT tests.create_test_profile(:'tester_id'::uuid, 'test_g10_tester');

SELECT tests.authenticate_as(:'tester_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS deck_x \gset
SELECT (public.start_or_resume_session()).id AS session_x \gset
SELECT tests.clear_auth();

UPDATE public.profiles SET current_streak = 0, longest_streak = 0, last_daily_goal_completed_on = null
 WHERE id = :'tester_id'::uuid;
UPDATE public.daily_user_stats SET enemies_defeated = 4, daily_goal_completed = false, daily_goal_completed_at = null,
       post_goal_answers = 0, continued_after_daily_goal = false
 WHERE user_id = :'tester_id'::uuid AND stat_date = (now() AT TIME ZONE 'Asia/Tokyo')::date;

-- -----------------------------------------------------------------------
-- Test A: completing the 5th enemy of the day from a cold start
-- (last_daily_goal_completed_on IS NULL) sets current_streak = 1
-- -----------------------------------------------------------------------
SELECT tests.authenticate_as_service_role();
SELECT current_enemy_hp AS hp_a FROM public.sessions WHERE id = :'session_x'::uuid \gset
SELECT id AS card_a FROM public.cards WHERE deck_id = :'deck_x'::uuid ORDER BY sort_order LIMIT 1 OFFSET 0 \gset
SELECT gen_random_uuid() AS e_a \gset
SELECT tests.call_commit_answer(:'e_a'::uuid, :'tester_id'::uuid, :'session_x'::uuid, :'card_a'::uuid, true, 'learning', 1500, null, :'hp_a'::int, true);
SELECT tests.clear_auth();

SELECT is((SELECT current_streak FROM public.profiles WHERE id = :'tester_id'::uuid), 1, 'completing the Daily Goal from a cold start sets current_streak = 1');
SELECT is((SELECT longest_streak FROM public.profiles WHERE id = :'tester_id'::uuid), 1, 'longest_streak follows current_streak on the first completion');
SELECT is((SELECT last_daily_goal_completed_on FROM public.profiles WHERE id = :'tester_id'::uuid), (now() AT TIME ZONE 'Asia/Tokyo')::date, 'last_daily_goal_completed_on is set to today');

-- -----------------------------------------------------------------------
-- Test B: the completing answer is not itself post-goal; a later
-- same-day answer increments post_goal_answers/continued_after_daily_goal
-- and does NOT increment the streak again
-- -----------------------------------------------------------------------
SELECT is(
  (SELECT post_goal_answers FROM public.daily_user_stats WHERE user_id = :'tester_id'::uuid AND stat_date = (now() AT TIME ZONE 'Asia/Tokyo')::date),
  0, 'the answer that completes the Daily Goal is not itself counted as a post-goal answer'
);

SELECT tests.authenticate_as_service_role();
SELECT id AS card_b FROM public.cards WHERE deck_id = :'deck_x'::uuid ORDER BY sort_order LIMIT 1 OFFSET 1 \gset
SELECT gen_random_uuid() AS e_b \gset
SELECT tests.call_commit_answer(:'e_b'::uuid, :'tester_id'::uuid, :'session_x'::uuid, :'card_b'::uuid, true, 'learning');
SELECT tests.clear_auth();

SELECT is(
  (SELECT post_goal_answers FROM public.daily_user_stats WHERE user_id = :'tester_id'::uuid AND stat_date = (now() AT TIME ZONE 'Asia/Tokyo')::date),
  1, 'a later same-day answer increments post_goal_answers'
);
SELECT is(
  (SELECT continued_after_daily_goal FROM public.daily_user_stats WHERE user_id = :'tester_id'::uuid AND stat_date = (now() AT TIME ZONE 'Asia/Tokyo')::date),
  true, 'a later same-day answer sets continued_after_daily_goal = true'
);
SELECT is(
  (SELECT current_streak FROM public.profiles WHERE id = :'tester_id'::uuid),
  1, 'a later same-day answer does NOT increment the streak again'
);

-- -----------------------------------------------------------------------
-- Test C: completing the Daily Goal the day after
-- last_daily_goal_completed_on increments the streak
-- -----------------------------------------------------------------------
UPDATE public.profiles SET last_daily_goal_completed_on = (now() AT TIME ZONE 'Asia/Tokyo')::date - 1
 WHERE id = :'tester_id'::uuid;
UPDATE public.daily_user_stats SET enemies_defeated = 4, daily_goal_completed = false, daily_goal_completed_at = null
 WHERE user_id = :'tester_id'::uuid AND stat_date = (now() AT TIME ZONE 'Asia/Tokyo')::date;

SELECT tests.authenticate_as_service_role();
SELECT current_enemy_hp AS hp_c FROM public.sessions WHERE id = :'session_x'::uuid \gset
SELECT id AS card_c FROM public.cards WHERE deck_id = :'deck_x'::uuid ORDER BY sort_order LIMIT 1 OFFSET 2 \gset
SELECT gen_random_uuid() AS e_c \gset
SELECT tests.call_commit_answer(:'e_c'::uuid, :'tester_id'::uuid, :'session_x'::uuid, :'card_c'::uuid, true, 'learning', 1500, null, :'hp_c'::int, true);
SELECT tests.clear_auth();

SELECT is((SELECT current_streak FROM public.profiles WHERE id = :'tester_id'::uuid), 2, 'completing the goal the day after the last completion increments the streak');
SELECT is((SELECT longest_streak FROM public.profiles WHERE id = :'tester_id'::uuid), 2, 'longest_streak tracks the new, higher streak');

-- -----------------------------------------------------------------------
-- Test D: a gap day (not exactly yesterday) resets current_streak to 1,
-- while longest_streak is preserved rather than lowered
-- -----------------------------------------------------------------------
UPDATE public.profiles SET last_daily_goal_completed_on = (now() AT TIME ZONE 'Asia/Tokyo')::date - 3,
       current_streak = 5, longest_streak = 5
 WHERE id = :'tester_id'::uuid;
UPDATE public.daily_user_stats SET enemies_defeated = 4, daily_goal_completed = false, daily_goal_completed_at = null
 WHERE user_id = :'tester_id'::uuid AND stat_date = (now() AT TIME ZONE 'Asia/Tokyo')::date;

SELECT tests.authenticate_as_service_role();
SELECT current_enemy_hp AS hp_d FROM public.sessions WHERE id = :'session_x'::uuid \gset
SELECT id AS card_d FROM public.cards WHERE deck_id = :'deck_x'::uuid ORDER BY sort_order LIMIT 1 OFFSET 3 \gset
SELECT gen_random_uuid() AS e_d \gset
SELECT tests.call_commit_answer(:'e_d'::uuid, :'tester_id'::uuid, :'session_x'::uuid, :'card_d'::uuid, true, 'learning', 1500, null, :'hp_d'::int, true);
SELECT tests.clear_auth();

SELECT is((SELECT current_streak FROM public.profiles WHERE id = :'tester_id'::uuid), 1, 'a gap day (not exactly yesterday) resets current_streak to 1');
SELECT is((SELECT longest_streak FROM public.profiles WHERE id = :'tester_id'::uuid), 5, 'longest_streak is preserved (not lowered) across a streak reset');

SELECT * FROM finish();
ROLLBACK;
