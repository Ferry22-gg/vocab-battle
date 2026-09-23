# Vocab Battle database test suite

pgTAP integration tests for the `feat/database-schema` branch. Standard
Supabase tooling (`supabase test db`, which wraps `pg_prove`/`pgtap`) --
nothing custom-built.

## Layout

```
supabase/tests/
  README.md                          this file
  fixtures/
    000_test_helpers.sql              shared setup -- NOT a test itself
  001_schema_starter_data_test.sql    group 1
  002_starter_deck_duplication_test.sql
  003_add_card_to_deck_test.sql
  004_select_deck_test.sql
  005_rls_isolation_test.sql
  006_column_grants_test.sql
  007_sessions_test.sql
  008_commit_answer_transaction_test.sql
  009_xp_and_level_test.sql
  010_daily_goal_and_streak_test.sql
  011_append_only_history_test.sql
  012_soft_delete_test.sql
```

`supabase test new <name>` (this CLI, v2.117.0) scaffolds new test files
directly under `supabase/tests/*_test.sql` -- that is the convention these
files follow. `fixtures/000_test_helpers.sql` deliberately lives one level
down, in `fixtures/`, so it is never itself picked up and run as a test;
every real test file pulls it in with the first line:

```sql
\ir fixtures/000_test_helpers.sql
```

`\ir` (include-relative) is a standard psql meta-command, not a custom
framework -- `supabase test db` shells out to `psql` per file, so this is
the same sharing mechanism pgTAP's own docs recommend for common setup.

## Running

```sh
# once, against a running local database:
psql "$LOCAL_DB_URL" -c 'create extension if not exists pgtap;'

# then:
supabase test db supabase/tests
# or, to run one file while iterating:
supabase test db supabase/tests/008_commit_answer_transaction_test.sql
```

Every file wraps itself in `BEGIN; ... ROLLBACK;`, so tests never leave
residue and can run in any order against the same database -- including
against a database that already has real data in it (the official starter
decks from `20260923220000_official_starter_deck_data.sql`, which several
tests read by name via `tests.official_deck_id()` rather than duplicating
or hard-coding their UUIDs).

## How Auth identities are simulated (no real Supabase Auth involved)

`supabase start` provisions the full local Postgres image, which already
has the `auth` schema (from GoTrue's own migrations) before any project
migration in `supabase/migrations/` runs. `auth.uid()` reads the
`request.jwt.claim.sub` / `request.jwt.claims` Postgres GUCs -- the same
ones PostgREST sets from a real, signature-verified JWT on every API
request.

These tests never go through the GoTrue HTTP signup/login flow (issuing
real JWTs, hashing real passwords, etc. is explicitly the later Auth
branch's job, not this one's). Instead:

- `tests.create_test_profile(id, public_user_id, role, account_status, exclude_from_analytics)`
  inserts a minimal synthetic row directly into `auth.users` (bypassing
  GoTrue) plus the matching `public.profiles` row.
- `tests.authenticate_as(id)` sets those same `request.jwt.claim*` GUCs and
  switches the session to `SET LOCAL ROLE authenticated` -- exactly the
  state PostgREST would leave a real request in after verifying that
  user's real JWT. From that point on, every RLS policy and every
  `auth.uid()`-based `SECURITY DEFINER` check behaves identically to
  production for that (synthetic) signed-in user.
- `tests.authenticate_as_service_role()` switches to `service_role`, for
  exercising `commit_answer_transaction()` the way the trusted Next.js
  server-side path actually calls it (never via `auth.uid()`).
- `tests.clear_auth()` drops back to the privileged connecting role
  (table owner, bypasses RLS) -- used for fixture setup that must arrange
  state (e.g. soft-deleting a card, backdating a streak) without RLS
  getting in the way, and for ground-truth assertions.

Every GUC is set with `set_config(..., true)` (`is_local`), and every role
switch is `SET LOCAL`, so all of it is scoped to the enclosing
`BEGIN`/`ROLLBACK` of that one file and never leaks into another.

**Test-only public_user_id values never collide with real Beta accounts:**
every test uses `test_g<group>_<role>`-style ids (e.g. `test_g5_tester_a`),
never `001`-`030`/`999`.

## What this does NOT simulate (Auth-branch scope, not this suite's)

- Real password hashing/verification, email confirmation, refresh tokens,
  JWT signature verification, or any GoTrue business rule.
- Provisioning the real Beta accounts (`001`-`030`, `999`) -- out of scope
  for this branch entirely per the current task.
- True multi-connection concurrency (e.g. two simultaneous
  `duplicate_starter_deck()` calls racing on the same row lock). A pgTAP
  file is one connection / one transaction; genuine lock-contention testing
  needs a separate, later harness (e.g. two `psql` processes racing against
  a real local instance) and is explicitly marked with `SELECT skip(...)`
  where it would otherwise be silently absent (see
  `002_starter_deck_duplication_test.sql`).

## What can run today vs. what needs a real instance

**Nothing in this suite has been executed.** This sandbox has no Docker and
no local Postgres/psql (confirmed during this session), so
`supabase test db` cannot run here. Every file has instead been verified
*statically*: balanced `$$`/dollar-quoting, balanced parentheses, and --
critically for pgTAP -- that each file's `SELECT plan(N)` matches the
actual number of assertion-emitting statements it contains (`is`, `ok`,
`isnt`, `throws_ok`, `lives_ok`, `skip`, and `tests.assert_no_write_grants()`,
which emits 3 each). All 12 files plus the fixtures file pass that check.

Static verification catches structural mistakes (a bad plan count, an
unbalanced quote, a typo'd function signature) but **cannot** confirm the
tests pass -- only a real `supabase start` + `supabase test db` run can. Do
not treat "this file is statically well-formed" as "this test passes."

Once a local instance is available, every test in this suite can run
immediately (all use only pgTAP + the local `auth` schema + this
project's own migrations, all of which `supabase start` provisions).
None of the 12 groups require the real Beta accounts, a linked project, or
the Next.js app.
