-- Shared pgTAP test fixtures for the Vocab Battle database test suite.
--
-- This file is NOT itself a pgTAP test (it defines no plan()/finish()), so
-- it must live outside supabase/tests/ proper -- `supabase test db`
-- discovers and runs every *.sql file directly under supabase/tests/ (see
-- the README in that directory), and a fixtures-only file with no TAP
-- output would break that run. Every real test file includes this one
-- explicitly via a psql \ir (include-relative) meta-command as its first
-- line, e.g. from supabase/tests/001_..._test.sql:
--
--   \ir fixtures/000_test_helpers.sql
--
-- `supabase test db` shells out to psql per file, and \ir is a standard
-- psql feature (not a custom test framework) -- this is the same sharing
-- mechanism pgTAP's own documentation recommends for common setup code.
--
-- ---------------------------------------------------------------------
-- Auth/JWT simulation -- how these tests stand in for real Supabase Auth
-- ---------------------------------------------------------------------
--
-- `supabase start` provisions the full local Postgres image, which already
-- has the `auth` schema (from GoTrue's own migrations) before any project
-- migration in supabase/migrations/ runs, and defines auth.uid() as
-- (paraphrased) `coalesce(nullif(current_setting('request.jwt.claim.sub',
-- true), ''), (nullif(current_setting('request.jwt.claims', true),
-- '')::jsonb ->> 'sub'))::uuid` -- i.e. it reads the same
-- `request.jwt.claim*` GUCs that PostgREST sets from a real, verified JWT
-- on every API request.
--
-- These tests never go through the GoTrue HTTP signup/login flow (that is
-- Auth-branch scope, explicitly out of scope here) -- they exercise the
-- database layer directly. tests.create_test_profile() inserts a minimal
-- synthetic row directly into auth.users (bypassing GoTrue) plus the
-- matching public.profiles row, and tests.authenticate_as() sets those
-- same `request.jwt.claim*` GUCs and switches the session to `ROLE
-- authenticated` -- exactly the state PostgREST would put a real request
-- in after verifying that user's real JWT. From that point on, every
-- RLS policy and every auth.uid()-based SECURITY DEFINER check behaves
-- identically to production for that (synthetic) signed-in user.
--
-- Because every GUC set here uses set_config(..., true) ("is_local"),
-- and every ROLE switch uses SET LOCAL, all of it is scoped to the
-- enclosing BEGIN/ROLLBACK of the calling test file and never leaks
-- across files or across `supabase test db`'s per-file connections.
--
-- What this does NOT simulate: real password auth, email confirmation,
-- refresh tokens, JWT signature verification, or GoTrue's own business
-- rules. Anything that depends on those belongs to the Auth branch, not
-- this database test suite -- see the README for exactly which of the
-- 12 required test groups fall on that side of the line.

create schema if not exists tests;

-- create extension if not exists pgtap; is intentionally NOT run here --
-- `supabase test db` (and pg_prove more generally) already require pgtap
-- to be enabled in the database before it will collect any TAP output at
-- all, so by the time this file is included pgtap already exists. Adding
-- a second, redundant `create extension` per test file is unnecessary;
-- enable it once via `create extension if not exists pgtap;` against the
-- local database (or add it to supabase/seed.sql) before the first run.

-- ---------------------------------------------------------------------
-- tests.create_test_profile: synthetic auth.users + public.profiles pair
--
-- ASSUMPTION (review finding, 2026-09-23): this function is plain
-- SECURITY INVOKER, not SECURITY DEFINER -- it only works because every
-- call site in this suite invokes it while the session is still the
-- privileged connecting/table-owner role, i.e. strictly BEFORE any
-- tests.authenticate_as()/authenticate_as_service_role() call in that
-- file. `authenticated`/`service_role` have no INSERT grant on
-- auth.users, so calling this function after switching role would fail.
-- If a future test ever needs to create a profile mid-scenario, call
-- tests.clear_auth() first.
-- ---------------------------------------------------------------------
create or replace function tests.create_test_profile(
  p_id uuid,
  p_public_user_id text,
  p_role text default 'tester',
  p_account_status text default 'active',
  p_exclude_from_analytics boolean default false
) returns void
language plpgsql
as $$
begin
  insert into auth.users (
    instance_id, id, aud, role, email,
    encrypted_password, email_confirmed_at,
    created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    is_sso_user
  ) values (
    '00000000-0000-0000-0000-000000000000',
    p_id, 'authenticated', 'authenticated',
    p_public_user_id || '@test.vocabbattle.internal',
    -- Never used to actually authenticate (these tests bypass GoTrue
    -- entirely and set auth GUCs directly) -- a real password hash is
    -- deliberately not needed here.
    'not-a-real-password-hash',
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    false
  )
  on conflict (id) do nothing;

  insert into public.profiles (id, public_user_id, role, account_status, exclude_from_analytics)
  values (p_id, p_public_user_id, p_role, p_account_status, p_exclude_from_analytics)
  on conflict (id) do nothing;
end;
$$;

comment on function tests.create_test_profile(uuid, text, text, text, boolean) is
  'Test fixture only. Creates a synthetic auth.users + public.profiles pair without going through GoTrue -- these tests exercise the database layer, not Auth itself.';

-- ---------------------------------------------------------------------
-- tests.authenticate_as: simulate a signed-in `authenticated` request
-- ---------------------------------------------------------------------
create or replace function tests.authenticate_as(p_id uuid) returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', p_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_id::text, 'role', 'authenticated')::text,
    true
  );
  set local role authenticated;
