-- Learning Engine v1 -- Runtime Cutover RC-B corrective migration:
-- scheduler_revision must also cover changes to the SCHEDULABLE CARD SET
-- itself, not only changes to the specific ids a decision referenced.
--
-- Forward-only correction. Does not edit, rewrite, or reinterpret
-- 20261009000000_learning_engine_v1_runtime_cutover_rc_b_selection_claim.sql
-- (already applied) -- that migration's schema and both of its trusted
-- functions are left completely untouched. This migration is strictly
-- additive: two new trigger functions and two new triggers on
-- public.cards.
--
-- ---------------------------------------------------------------------
-- The gap (review finding, confirmed)
-- ---------------------------------------------------------------------
-- chooseNextCard() (lib/learning-engine/scheduler/next-card.ts) computes
-- its decision from the ENTIRE schedulable card set for a (user, deck) --
-- not merely the ids its output happens to reference. Specifically, the
-- full set feeds:
--   - the NEW reservoir / Active admission computation
--     (computeActiveAdmissions, lib/learning-engine/active-pool.ts);
--   - Fresh count/capacity, which gates how many NEW cards may admit;
--   - whether ACTIVE is available as a source at all
--     (computeActiveCandidateCount);
--   - Dynamic Source Weight renormalization (empty-source removal);
--   - first-pass batch creation/composition (findNeverPresentedActiveNewCardIds,
--     buildFirstPassOrder);
--   - every source's candidate count recorded on the trace.
--
-- The claim RPC's own entity validation (20261009000000's
-- claim_next_learning_engine_card()) only re-verifies that whatever ids
-- the DECISION'S OUTPUT references (the selected card, admitted ids,
-- first-pass queue, shuffle bag) are still valid, non-deleted, in-deck
-- entities. It was NEVER a check that the decision's INPUT card set was
-- still current. A card added or restored (or soft-deleted) between the
-- snapshot read and the claim, while never referenced by that decision's
-- output, can still change the admission/candidate-count/source-weight
-- computation that produced it -- exactly the scenario this migration's
-- own prior header (20261002000000_learning_engine_v1_scheduler_position.sql)
-- already anticipated: "A scheduler DECISION is computed from a read over
-- the ENTIRE deck's card set plus deck-level state -- a card the decision
-- did NOT select could change in a way that invalidates the decision
-- itself... scheduler_revision exists to catch exactly that."
--
-- The RC-B final report's original mutation-surface table classified
-- add_card_to_deck() and direct cards.deleted_at toggles as safe without
-- a scheduler_revision bump, reasoning only about referenced-id safety
-- (option C of that report's own acceptance criteria). That reasoning was
-- incomplete -- it never asked whether the decision's INPUT set was still
-- current. This migration closes that gap at its root: scheduler_revision
-- itself now actually covers every mutation that can change the
-- schedulable card set.
--
-- ---------------------------------------------------------------------
-- The fix: two narrow, additive triggers on public.cards
-- ---------------------------------------------------------------------
-- 1. AFTER INSERT (a card enters the live schedulable set, e.g.
--    add_card_to_deck() or duplicate_starter_deck()'s bulk copy).
-- 2. AFTER UPDATE, but ONLY when deleted_at actually transitions (a card
--    leaves or re-enters the live schedulable set) -- NOT on an ordinary
--    content edit (front/back/extra_content/sort_order), which does not
--    change scheduler membership at all and must never bump the token.
--
-- Both are STATEMENT-level triggers using transition tables
-- (REFERENCING ... TABLE), not ROW-level: duplicate_starter_deck() inserts
-- an entire deck's cards (hundreds of rows) in ONE statement, and a
-- row-level trigger would redundantly recompute/re-update once per row.
-- A statement-level trigger collapses this to one UPDATE per statement,
-- covering every distinct affected deck in that statement.
--
-- Exactly one (user_id, deck_id) row is ever affected per card, because
-- every card belongs to exactly one deck, and every deck has exactly one
-- owner (public.decks.owner_user_id) -- there is no card/deck sharing
-- across testers in this schema (each tester's deck is their own
-- duplicated copy, 20260923190000_duplicate_and_session_functions.sql).
-- No fan-out case exists to reason about.
--
-- If no user_deck_learning_state row exists yet for the affected
-- (user_id, deck_id) (e.g. a deck that was just created this same
-- statement, before any snapshot/claim has ever lazily initialized its
-- row), the UPDATE below simply matches zero rows -- a safe no-op: there
-- is no earlier reader who could hold a now-stale snapshot of a row that
-- never existed, and the eventual lazy-upsert (RC-A's own precedent,
-- reused by 20261009000000's get_learning_engine_v1_scheduler_snapshot())
-- always starts a fresh deck at scheduler_revision = 0, already
-- consistent with every card present at that moment.
--
-- ---------------------------------------------------------------------
-- Why SECURITY DEFINER is required here (not optional hardening)
-- ---------------------------------------------------------------------
-- cards.deleted_at is the one card column `authenticated` may set via a
-- DIRECT UPDATE (20260923210000_tester_deck_card_write_paths.sql's
-- `grant update (front, back, extra_content, sort_order, deleted_at) on
-- table public.cards to authenticated`) -- there is no trusted wrapper
-- function in the loop for a soft-delete/restore, unlike add_card_to_deck().
-- A trigger function's privileges default to whichever role fired the
-- triggering statement; `authenticated` has NO grant at all on
-- public.user_deck_learning_state (every Learning Engine v1 state table's
-- standard SELECT-only-for-authenticated / writes-via-trusted-function-only
-- design). Without SECURITY DEFINER, a tester's own direct soft-delete/
-- restore would make this trigger's internal UPDATE fail with permission
-- denied (42501), breaking the very operation it is attached to. SECURITY
-- DEFINER (fixed search_path = '', same as every other trusted function in
-- this codebase) elevates only for the trigger's own narrow, fixed
-- UPDATE -- it grants no broader access to the firing role.
--
-- ---------------------------------------------------------------------
-- Scope boundary
-- ---------------------------------------------------------------------
-- This migration does not touch, and is not required by,
-- commit_answer_transaction()/get_next_session_card()/
-- start_or_resume_session()/finish_session() -- none of them insert cards
-- or toggle cards.deleted_at. It is pure additive trigger infrastructure
-- on public.cards; no existing column, constraint, grant, or RLS policy
-- is modified.

-- =========================================================================
-- Trigger 1: card INSERT
-- =========================================================================
create or replace function public.bump_scheduler_revision_on_cards_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.user_deck_learning_state uds
  set scheduler_revision = uds.scheduler_revision + 1
  from (
    select distinct c.deck_id, dk.owner_user_id
    from inserted c
    join public.decks dk on dk.id = c.deck_id
  ) affected
  where uds.deck_id = affected.deck_id
    and uds.user_id = affected.owner_user_id;

  return null;
end;
$$;

comment on function public.bump_scheduler_revision_on_cards_insert() is
  'Runtime Cutover RC-B corrective: statement-level AFTER INSERT trigger on public.cards. Bumps scheduler_revision for every (user, deck) whose live schedulable card set this statement just grew -- closing the "newly admitted card bypasses the optimistic-concurrency token" gap. SECURITY DEFINER because authenticated has no write grant on user_deck_learning_state. No-op (0 rows updated) when no user_deck_learning_state row exists yet for the affected deck -- there is no earlier reader to have gone stale.';

create trigger cards_bump_scheduler_revision_on_insert
  after insert on public.cards
  referencing new table as inserted
  for each statement
  execute function public.bump_scheduler_revision_on_cards_insert();

-- =========================================================================
-- Trigger 2: cards.deleted_at transition (soft-delete or restore)
-- =========================================================================
create or replace function public.bump_scheduler_revision_on_cards_delete_toggle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Filtering happens here, inside the function, rather than via a
  -- statement-level WHEN clause -- a statement-level trigger's WHEN
  -- cannot reference per-row OLD/NEW, only the transition tables can.
  -- A plain content edit (front/back/extra_content/sort_order) that never
  -- touches deleted_at produces an empty `affected` set below and this
  -- UPDATE matches zero rows -- no bump, exactly as required.
  update public.user_deck_learning_state uds
  set scheduler_revision = uds.scheduler_revision + 1
  from (
    select distinct n.deck_id, dk.owner_user_id
    from new_rows n
    join old_rows o on o.id = n.id
    join public.decks dk on dk.id = n.deck_id
    where o.deleted_at is distinct from n.deleted_at
  ) affected
  where uds.deck_id = affected.deck_id
    and uds.user_id = affected.owner_user_id;

  return null;
end;
$$;

comment on function public.bump_scheduler_revision_on_cards_delete_toggle() is
  'Runtime Cutover RC-B corrective: statement-level AFTER UPDATE trigger on public.cards. Bumps scheduler_revision for every (user, deck) whose live schedulable card set this statement just changed via a deleted_at transition (soft-delete OR restore) -- closing the "a non-referenced candidate is deleted/restored without invalidating any referenced decision id" gap. Deliberately does NOT fire for an ordinary content edit (front/back/extra_content/sort_order) that leaves deleted_at unchanged -- those never affect scheduler membership. SECURITY DEFINER because authenticated holds a direct UPDATE grant on cards.deleted_at (20260923210000_tester_deck_card_write_paths.sql) but no write grant at all on user_deck_learning_state.';

create trigger cards_bump_scheduler_revision_on_delete_toggle
  after update on public.cards
  referencing old table as old_rows new table as new_rows
  for each statement
  execute function public.bump_scheduler_revision_on_cards_delete_toggle();
