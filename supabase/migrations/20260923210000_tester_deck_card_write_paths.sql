-- Tester write-path hardening for decks/cards, plus two new trusted
-- workflows: add_card_to_deck() and select_deck().
--
-- Product decisions this migration implements (post-audit follow-up to
-- 20260923180512_grants_and_rls.sql):
--
--   1. Custom deck creation is NOT part of the MVP. The only deck-creation
--      path is official template -> duplicate_starter_deck(). authenticated
--      loses direct INSERT on public.decks.
--
--   2. Personal card creation IS part of the MVP, but only through a
--      trusted function (add_card_to_deck()), never a direct INSERT,
--      because every new card must atomically receive its matching NEW
--      user_card_progress row -- something a bare INSERT on public.cards
--      cannot guarantee. authenticated loses direct INSERT on public.cards.
--
--   3. authenticated's direct UPDATE on public.cards is narrowed from
--      whole-row to (front, back, extra_content, sort_order, deleted_at)
--      via column-level grants. Lineage/identity columns (id, deck_id,
--      created_by_user_id, source_card_id, created_at, updated_at) are not
--      grantable, so a direct UPDATE touching them is rejected before RLS
--      is even evaluated -- the same pattern already used for
--      profiles.nickname in the grants/RLS migration.
--
--   4. authenticated's direct UPDATE on public.decks is narrowed the same
--      way, to (name, description, sort_order, archived_at, deleted_at).
--
--   5. select_deck(p_deck_id) is added so a tester can switch
--      profiles.selected_deck_id among their own decks without re-running
--      duplicate_starter_deck() (which only knows how to select an
--      official-template-sourced deck). authenticated still has no direct
--      UPDATE grant on profiles.selected_deck_id.
--
--   6. Both new functions require account_status = 'active' AND
--      role = 'tester' on the caller's profile, identical to the Phase 6A
--      guard in duplicate_starter_deck()/start_or_resume_session()/
--      finish_session() -- admin cannot persist learner content/state
--      through either function. Admin Preview itself is explicitly NOT
--      implemented here (deferred to a later, client-side-only
--      application-layer simulation).
--
-- This migration does not edit any previously committed migration file --
-- the decks_insert_own and cards_insert_own_deck policies from
-- 20260923180512_grants_and_rls.sql are dropped here (they become
-- unreachable dead policies once the corresponding INSERT grant is
-- revoked, and leaving them in place would be misleading), and the two new
-- functions are created fresh. Per DATABASE_SCHEMA.md 15 (migration
-- immutability), evolving the live schema through a new migration file is
-- the correct mechanism -- this is not the same as editing an old file.
--
-- Both new functions follow the same SECURITY DEFINER hardening already
-- established by duplicate_starter_deck()/start_or_resume_session()/
-- finish_session(): fixed search_path = '', every reference schema-
-- qualified, acting user derived only from auth.uid() (never a client-
-- supplied parameter), independent ownership re-validation inside the
-- function body (SECURITY DEFINER bypasses the caller's own RLS), and
-- REVOKE ALL FROM PUBLIC followed by a minimum GRANT EXECUTE TO
-- authenticated.

-- =========================================================================
-- decks: remove direct INSERT, narrow direct UPDATE to safe metadata
-- =========================================================================

-- Dead policy once INSERT is revoked below -- no authenticated statement
-- can ever satisfy the INSERT privilege check to reach it.
drop policy if exists decks_insert_own on public.decks;

revoke insert on table public.decks from authenticated;

-- Replace the whole-row UPDATE grant with a column-scoped one. The
-- existing decks_update_own policy (owner_user_id = auth.uid(), with
-- check is_official = false) is unchanged and still applies to whichever
-- columns a statement is now allowed to SET -- id, owner_user_id,
-- source_deck_id, is_template, is_official, front_language, back_language,
-- created_at, updated_at are simply never in an authenticated statement's
-- target list, so any attempt to touch them is rejected before RLS runs.
revoke update on table public.decks from authenticated;
grant update (name, description, sort_order, archived_at, deleted_at)
  on table public.decks to authenticated;

-- =========================================================================
-- cards: remove direct INSERT, narrow direct UPDATE to safe fields
-- =========================================================================

-- Dead policy once INSERT is revoked below, for the same reason as
-- decks_insert_own above.
drop policy if exists cards_insert_own_deck on public.cards;

revoke insert on table public.cards from authenticated;

-- Replace the whole-row UPDATE grant with a column-scoped one. The
-- existing cards_update_own_deck policy (ownership checked through the
-- parent deck) is unchanged and still applies -- id, deck_id,
-- created_by_user_id, source_card_id, created_at, updated_at are not
-- grantable, so lineage/identity fields cannot be rewritten by a direct
-- UPDATE regardless of deck ownership.
revoke update on table public.cards from authenticated;
grant update (front, back, extra_content, sort_order, deleted_at)
  on table public.cards to authenticated;

-- =========================================================================
-- add_card_to_deck()
-- =========================================================================

create or replace function public.add_card_to_deck(
  p_deck_id uuid,
  p_front text,
  p_back text,
  p_extra_content jsonb default '{}'::jsonb,
  p_sort_order integer default 0
)
returns public.cards
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_profile public.profiles;
  v_deck public.decks;
  v_new_card public.cards;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'add_card_to_deck: no authenticated user'
      using errcode = '28000';
  end if;

  select * into v_profile
  from public.profiles
  where id = v_user_id;

  if not found then
    raise exception 'add_card_to_deck: no profile for caller'
      using errcode = '28000';
  end if;

  -- Tester-only persistence: admin accounts must not create learner
  -- content through this function (DATABASE_SCHEMA.md 4.1/6.3 pattern,
  -- same guard as duplicate_starter_deck()/start_or_resume_session()/
  -- finish_session()).
  if v_profile.account_status <> 'active' or v_profile.role <> 'tester' then
    raise exception 'add_card_to_deck: caller is not an active tester account'
      using errcode = '28000';
  end if;

  -- Lock the target deck row so a concurrent archive/soft-delete of this
  -- deck cannot slip in between this validation and the INSERT below.
  -- Ownership, soft-delete, and archive state are all re-validated here
  -- independently of RLS, since SECURITY DEFINER bypasses it.
  select * into v_deck
  from public.decks
  where id = p_deck_id
    and owner_user_id = v_user_id
    and deleted_at is null
    and archived_at is null
  for update;

  if not found then
    raise exception 'add_card_to_deck: deck % does not belong to caller, or is deleted/archived', p_deck_id
      using errcode = '42501';
  end if;

  if p_front is null or length(trim(p_front)) = 0 then
    raise exception 'add_card_to_deck: front must not be empty'
      using errcode = '22023';
  end if;

  if p_back is null or length(trim(p_back)) = 0 then
    raise exception 'add_card_to_deck: back must not be empty'
      using errcode = '22023';
  end if;

  -- Card + its matching NEW user_card_progress row are inserted in the
  -- same function invocation (== same transaction from the caller's
  -- perspective), so the pair is atomic: either both rows exist or
  -- neither does. source_card_id is NULL -- this card has no official
  -- lineage, it is personally authored (DATABASE_SCHEMA.md 4.3).
  insert into public.cards (
    deck_id, front, back, extra_content,
    created_by_user_id, source_card_id, sort_order
  )
  values (
    p_deck_id, p_front, p_back, coalesce(p_extra_content, '{}'::jsonb),
    v_user_id, null, coalesce(p_sort_order, 0)
  )
  returning * into v_new_card;

  insert into public.user_card_progress (
    user_id, card_id, card_status, seen_count, correct_streak, wrong_streak
  )
  values (v_user_id, v_new_card.id, 'NEW', 0, 0, 0);

  return v_new_card;
end;
$$;

comment on function public.add_card_to_deck(uuid, text, text, jsonb, integer) is
  'SECURITY DEFINER trusted workflow. Adds a personally-authored card (source_card_id = NULL) to one of the caller''s own, non-deleted, non-archived decks, and atomically inserts its matching NEW user_card_progress row -- authenticated has no direct INSERT on public.cards specifically so this pairing cannot be skipped. Derives the acting user from auth.uid() only; requires an active tester account (admin is rejected). search_path pinned to empty; all references schema-qualified.';

revoke all on function public.add_card_to_deck(uuid, text, text, jsonb, integer) from public;
grant execute on function public.add_card_to_deck(uuid, text, text, jsonb, integer) to authenticated;

-- =========================================================================
-- select_deck()
-- =========================================================================

create or replace function public.select_deck(p_deck_id uuid)
returns public.decks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_deck public.decks;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'select_deck: no authenticated user'
      using errcode = '28000';
  end if;

  -- Tester-only persistence, same guard as add_card_to_deck() and the
  -- Phase 6A functions: admin accounts must not change learner state
  -- through this function.
  if not exists (
    select 1
    from public.profiles
    where id = v_user_id
      and account_status = 'active'
      and role = 'tester'
  ) then
    raise exception 'select_deck: caller is not an active tester account'
      using errcode = '28000';
  end if;

  -- Lock the target deck row before validating/selecting it, matching the
  -- target-row-lock pattern used by finish_session() for its analogous
  -- single-row validate-then-update shape.
  select * into v_deck
  from public.decks
  where id = p_deck_id
    and owner_user_id = v_user_id
    and deleted_at is null
    and archived_at is null
  for update;

  if not found then
    raise exception 'select_deck: deck % does not belong to caller, or is deleted/archived', p_deck_id
      using errcode = '42501';
  end if;

  update public.profiles
  set selected_deck_id = v_deck.id
  where id = v_user_id;

  return v_deck;
end;
$$;

comment on function public.select_deck(uuid) is
  'SECURITY DEFINER trusted workflow. Sets profiles.selected_deck_id to one of the caller''s own, non-deleted, non-archived decks -- authenticated has no direct UPDATE grant on that column. Derives the acting user from auth.uid() only; requires an active tester account (admin is rejected). search_path pinned to empty; all references schema-qualified.';

revoke all on function public.select_deck(uuid) from public;
grant execute on function public.select_deck(uuid) to authenticated;