end;
$$;

-- ---------------------------------------------------------------------
-- tests.authenticate_as_service_role: simulate the trusted Next.js
-- server-side caller of commit_answer_transaction() (service_role key,
-- never derived from auth.uid())
--
-- ASSUMPTION (review finding, 2026-09-23): tests.call_commit_answer()
-- (below) reads public.sessions/public.user_card_progress directly while
-- running as service_role. That read relies on TWO separate privilege
-- layers, not one: (1) service_role's BYPASSRLS attribute, which makes
-- the RLS policies on those tables moot, and (2) service_role still
-- needing -- and, in this project, retaining -- an actual table-level
-- SELECT grant, via Supabase's `auto_expose_new_tables` default (see
-- supabase/config.toml; defaults to true), which the grants/RLS
-- migration (20260923180512_grants_and_rls.sql) only ever revokes from
-- `anon, authenticated` -- never from `service_role`. If a future
-- migration hardens this by also revoking service_role's default grant,
-- these fixtures would need an explicit `grant select ... to
-- service_role` to keep working.
-- ---------------------------------------------------------------------
create or replace function tests.authenticate_as_service_role() returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
  set local role service_role;
end;
$$;

-- ---------------------------------------------------------------------
-- tests.clear_auth: drop back to the privileged connecting role (table
-- owner, bypasses RLS) -- used between scenarios and for ground-truth
-- assertions that must see rows regardless of RLS.
-- ---------------------------------------------------------------------
create or replace function tests.clear_auth() returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
  reset role;
end;
$$;

-- ---------------------------------------------------------------------
-- tests.official_deck_id: look up an official template deck by name
-- rather than hard-coding its UUID a second time in every test file.
-- ---------------------------------------------------------------------
create or replace function tests.official_deck_id(p_name text) returns uuid
language sql
stable
as $$
  select id
  from public.decks
  where name = p_name
    and is_official = true
    and is_template = true
  limit 1;
$$;

-- ---------------------------------------------------------------------
-- tests.call_commit_answer: thin wrapper around
-- public.commit_answer_transaction() that fills in the mandatory
-- pre-answer snapshot and a self-consistent battle result from the
-- *live* session/progress state, so callers only have to specify what
-- the scenario actually cares about (p_correct, and optionally a damage
-- or session-mode override). This mirrors what the real trusted
-- submitAnswer() does in production: read current state, then compute a
-- result consistent with it -- it does not hard-code any enemy HP or
-- combo value, since start_or_resume_session() spawns a random enemy.
-- ---------------------------------------------------------------------
create or replace function tests.call_commit_answer(
  p_client_event_id uuid,
  p_user_id uuid,
  p_session_id uuid,
  p_card_id uuid,
  p_correct boolean default true,
  p_session_mode text default null,           -- null => live session.current_mode
  p_response_time_ms integer default 1500,
  p_fsrs_rating text default null,            -- null => 'Good'/'Again' from p_correct
  p_damage_override integer default null,     -- null => a safe default that will not overkill a fresh enemy
  p_enemy_defeated_override boolean default null,
  p_new_enemy_type text default null,
  p_new_enemy_max_hp integer default null,
  p_new_enemy_hp integer default null,
  p_critical_override boolean default null,   -- deliberately-invalid-input testing only (group 8)
  p_combo_after_override integer default null -- deliberately-invalid-input testing only (group 8)
) returns jsonb
language plpgsql
as $$
declare
  v_session public.sessions;
  v_progress public.user_card_progress;
  v_mode text;
  v_rating text;
  v_damage integer;
  v_combo_after integer;
  v_enemy_hp_after integer;
  v_enemy_defeated boolean;
  v_new_type text;
  v_new_max_hp integer;
  v_new_hp integer;
