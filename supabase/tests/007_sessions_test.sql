\ir fixtures/000_test_helpers.inc

-- Group 7: Sessions (start_or_resume_session(), finish_session()).
-- Maps to DATABASE_SCHEMA.md §17:
--   "session interruption can be resumed"
--   §4.5 (initial enemy / Daily Goal snapshot, resume behavior),
--   §4.6 (review queue fixed at review-portion start), §10.2.

BEGIN;
SELECT plan(18);

SELECT gen_random_uuid() AS tester_a_id \gset
SELECT gen_random_uuid() AS tester_b_id \gset
SELECT gen_random_uuid() AS admin_id \gset
SELECT tests.official_deck_id('Advanced English Vocabulary I') AS deck_i_id \gset

SELECT tests.create_test_profile(:'tester_a_id'::uuid, 'test_g7_tester_a');
SELECT tests.create_test_profile(:'tester_b_id'::uuid, 'test_g7_tester_b');
SELECT tests.create_test_profile(:'admin_id'::uuid, 'test_g7_admin', 'admin', 'active', true);

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT (public.duplicate_starter_deck(:'deck_i_id'::uuid)).id AS tester_a_deck \gset

-- start_or_resume_session() creates a valid active session
SELECT (public.start_or_resume_session()).id AS session_id \gset
SELECT tests.clear_auth();

SELECT is(
  (SELECT status FROM public.sessions WHERE id = :'session_id'::uuid),
  'active', 'a freshly started session has status = active'
);

-- initial enemy is one of enemy_a/enemy_b/enemy_c, HP initialized
SELECT ok(
  (SELECT current_enemy_type FROM public.sessions WHERE id = :'session_id'::uuid)
    IN ('enemy_a', 'enemy_b', 'enemy_c'),
  'initial enemy is one of the three canonical types'
);
SELECT ok(
  (SELECT current_enemy_hp = current_enemy_max_hp AND current_enemy_max_hp > 0
     FROM public.sessions WHERE id = :'session_id'::uuid),
  'enemy HP is initialized to full max HP'
);

-- a freshly duplicated deck has no LEARNED/due cards yet, so the session
-- starts directly in learning mode with an empty (fixed) review queue
SELECT is(
  (SELECT current_mode FROM public.sessions WHERE id = :'session_id'::uuid),
  'learning', 'a session with no due reviews starts in learning mode'
);
SELECT is(
  (SELECT count(*)::int FROM public.session_review_cards WHERE session_id = :'session_id'::uuid),
  0, 'review queue is empty when nothing was due at session creation'
);

-- review queue is FIXED at creation: simulate one of the tester's cards
-- becoming due (LEARNED + past-due) after the session already started,
-- and confirm it was never retroactively added to session_review_cards
SELECT id AS late_due_card_id FROM public.cards WHERE deck_id = :'tester_a_deck'::uuid LIMIT 1 \gset
UPDATE public.user_card_progress
   SET card_status = 'LEARNED', fsrs_due_at = now() - interval '1 day'
 WHERE user_id = :'tester_a_id'::uuid AND card_id = :'late_due_card_id'::uuid;

SELECT is(
  (SELECT count(*)::int FROM public.session_review_cards
    WHERE session_id = :'session_id'::uuid AND card_id = :'late_due_card_id'::uuid),
  0, 'a card that becomes due after session start is NOT added to the fixed review queue'
);

-- calling start_or_resume_session() again resumes instead of creating a
-- second active session
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT is(
  (SELECT resume_count FROM public.sessions WHERE id = :'session_id'::uuid),
  0, 'resume_count is 0 immediately after session creation'
);

SELECT (public.start_or_resume_session()).id AS resumed_session_id \gset
SELECT tests.clear_auth();

SELECT is(
  :'resumed_session_id'::uuid, :'session_id'::uuid,
  'calling start_or_resume_session() again returns the SAME session (resume, not a new one)'
);
SELECT is(
  (SELECT resume_count FROM public.sessions WHERE id = :'session_id'::uuid),
  1, 'resume_count increments to 1 on the first resume'
);
SELECT is(
  (SELECT count(*)::int FROM public.sessions WHERE user_id = :'tester_a_id'::uuid AND status = 'active'),
  1, 'the tester still has exactly one active session after resuming'
);

-- finish_session() only finishes the caller's OWN active session
SELECT tests.authenticate_as(:'tester_b_id'::uuid);
SELECT tests.throws_sqlstate(
  format('select public.finish_session(%L)', :'session_id'),
  '42501', 'tester B cannot finish tester A''s session'
);
SELECT tests.clear_auth();

SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT lives_ok(
  format('select public.finish_session(%L)', :'session_id'),
  'tester A can finish their own active session'
);
SELECT tests.clear_auth();

SELECT is(
  (SELECT status FROM public.sessions WHERE id = :'session_id'::uuid),
  'completed', 'the finished session has status = completed'
);
SELECT is(
  (SELECT end_reason FROM public.sessions WHERE id = :'session_id'::uuid),
  'user_finished', 'end_reason is user_finished'
);

-- with no active session left, start_or_resume_session() now creates a
-- brand new one rather than "resuming" the completed one
SELECT tests.authenticate_as(:'tester_a_id'::uuid);
SELECT (public.start_or_resume_session()).id AS new_session_id \gset
SELECT tests.clear_auth();

SELECT isnt(
  :'new_session_id'::uuid, :'session_id'::uuid,
  'after finishing, start_or_resume_session() creates a genuinely new session'
);
SELECT is(
  (SELECT status FROM public.sessions WHERE id = :'new_session_id'::uuid),
  'active', 'the newly created session is active'
);

-- admin cannot persist learner session state through either trusted
-- session workflow (same active-tester guard pattern already verified
-- for duplicate_starter_deck()/add_card_to_deck()/select_deck())
SELECT tests.authenticate_as(:'admin_id'::uuid);
SELECT tests.throws_sqlstate(
  'select public.start_or_resume_session()',
  '28000', 'admin is rejected by start_or_resume_session() (not an active tester account)'
);
SELECT tests.throws_sqlstate(
  format('select public.finish_session(%L)', :'new_session_id'),
  '28000', 'admin is rejected by finish_session() (not an active tester account)'
);
SELECT tests.clear_auth();

SELECT * FROM finish();
ROLLBACK;
