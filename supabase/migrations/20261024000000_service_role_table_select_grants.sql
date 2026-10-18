-- Restores the narrow set of service_role table privileges this
-- architecture actually relies on, which a fresh Supabase Cloud project
-- does not inherit the way the local CLI's dev-stack bootstrap does.
--
-- Audit finding: no migration in this repo has ever granted service_role
-- table-level privileges -- authoritative writes are performed exclusively
-- by SECURITY DEFINER RPCs (commit_answer_transaction(),
-- commit_learning_engine_v1_answer(), admit_user_to_learning_engine_v1(),
-- commit_learning_engine_v1_enrollment(), etc.), which run with the
-- function owner's privileges regardless of the caller's own table
-- grants. That has always been correct and remains correct here -- this
-- migration grants no INSERT/UPDATE/DELETE on any of those tables.
--
-- What IS missing: a handful of deliberate direct reads this codebase's
-- trusted TypeScript DAL layer performs via the service-role client
-- itself (not through an RPC), which genuinely require real table
-- privileges under PostgREST regardless of service_role's RLS-bypass
-- attribute (RLS bypass only skips policies, not grants):
--
--   - lib/learning-engine/runtime/commit-answer-dal.ts's
--     fetchExistingAnswerEvent() -- a live, production idempotency-replay
--     read against answer_events/xp_events, run before every Learning
--     Engine v1 answer commit (lib/learning-engine/runtime/commit-answer.ts,
--     wired live through lib/learning/engine-router.ts).
--   - lib/learning-engine/cutover/dal.ts's getLearningEngineV1RolloutRow()/
--     getActiveLegacySessionForUser() -- operational enrollment fast-path
--     reads against learning_engine_v1_rollout/sessions.
--   - lib/learning-engine/cutover/prepare-normalization.ts's read against
--     user_card_progress (joined to cards for deck_id).
--
-- Plus one admin-provisioning primitive: creating a tester's profiles row
-- via a trusted service-role upsert (the same pattern already used by
-- tests/integration/fixtures/setup.ts's upsertTesterProfile()), which
-- needs SELECT/INSERT/UPDATE on profiles -- never DELETE, since no
-- trusted service-role path deletes a profile directly (full account
-- deletion goes through the Admin Auth API's deleteUser(), with the
-- profile row deleted via the same restricted path tests already use).
--
-- Deliberately narrow: no ALL/broad grants, no change to anon/authenticated
-- privileges or any RLS policy, and no DML on cards/sessions/answer_events/
-- xp_events/learning_engine_v1_rollout/user_card_progress -- every write to
-- those tables must keep going exclusively through the existing trusted
-- RPCs.

grant select
  on table
    public.answer_events,
    public.xp_events
  to service_role;

grant select
  on table
    public.sessions,
    public.learning_engine_v1_rollout,
    public.user_card_progress,
    public.cards
  to service_role;

grant select, insert, update
  on table public.profiles
  to service_role;
