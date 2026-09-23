-- Grants and Row Level Security for all application tables.
-- Source of truth: docs/DATABASE_SCHEMA.md section 7 (Row Level Security),
-- section 6 (Authentication model / Admin).
--
-- Scope for this migration only: RLS enablement, grants/revokes, RLS
-- policies, and the is_admin() helper needed specifically for policies.
-- No database transaction functions, no seed data, no Auth provisioning.
--
-- ---------------------------------------------------------------------
-- Design decision -- "trusted state" tables get read-only authenticated
-- grants for now
-- ---------------------------------------------------------------------
-- DATABASE_SCHEMA.md section 10 describes submit_answer() and
-- duplicate_starter_deck() as the only sanctioned way to mutate:
--   user_card_progress, sessions, session_review_cards,
--   session_learning_queue, answer_events, daily_user_stats, xp_events
-- (and the XP/streak/selected_deck_id fields on profiles). Those functions
-- are explicitly out of scope for this migration (Phase 5), and the Phase
-- 5 brief requires that "trusted state tables that are intended to be
-- mutated only by future database functions must not receive broad
-- authenticated write grants".
--
-- So for these seven tables, `authenticated` gets SELECT only (scoped by
-- RLS to the caller's own rows, or all rows for admin) -- no INSERT/
-- UPDATE/DELETE grants at all. This is stricter than a literal reading of
-- section 7.2's "tester/application may create/update own rows", but it
-- is intentional: those writes are attributed to "the application"
-- acting through a trusted, elevated context, not to the authenticated
-- role directly. Once duplicate_starter_deck() and submit_answer() exist
-- as SECURITY DEFINER functions (Phase 6/7), they will write through
-- their own elevated privileges (as the function owner), bypassing the
-- lack of direct table grants on the authenticated role entirely -- the
-- same mechanism is_admin() below relies on. Until then, nothing can
-- write to these seven tables, including starting a session; that is
-- expected and matches the documented implementation order (RLS before
-- the transaction functions).
--
-- profiles, decks, and cards are different: sections 7.2's write rules
-- for those three are direct tester actions (edit nickname, manage own
-- decks/cards), not steps inside a multi-table trusted transaction, so
-- they get real INSERT/UPDATE grants below, scoped by RLS + (for
-- profiles) column-level privileges.

-- =========================================================================
-- is_admin() helper
-- =========================================================================
--
-- SECURITY DEFINER so it runs as the function owner (the migration role,
-- effectively table-owner-equivalent) rather than the calling
-- `authenticated` role. Table owners bypass RLS by default (tables here
-- are only ENABLEd, not FORCEd), so the query inside this function does
-- not re-trigger the profiles SELECT policies that call is_admin() --
-- there is no recursion. search_path is pinned to '' and every reference
-- is schema-qualified so the function cannot be hijacked by a
-- search-path-relative object created by a lower-privileged role.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

comment on function public.is_admin() is
  'SECURITY DEFINER: bypasses RLS on public.profiles (runs as table owner) so RLS policies that call this do not recurse into themselves. search_path pinned to empty and all references schema-qualified. Returns false when unauthenticated or non-admin.';

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- =========================================================================
-- profiles
-- =========================================================================

alter table public.profiles enable row level security;

revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
-- Column-level grant: authenticated may only ever SET nickname in an
-- UPDATE statement's target list. role, account_status,
-- exclude_from_analytics, total_xp, level, streak fields,
-- selected_deck_id, and every other control/analytics field are not
-- grantable here, so a direct UPDATE touching them is rejected before RLS
-- is even evaluated.
grant update (nickname) on table public.profiles to authenticated;

create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

create policy profiles_select_admin
  on public.profiles
  for select
  to authenticated
  using (public.is_admin());

create policy profiles_update_own
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- =========================================================================
-- decks
-- =========================================================================

alter table public.decks enable row level security;

revoke all on table public.decks from anon, authenticated;
grant select, insert, update on table public.decks to authenticated;
-- No delete grant: hard delete is not part of normal authenticated
-- access. Soft delete is an UPDATE that sets deleted_at.

create policy decks_select_own_or_official_or_admin
  on public.decks
  for select
  to authenticated
  using (
    owner_user_id = auth.uid()
    or is_official = true
    or public.is_admin()
  );

create policy decks_insert_own
  on public.decks
  for insert
  to authenticated
  with check (
    owner_user_id = auth.uid()
    and is_official = false
  );

-- owner_user_id = auth.uid() alone already excludes official templates
-- (owner_user_id is null for those), but is_official is still checked in
-- with check so a tester cannot flip their own deck into an official one.
create policy decks_update_own
  on public.decks
  for update
  to authenticated
  using (owner_user_id = auth.uid())
  with check (
    owner_user_id = auth.uid()
    and is_official = false
  );

-- =========================================================================
-- cards
-- =========================================================================

alter table public.cards enable row level security;

revoke all on table public.cards from anon, authenticated;
grant select, insert, update on table public.cards to authenticated;
-- No delete grant: hard delete is not part of normal authenticated
-- access. Soft delete is an UPDATE that sets deleted_at.

-- Ownership is checked through the parent deck, per the Phase 5 brief:
-- cards has no owner_user_id of its own to compare against auth.uid().
create policy cards_select_own_or_official_or_admin
  on public.cards
  for select
  to authenticated
  using (
    public.is_admin()
    or exists (
      select 1
      from public.decks d
      where d.id = cards.deck_id
        and (d.owner_user_id = auth.uid() or d.is_official = true)
    )
  );

create policy cards_insert_own_deck
  on public.cards
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.decks d
      where d.id = cards.deck_id
        and d.owner_user_id = auth.uid()
    )
  );

