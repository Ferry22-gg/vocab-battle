# Vocab Battle database test suite

pgTAP integration tests for the `feat/database-schema` branch. Standard
Supabase tooling (`supabase test db`, which wraps `pg_prove`/`pgtap`) --
nothing custom-built.

## Layout

```
supabase/tests/
  README.md                          this file
  fixtures/
    000_test_helpers.inc              shared setup -- NOT a test itself
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
files follow.

**The shared helper file is `supabase/tests/fixtures/000_test_helpers.inc`
-- inside `supabase/tests/`, with a non-`.sql` extension.** Two real
`supabase test db` runs against an actual local Docker container each
disproved a prior placement, in opposite directions:

1. It first lived at `supabase/tests/fixtures/000_test_helpers.sql`.
   `supabase test db` recursively discovers and runs every `*.sql` file
   anywhere under `supabase/tests/` (subdirectories included) as its own
   independent pgTAP test, so this fixtures-only file (no
   `plan()`/`finish()`) was executed on its own and failed with
   "No plan found in TAP output".
2. The fix for that -- moving it to a sibling directory,
   `supabase/test-support/`, entirely outside `supabase/tests/` -- broke
   the opposite way: `supabase test db` runs `pg_prove`/`psql` inside a
   Docker container that only mounts the `supabase/tests/` tree. A path
   outside it, even a filesystem sibling on the host, doesn't exist
   inside that container, so `\ir ../test-support/000_test_helpers.sql`
   failed with "No such file or directory" before a single assertion ran.

The actual constraint, confirmed from both directions: the file must live
**inside** `supabase/tests/` (so the container can see it) **and** must
not have a `.sql` extension (so `*.sql` discovery doesn't also try to run
it as its own test) -- hence `fixtures/000_test_helpers.inc`. `psql`'s
`\ir` reads a file regardless of its extension; only `supabase test db`'s
own test-discovery cares about `.sql` specifically.

Every real test file pulls the helpers in with its first line:

```sql
\ir fixtures/000_test_helpers.inc
```

`\ir` (include-relative) is a standard psql meta-command, not a custom
framework, and resolves relative to the *including file's own directory*
(`supabase/tests/`), not the caller's cwd -- `supabase test db` shells out
to `psql` per file, so this is the same sharing mechanism pgTAP's own docs
recommend for common setup code, adapted to this CLI's specific
discovery-plus-container-mount behavior.

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
  GoTrue) plus the matching `public.profiles` row. Only ever called while
  the session is still the privileged connecting/table-owner role (see
  "Schema/function privileges" below) -- never after switching.
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

**`authenticate_as()`/`authenticate_as_service_role()` must always be
called from the privileged connecting role, never from each other.**
`service_role` is not a member of `authenticated` (or vice versa), so
`SET LOCAL ROLE authenticated` fails if issued while already
`service_role`. Every switch in this suite is therefore
`clear_auth()` → `authenticate_as*()`, never `authenticate_as*()` →
`authenticate_as*()` directly (verified by grep across every file).

**Test-only public_user_id values never collide with real Beta accounts:**
every test uses `test_g<group>_<role>`-style ids (e.g. `test_g5_tester_a`),
never `001`-`030`/`999`.

## Schema/function privileges for the switched-into test roles

A real `supabase test db` run failed every file that switches role with
`ERROR: permission denied for schema tests` the moment it called
`tests.clear_auth()` (or any other `tests.*` function) while the session
was `authenticated`/`service_role`. Root cause: `CREATE SCHEMA` does not
grant `USAGE` on the new schema to anyone but its owner. Unlike `public`,
whose `USAGE`-to-`PUBLIC` grant is a Postgres/Supabase default that
already existed before this suite touched anything, `tests` is a brand
new schema with no such default -- so merely having `EXECUTE` on a
function inside it (which Postgres functions get from `PUBLIC` by
default) was never enough. Schema `USAGE` is a separate, prerequisite
privilege layer checked before a function can even be resolved.

Fix, at the bottom of `fixtures/000_test_helpers.inc` (after every function is
defined): grant `USAGE ON SCHEMA tests` to `authenticated` and
`service_role` (the only two roles this suite ever switches into), then
explicitly revoke the Postgres-default `PUBLIC EXECUTE` from every
function in the schema and grant `EXECUTE` back only on the specific
functions each switched-role context actually calls while already
switched:

| Function | Granted to | Why |
|---|---|---|
| `tests.clear_auth()` | `authenticated`, `service_role` | the escape hatch every switched context needs |
| `tests.throws_sqlstate()` | `authenticated`, `service_role` | used throughout both kinds of scenario |
| `tests.assert_no_write_grants()` | `authenticated` | only ever called while a tester |
| `tests.call_commit_answer()` | `service_role` | only ever called as the trusted server-side caller |

`tests.create_test_profile()`, `tests.authenticate_as()`,
`tests.authenticate_as_service_role()`, and `tests.official_deck_id()` get
no such grant -- they are never called while already switched anywhere in
this suite (verified by grep), so only the privileged connecting role can
call them. That's the existing "must run before switching" constraint,
now enforced by the database itself instead of only documented.

The `REVOKE`/`GRANT` statements are resolved dynamically against
`pg_proc`/`pg_namespace` rather than hand-typed function signatures,
specifically to avoid transcribing `tests.call_commit_answer()`'s
15-argument signature by hand into a `GRANT` statement (exactly the kind
of thing that silently drifts out of sync and goes unnoticed until a real
run).

**These are test-only grants, living entirely inside `fixtures/000_test_helpers.inc`
(never a `supabase/migrations/` file), scoped to a schema that is not part
of the application schema and is never exposed through the Data API (see
`supabase/config.toml`'s `[api] schemas`).** They cannot weaken any
production RLS policy or table grant -- they only unlock this suite's own
test-only helper functions for the two roles this suite itself switches
into.

## `throws_ok()` vs. `tests.throws_sqlstate()`

A real `supabase test db` run showed pgTAP's installed `throws_ok(sql,
code_or_message, description)` does **not** reliably treat a 5-character
value like `'42501'` as a SQLSTATE -- it was compared against the raised
error's *message text* instead, so calls like
`throws_ok(sql, '42501', 'authenticated cannot directly UPDATE profiles.role')`
failed even though the SQLSTATE genuinely matched, because the
description text obviously never matches Postgres's own message
(`permission denied for table profiles`).

Every `throws_ok()` call in this suite only ever wanted the SQLSTATE
checked, with the third argument used purely as a human-readable test
description -- never as an expected message pattern. Rather than depend
on exactly how the installed pgTAP disambiguates errcode vs. message,
every call across all 12 files (not just the one originally reported) was
replaced with `tests.throws_sqlstate(sql, expected_sqlstate,
description)` -- a small function in `fixtures/000_test_helpers.inc` that checks
`SQLSTATE` only, via `GET STACKED DIAGNOSTICS`, and reports through
pgTAP's own unambiguous `ok()`/`diag()` primitives. `lives_ok()` is
unaffected (it has no code/message argument at all) and is still used
as-is.

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

## Status

See the harness-fix session notes (reported to the user, not duplicated
here) for the exact `pnpm exec supabase test db` result as of the last
run. Every file passes static verification: balanced `$$`/dollar-quoting,
balanced parentheses, `SELECT plan(N)` matching the actual number of
assertion-emitting statements, and no role-switch called from a role it
isn't reachable from. Static verification catches structural mistakes but
cannot substitute for actually running the suite.