begin
  select * into v_session from public.sessions where id = p_session_id;
  select * into v_progress from public.user_card_progress where user_id = p_user_id and card_id = p_card_id;

  v_mode := coalesce(p_session_mode, v_session.current_mode);
  v_rating := coalesce(p_fsrs_rating, case when p_correct then 'Good' else 'Again' end);

  if p_correct then
    v_combo_after := coalesce(p_combo_after_override, least(v_session.current_combo + 1, 10));
    v_damage := coalesce(p_damage_override, least(20, v_session.current_enemy_hp));
    v_enemy_hp_after := greatest(0, v_session.current_enemy_hp - v_damage);
  else
    -- p_damage_override/p_combo_after_override are honored here too
    -- (normally both stay 0 on a Wrong answer) specifically so group 8 can
    -- construct the "Wrong answer claims nonzero damage/combo" cases that
    -- commit_answer_transaction()'s structural battle validation must
    -- reject -- this is deliberately-invalid test input, not a realistic
    -- caller.
    v_combo_after := coalesce(p_combo_after_override, 0);
    v_damage := coalesce(p_damage_override, 0);
    v_enemy_hp_after := v_session.current_enemy_hp;
  end if;

  v_enemy_defeated := coalesce(p_enemy_defeated_override, v_enemy_hp_after = 0);

  if v_enemy_defeated then
    v_new_type := coalesce(p_new_enemy_type, 'enemy_a');
    v_new_max_hp := coalesce(p_new_enemy_max_hp, 90);
    v_new_hp := coalesce(p_new_enemy_hp, v_new_max_hp);
  else
    v_new_type := null;
    v_new_max_hp := null;
    v_new_hp := null;
  end if;

  return public.commit_answer_transaction(
    p_client_event_id => p_client_event_id,
    p_user_id => p_user_id,
    p_session_id => p_session_id,
    p_card_id => p_card_id,
    p_expected_card_status_before => v_progress.card_status,
    p_expected_seen_count_before => v_progress.seen_count,
    p_expected_correct_streak_before => v_progress.correct_streak,
    p_expected_wrong_streak_before => v_progress.wrong_streak,
    p_expected_fsrs_due_before => v_progress.fsrs_due_at,
    p_expected_session_enemy_hp_before => v_session.current_enemy_hp,
    p_expected_session_combo_before => v_session.current_combo,
    p_expected_session_learning_draw_index => v_session.learning_draw_index,
    p_correct => p_correct,
    p_response_time_ms => p_response_time_ms,
    p_session_mode => v_mode,
    p_fsrs_rating => v_rating,
    p_fsrs_due_at => now() + interval '1 day',
    p_fsrs_stability => 2.5,
    p_fsrs_difficulty => 5.0,
    p_fsrs_elapsed_days => 0,
    p_fsrs_scheduled_days => 1,
    p_fsrs_reps => coalesce(v_progress.fsrs_reps, 0) + 1,
    p_fsrs_lapses => coalesce(v_progress.fsrs_lapses, 0) + (case when p_correct then 0 else 1 end),
    p_fsrs_learning_steps => 0,
    p_fsrs_state => 2,
    p_fsrs_last_review_at => now(),
    p_base_damage => v_damage,
    p_speed_bonus => 0,
    p_critical => coalesce(p_critical_override, false),
    p_combo_after => v_combo_after,
    p_damage => v_damage,
    p_enemy_hp_after => v_enemy_hp_after,
    p_enemy_defeated => v_enemy_defeated,
    p_new_enemy_type => v_new_type,
    p_new_enemy_max_hp => v_new_max_hp,
    p_new_enemy_hp => v_new_hp
  );
end;
$$;

comment on function tests.call_commit_answer(uuid, uuid, uuid, uuid, boolean, text, integer, text, integer, boolean, text, integer, integer, boolean, integer) is
  'Test fixture only. Wraps commit_answer_transaction(), auto-filling the mandatory pre-answer snapshot from live sessions/user_card_progress state so tests never have to hard-code a random enemy''s HP. The two trailing *_override params exist only so group-8 tests can construct deliberately-invalid battle results.';

-- ---------------------------------------------------------------------
-- tests.assert_no_write_grants: for a table that DATABASE_SCHEMA.md §7.2
-- says is SELECT-only for `authenticated` (no INSERT/UPDATE/DELETE grant
-- at all, not merely RLS-scoped), assert all three verbs are rejected
-- with 42501 (permission denied) BEFORE any row-level/constraint concern
-- is even reached. Must be called while already authenticated as some
-- `authenticated`-role user (see tests.authenticate_as()); emits 3 TAP
-- assertions per call (one per verb), which must be reflected in the
-- calling file's plan() count.
-- ---------------------------------------------------------------------
create or replace function tests.assert_no_write_grants(p_table text) returns setof text
language plpgsql
as $$
begin
  return next throws_ok(
    format('insert into public.%I default values', p_table),
    '42501',
    format('authenticated has no INSERT grant on %s', p_table)
  );
  return next throws_ok(
    format('update public.%I set id = id', p_table),
    '42501',
    format('authenticated has no UPDATE grant on %s', p_table)
  );
  return next throws_ok(
    format('delete from public.%I', p_table),
    '42501',
    format('authenticated has no DELETE grant on %s', p_table)
  );
end;
$$;
