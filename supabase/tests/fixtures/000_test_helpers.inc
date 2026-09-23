-- Shared pgTAP test fixtures for the Vocab Battle database test suite.
--
-- LOCATION AND EXTENSION (harness fix, 2026-09-24, second iteration):
-- this file lives at supabase/tests/fixtures/000_test_helpers.inc.
--
-- Two real `supabase test db` runs against an actual local Docker
-- container each disproved a prior assumption here, in opposite
-- directions:
--
--   1. First it lived at supabase/tests/fixtures/000_test_helpers.sql.
--      `supabase test db` recursively discovers and runs every *.sql
--      file anywhere under supabase/tests/ (subdirectories included) as
--      its own independent pgTAP test, so this fixtures-only file (no
--      plan()/finish()) was executed on its own and failed with
--      "No plan found in TAP output".
--   2. The fix for that -- moving the file to a sibling directory,
--      supabase/test-support/, entirely outside supabase/tests/ -- broke
--      in the opposite way: `supabase test db` runs pg_prove/psql inside
--      a Docker container that only mounts (i.e. can see) the
--      supabase/tests/ directory tree. A path outside it, even a
--      filesystem sibling on the host, does not exist inside that
--      container, so `\ir ../test-support/000_test_helpers.sql` failed
--      with "No such file or directory" before a single assertion ran.
--
-- The actual constraint, now confirmed from both directions: the file
-- MUST live inside supabase/tests/ (so the container can see it) AND
-- must NOT have a .sql extension (so `supabase test db`'s *.sql
-- discovery does not also try to run it as its own test). Hence
-- supabase/tests/fixtures/000_test_helpers.inc -- ordinary SQL/psql
-- content, just not named *.sql. Every real test file includes it via a
-- psql \ir (include-relative) meta-command as its first line, e.g. from
-- supabase/tests/001_..._test.sql:
--
--   \ir fixtures/000_test_helpers.inc
--
-- `supabase test db` shells out to psql per file, and \ir resolves
-- relative to the INCLUDING file's own directory, not the caller's cwd,
-- and reads whatever file it's pointed at regardless of that file's
-- extension -- \ir is a standard psql feature (not a custom test
-- framework), and this pattern (a non-.sql include alongside .sql test
-- files) is the same sharing mechanism pgTAP's own documentation
-- recommends for common setup code, adapted to this CLI's specific
-- discovery + container-mount behavior.
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
-- this database test suite -- see supabase/tests/README.md for exactly
-- which of the 12 required test groups fall on that side of the line.
--
-- ---------------------------------------------------------------------
-- Schema/function privileges for the two switched-into test roles
-- (harness fix, 2026-09-24)
-- ---------------------------------------------------------------------
--
-- A real `supabase test db` run failed every file that switches role
-- with "permission denied for schema tests" the moment it called
-- tests.clear_auth() (or any other tests.* function) while the session
-- was `authenticated`/`service_role`. Root cause: CREATE SCHEMA does not
-- grant USAGE on the new schema to anyone but its owner -- unlike
-- `public`, whose USAGE-to-PUBLIC grant is a Postgres/Supabase default
-- that already existed before this suite touched anything, `tests` is a
-- brand-new schema with no such default, so simply having EXECUTE on a
-- function inside it (which Postgres functions get from PUBLIC by
-- default) was never enough -- schema USAGE is a separate, prerequisite
-- privilege layer checked before a function can even be resolved.
--
-- Fix, applied at the bottom of this file (after every function below is
-- defined): grant USAGE ON SCHEMA tests to authenticated and
-- service_role (the only two roles this suite ever switches into), then
-- explicitly REVOKE the Postgres-default PUBLIC EXECUTE from every
-- function in this schema and GRANT EXECUTE back only on the specific
-- functions each switched-role context actually calls while already
-- switched (per DATABASE_SCHEMA.md-style least privilege, and per
-- review requirement: "ensure authenticated/service_role test contexts
-- can use only the helper functionality necessary for the test
-- harness"). tests.create_test_profile()/authenticate_as()/
-- authenticate_as_service_role()/official_deck_id() are NEVER called
-- while already switched anywhere in this suite (verified by grep against
-- every test file), so they get no such grant -- only the privileged
-- connecting role (which owns everything and is unaffected by any of
-- these GRANT/REVOKE statements) can call them, which is exactly the
-- existing "must run before switching" constraint, now enforced by the
-- database itself instead of just documented.
--
-- These are test-only grants living entirely inside this file (never a
-- supabase/migrations/ file), scoped to a schema that is not part of the
-- application's schema at all and is never exposed through the Data API
-- (see supabase/config.toml's `[api] schemas`) -- they do not touch, and
-- cannot weaken, any production RLS policy or table grant.

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
-- auth.users, so calling this function after switching role would fail
-- -- and, per the grant scheme at the bottom of this file, now cannot
-- even be attempted (no EXECUTE grant to either switched role). If a
-- future test ever needs to create a profile mid-scenario, call
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
-- assertions that must see rows regardless of RLS. This is the one
-- function every switched-role context needs to be able to call (it's
-- how they escape back), so it alone is granted to both authenticated
-- and service_role below.
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
-- tests.throws_sqlstate: assert that executing p_sql raises EXACTLY
-- p_expected_sqlstate, checking the SQLSTATE only -- never the error
-- message text.
--
-- HARNESS FIX (2026-09-24): a real `supabase test db` run showed the
-- installed pgTAP's throws_ok(sql, code_or_message, description) does
-- NOT reliably treat a 5-character value like '42501' as a SQLSTATE --
-- it was instead compared against the raised error's MESSAGE text, so
-- throws_ok(sql, '42501', 'authenticated cannot directly UPDATE
-- profiles.role') failed even though the SQLSTATE genuinely matched,
-- because the description string obviously never matches Postgres's own
-- message text ("permission denied for table profiles"). Every call
-- across this suite only ever wanted the SQLSTATE checked, with the
-- third argument used purely as a human-readable test description --
-- never as an expected message pattern. Rather than depend on pgTAP's
-- own errcode-vs-message disambiguation (whatever it turns out to
-- actually be in the installed version), this function does the check
-- directly and unambiguously: catch any exception from p_sql, compare
-- ONLY its returned SQLSTATE, and report through pgTAP's own ok()/diag()
-- primitives (which have no such ambiguity -- ok() takes a boolean, not
-- a value to pattern-match). Every throws_ok(sql, code, description)
-- call in this suite -- including inside tests.assert_no_write_grants()
-- below -- was replaced with tests.throws_sqlstate(sql, code,
-- description) for this reason.
-- ---------------------------------------------------------------------
create or replace function tests.throws_sqlstate(
  p_sql text,
  p_expected_sqlstate text,
  p_description text
) returns setof text
language plpgsql
as $$
declare
  v_actual_sqlstate text;
  v_ok boolean;
begin
  begin
    execute p_sql;
    v_actual_sqlstate := null;
  exception when others then
    get stacked diagnostics v_actual_sqlstate = returned_sqlstate;
  end;

  v_ok := (v_actual_sqlstate is not distinct from p_expected_sqlstate);
  return next ok(v_ok, p_description);
  if not v_ok then
    return next diag(format(
      'expected SQLSTATE %s but got %s',
      p_expected_sqlstate,
      coalesce(v_actual_sqlstate, '(no exception raised)')
    ));
  end if;
end;
$$;

comment on function tests.throws_sqlstate(text, text, text) is
  'Test fixture only. SQLSTATE-only replacement for pgTAP''s throws_ok(), whose installed errcode-vs-message disambiguation proved unreliable against a real Supabase pgTAP run (see the comment above this function). Never matches on error message text.';

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
  return next tests.throws_sqlstate(
    format('insert into public.%I default values', p_table),
    '42501',
    format('authenticated has no INSERT grant on %s', p_table)
  );
  return next tests.throws_sqlstate(
    format('update public.%I set id = id', p_table),
    '42501',
    format('authenticated has no UPDATE grant on %s', p_table)
  );
  return next tests.throws_sqlstate(
    format('delete from public.%I', p_table),
    '42501',
    format('authenticated has no DELETE grant on %s', p_table)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Schema/function grants for the switched-into test roles (see the
-- header comment above for the full "permission denied for schema
-- tests" root cause and rationale). Placed last, after every function
-- above is defined, since the dynamic REVOKE loop below discovers them
-- via pg_proc.
-- ---------------------------------------------------------------------

grant usage on schema tests to authenticated, service_role;

-- Strip the Postgres-default PUBLIC EXECUTE from every function in this
-- schema, driven off the catalog rather than hand-typed signatures (this
-- schema's functions include a 15-argument one -- transcribing that by
-- hand into a REVOKE statement is exactly the kind of thing that goes
-- unnoticed until a real run, which is the whole reason this file is
-- being hardened right now).
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'tests'
  loop
    execute format('revoke all on function %s from public', r.sig);
  end loop;
end;
$$;

-- Grant back only what each switched-role context actually calls while
-- already switched (verified by grep against every supabase/tests/*.sql
-- file at the time this was written):
--   authenticated -> tests.clear_auth(), tests.throws_sqlstate(),
--                     tests.assert_no_write_grants()
--   service_role  -> tests.clear_auth(), tests.throws_sqlstate(),
--                     tests.call_commit_answer()
-- Resolved dynamically for the same hand-typing-risk reason as the loop
-- above.
do $$
declare
  v_sig text;
begin
  select p.oid::regprocedure::text into v_sig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'tests' and p.proname = 'clear_auth';
  execute format('grant execute on function %s to authenticated, service_role', v_sig);

  select p.oid::regprocedure::text into v_sig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'tests' and p.proname = 'throws_sqlstate';
  execute format('grant execute on function %s to authenticated, service_role', v_sig);

  select p.oid::regprocedure::text into v_sig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'tests' and p.proname = 'assert_no_write_grants';
  execute format('grant execute on function %s to authenticated', v_sig);

  select p.oid::regprocedure::text into v_sig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'tests' and p.proname = 'call_commit_answer';
  execute format('grant execute on function %s to service_role', v_sig);
end;
$$;