create policy cards_update_own_deck
  on public.cards
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.decks d
      where d.id = cards.deck_id
        and d.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.decks d
      where d.id = cards.deck_id
        and d.owner_user_id = auth.uid()
    )
  );

-- =========================================================================
-- user_card_progress (trusted-state -- see design decision note above)
-- =========================================================================

alter table public.user_card_progress enable row level security;

revoke all on table public.user_card_progress from anon, authenticated;
grant select on table public.user_card_progress to authenticated;

create policy user_card_progress_select_own_or_admin
  on public.user_card_progress
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- =========================================================================
-- sessions (trusted-state -- see design decision note above)
-- =========================================================================

alter table public.sessions enable row level security;

revoke all on table public.sessions from anon, authenticated;
grant select on table public.sessions to authenticated;

create policy sessions_select_own_or_admin
  on public.sessions
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- =========================================================================
-- session_review_cards (trusted-state -- see design decision note above)
-- =========================================================================

alter table public.session_review_cards enable row level security;

revoke all on table public.session_review_cards from anon, authenticated;
grant select on table public.session_review_cards to authenticated;

create policy session_review_cards_select_own_session_or_admin
  on public.session_review_cards
  for select
  to authenticated
  using (
    public.is_admin()
    or exists (
      select 1
      from public.sessions s
      where s.id = session_review_cards.session_id
        and s.user_id = auth.uid()
    )
  );

-- =========================================================================
-- session_learning_queue (trusted-state -- see design decision note above)
-- =========================================================================

alter table public.session_learning_queue enable row level security;

revoke all on table public.session_learning_queue from anon, authenticated;
grant select on table public.session_learning_queue to authenticated;

create policy session_learning_queue_select_own_session_or_admin
  on public.session_learning_queue
  for select
  to authenticated
  using (
    public.is_admin()
    or exists (
      select 1
      from public.sessions s
      where s.id = session_learning_queue.session_id
        and s.user_id = auth.uid()
    )
  );

-- =========================================================================
-- answer_events (append-only + trusted-state -- see design decision note
-- above)
-- =========================================================================

alter table public.answer_events enable row level security;

revoke all on table public.answer_events from anon, authenticated;
grant select on table public.answer_events to authenticated;
-- Deliberately no insert/update/delete grant. Append-only insertion goes
-- through submit_answer() once it exists (Phase 7), which writes as the
-- function owner. Omitting the grants here -- rather than relying on RLS
-- alone -- means normal authenticated sessions cannot UPDATE/DELETE rows
-- even if a future policy mistake were made.

create policy answer_events_select_own_or_admin
  on public.answer_events
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- =========================================================================
-- daily_user_stats (trusted-state -- see design decision note above)
-- =========================================================================

alter table public.daily_user_stats enable row level security;

revoke all on table public.daily_user_stats from anon, authenticated;
grant select on table public.daily_user_stats to authenticated;

create policy daily_user_stats_select_own_or_admin
  on public.daily_user_stats
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- =========================================================================
-- xp_events (append-only + trusted-state -- see design decision note
-- above)
-- =========================================================================

alter table public.xp_events enable row level security;

revoke all on table public.xp_events from anon, authenticated;
grant select on table public.xp_events to authenticated;
-- Deliberately no insert/update/delete grant, for the same reason as
-- answer_events: the XP ledger is written exclusively by trusted
-- transaction logic (Phase 7), not directly by authenticated sessions.

create policy xp_events_select_own_or_admin
  on public.xp_events
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());
