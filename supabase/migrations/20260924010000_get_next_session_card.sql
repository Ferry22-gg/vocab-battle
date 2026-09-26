-- Phase F0 trusted database function: get_next_session_card().
-- Source of truth: docs/DATABASE_SCHEMA.md sections 4.4, 4.6, 4.7, 9.1,
-- 10.3 ("Learning-mode eligibility" / "Review-mode validation"), 11.
--
-- Purpose: give the trusted Next.js Session UI a single authoritative READ
-- answering "which card is currently answerable, and what does the battle
-- HUD look like right now?" -- without duplicating session_review_cards /
-- session_learning_queue / Active Pool selection logic in TypeScript
-- (explicitly rejected for this phase: queue selection stays
-- PostgreSQL-owned, matching commit_answer_transaction()'s own ownership
-- of review/learning eligibility).
--
-- ---------------------------------------------------------------------
-- Why SECURITY INVOKER, not SECURITY DEFINER (unlike every function in
-- 20260923190000_duplicate_and_session_functions.sql /
-- 20260923200000_commit_answer_transaction.sql)
-- ---------------------------------------------------------------------
-- Every existing trusted function needs SECURITY DEFINER because it
-- WRITES to a table `authenticated` has no INSERT/UPDATE grant on at all
-- (grants_and_rls.sql's "trusted-state tables" design decision) -- RLS
-- alone cannot make that work regardless of ownership. This function only
-- SELECTs from sessions, session_review_cards, session_learning_queue,
-- user_card_progress, and cards -- all five already grant SELECT to
-- `authenticated`, scoped by RLS to "own rows, or all rows for admin"
-- (grants_and_rls.sql: sessions_select_own_or_admin,
-- session_review_cards_select_own_session_or_admin,
-- session_learning_queue_select_own_session_or_admin,
-- user_card_progress_select_own_or_admin,
-- cards_select_own_or_official_or_admin). Plain RLS-scoped SELECTs under
-- the caller's own privileges already give exactly the access this
-- function needs -- running as SECURITY DEFINER here would only bypass
-- RLS without being asked to, the opposite of least privilege, and 10.6's
-- SECURITY DEFINER checklist only applies to functions that genuinely
-- need to read/write beyond the caller's own RLS.
--
-- One consequence, intentional and inherited (not newly granted here): an
-- admin caller can call this for a tester's own session_id and receive
-- that tester's next-card content, exactly as far as admin's existing
-- blanket read access already reaches (DATABASE_SCHEMA.md 7.1, "Admin may
-- read all beta data required by /admin"). This function adds no new
-- admin capability -- it simply inherits whatever the pre-existing RLS
-- policies already allow, the same way any other RLS-scoped read would.
-- This is a pure read (no XP/session/progress mutation), so it does not
-- implicate the admin-preview-must-not-persist-learner-state restriction
-- (4.1/6.3) at all.
--
-- Still pins search_path = '' and schema-qualifies every reference, as
-- routine hygiene (not because SECURITY INVOKER is vulnerable to the same
-- search-path hijack SECURITY DEFINER is).
--
-- ---------------------------------------------------------------------
-- Read-only guarantee
-- ---------------------------------------------------------------------
-- No INSERT/UPDATE/DELETE anywhere in this function body. Marked STABLE
-- (not VOLATILE): within one statement/snapshot it is safe to evaluate
-- more than once, consistent with "calling this must not mutate
-- session/progress/queue state" (F0 requirement). It does not, and must
-- not, perform the Review -> Learning mode transition itself -- that
-- remains commit_answer_transaction()'s exclusive responsibility
-- (10.3's "Review -> Learning session transition", guarded by
-- reviews_completed_at IS NULL). Under normal play this function should
-- never observe current_mode = 'review' with zero incomplete
-- session_review_cards rows, because that mode flip happens atomically,
-- in the same transaction that empties the queue -- if it is ever
-- observed, this function surfaces it as a `no_card` result
-- (REVIEW_QUEUE_EMPTY_PENDING_TRANSITION) rather than mutating
-- current_mode itself.
--
-- ---------------------------------------------------------------------
-- Consistency with commit_answer_transaction()'s own eligibility rules
-- ---------------------------------------------------------------------
-- Review: selects the same predicate commit_answer_transaction() checks
-- (`session_review_cards` row for this session, `completed = false`),
-- ordered by the same `queue_order` the review-mode Wrong/requeue logic
-- (4.6) maintains -- so the row this function returns is, by
-- construction, one commit_answer_transaction() will accept (10.3
-- "Review-mode validation": "not found or completed" is the only
-- rejection condition).
--
-- Learning: replicates, in this order, exactly the two gates 10.3's
-- "Learning-mode eligibility" enforces:
--   1. a forced-reappearance reservation at the current draw number
--      (`session_learning_queue.forced_reappear_draw_index =
--      current_draw_number`) takes precedence over any other card --
--      commit_answer_transaction() rejects every OTHER card at that draw,
--      so this function must return that exact card, never merely "a"
--      Learning-eligible card;
--   2. otherwise, the normal Active Pool priority (FORGOTTEN, then
--      LEARNING, then NEW -- 4.4/9.1), excluding any card still under
--      cooldown via the identical `next_eligible_draw_index` comparison
--      commit_answer_transaction() itself performs
--      (`v_current_draw_number < next_eligible_draw_index`).
-- `current_draw_number` is computed identically:
-- `session.learning_draw_index + 1`.
--
-- Both branches also apply the same generic card-validity predicate
-- commit_answer_transaction() checks before its mode-specific branch
-- (`cards.deck_id = session.deck_id and cards.deleted_at is null`).
--
-- One asymmetry, intentional: the Active Pool target-size gate below (NEW
-- eligibility only) is enforced ONLY here, not inside
-- commit_answer_transaction() -- Active Pool sizing has always been a
-- selection-layer/advisory concept (4.4: "the exact selection algorithm
-- belongs in application/session logic"), never a commit-time invariant,
-- and this phase does not add one. So the consistency property remains
-- one-directional exactly as before: every card THIS function returns
-- remains one commit_answer_transaction() will accept, but a NEW card
-- this function withholds (pool full) is not thereby made invalid to
-- submit if a caller somehow already had it in hand.
--
-- The one selection axis 10.3 does NOT fully specify is the tie-break
-- *within* one Active Pool priority tier (DATABASE_SCHEMA.md 4.4 says
-- outright: "the exact selection algorithm belongs in application/session
-- logic"). This function orders by `last_seen_at ASC NULLS FIRST` (oldest
-- exposure first -- a no-op tie-break among NEW cards, which all share
-- `last_seen_at IS NULL`), then `cards.sort_order`, then `card_id`, purely
-- for determinism/testability. This is the smallest reversible choice
-- available, not a new permanent product decision.
--
-- ---------------------------------------------------------------------
-- Active Pool target size (added in the F0 follow-up review; MVP_SPEC_FOR_
-- CLAUDE.md section 9 / DATABASE_SCHEMA.md 4.4/9.1: target ~30 cards,
-- eligible statuses FORGOTTEN/LEARNING/NEW, priority FORGOTTEN > LEARNING
-- > NEW-as-refill, "30 is a target, not a hard cap when a FORGOTTEN card
-- must be reintroduced")
-- ---------------------------------------------------------------------
-- Without this, Gate 2 below would happily draw a NEW card as soon as
-- FORGOTTEN/LEARNING candidates were merely on cooldown at this exact
-- draw -- even if the deck already has >=30 cards "in rotation"
-- (LEARNING+FORGOTTEN), silently drawing the Active Pool from the whole
-- deck rather than a bounded rotating set. Fixed by gating NEW-card
-- eligibility on the caller's CURRENT effective Active Pool size, defined
-- here as count(user_card_progress where card_status in ('LEARNING',
-- 'FORGOTTEN')) for this user's deck -- cards already "in rotation".
-- Deliberately excludes NEW from this count (a NEW card is not "in" the
-- pool until it is actually introduced, i.e. first answered -- lifecycle
-- 11.1: NEW -> LEARNING only "after first answered exposure"). FORGOTTEN
-- is never gated by this size and can push the effective count above the
-- target, matching the "not a hard cap" rule verbatim -- only NEW
-- introduction is throttled by it. Cooldown is a separate, unrelated
-- mechanism (per-draw, temporary) and is intentionally NOT part of this
-- size calculation -- a FORGOTTEN/LEARNING card currently on cooldown
-- still counts as "in the pool", it merely is not the one returned right
-- now, so the pool does not appear to shrink and admit an extra NEW card
-- just because everything else happens to be briefly on cooldown.
--
-- No canonical DB-side Active Pool target-size constant exists anywhere
-- in this project yet: lib/learning/config.ts's own header explicitly
-- defers it ("The XP ledger, level curve, Daily Goal, and Active Pool
-- constants listed in section 35 are intentionally NOT included yet"),
-- and no migration declares one either. Rather than invent a second,
-- possibly-conflicting source of truth, this follows the exact precedent
-- commit_answer_transaction() itself already set for tunables with no
-- shared config table yet (c_daily_goal_enemies, c_learning_cooldown,
-- c_forced_min_gap/c_forced_max_gap, etc.): a local `constant` inside this
-- function body, kept in sync by hand with lib/learning/config.ts if/when
-- that module gains an ACTIVE_POOL_TARGET_SIZE constant of its own.

create or replace function public.get_next_session_card(p_session_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  -- See the "Active Pool target size" header comment above.
  c_active_pool_target constant integer := 30;

  v_user_id uuid;
  v_session public.sessions;
  v_review_card record;
  v_forced_card_id uuid;
  v_forced_progress record;
  v_pool_card record;
  v_current_draw_number integer;
  v_active_pool_size integer;
  v_eligible_count integer;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'get_next_session_card: no authenticated user'
      using errcode = '28000';
  end if;

  -- RLS (sessions_select_own_or_admin) already scopes this to the
  -- caller's own session, or -- for an admin caller -- any session (see
  -- header comment). A session that does not exist, is not `active`, or
  -- is not visible to this caller under RLS all collapse to the same
  -- `not_found` result below: indistinguishable from each other, so this
  -- never confirms another user's session exists.
  select * into v_session
  from public.sessions
  where id = p_session_id
    and status = 'active';

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Defensive only: start_or_resume_session() always populates a valid
  -- enemy for a newly created session and resume never touches it
  -- (DATABASE_SCHEMA.md 4.5), so this should never trip in practice -- but
  -- this function must not silently fabricate battle state if it somehow
  -- did (mirrors lib/learning/submit-answer.ts's own equivalent guard).
  if v_session.current_enemy_type is null
     or v_session.current_enemy_hp is null
     or v_session.current_enemy_max_hp is null then
    return jsonb_build_object('status', 'error', 'reason', 'SESSION_MISSING_BATTLE_STATE');
  end if;

  if v_session.current_mode = 'review' then
    select src.card_id as card_id, c.front as front, c.back as back
    into v_review_card
    from public.session_review_cards src
    join public.cards c
      on c.id = src.card_id
     and c.deck_id = v_session.deck_id
     and c.deleted_at is null
    where src.session_id = v_session.id
      and src.completed = false
    order by src.queue_order asc
    limit 1;

    if not found then
      -- Anomaly only (see header comment): under normal play,
      -- current_mode = 'review' implies at least one incomplete
      -- session_review_cards row, because commit_answer_transaction()
      -- flips current_mode to 'learning' atomically in the same
      -- transaction that empties the queue. Also covers the (equally
      -- abnormal) case where every remaining incomplete row's underlying
      -- card has since been soft-deleted. This function does not mutate
      -- current_mode to work around either case.
      return jsonb_build_object('status', 'no_card', 'reason', 'REVIEW_QUEUE_EMPTY_PENDING_TRANSITION');
    end if;

    return jsonb_build_object(
      'status', 'ok',
      'session_id', v_session.id,
      'session_mode', v_session.current_mode,
      'card_id', v_review_card.card_id,
      'front', v_review_card.front,
      'back', v_review_card.back,
      'enemy_type', v_session.current_enemy_type,
      'enemy_hp', v_session.current_enemy_hp,
      'enemy_max_hp', v_session.current_enemy_max_hp,
      'combo', v_session.current_combo
    );

  elsif v_session.current_mode = 'learning' then
    v_current_draw_number := v_session.learning_draw_index + 1;

    -- Gate 1: a forced-reappearance reservation for THIS exact draw
    -- overrides normal priority -- commit_answer_transaction() rejects
    -- every other card at this draw, so this function must return this
    -- exact card if such a reservation exists. `order by card_id limit 1`
    -- is a deterministic tie-break only; under correct operation at most
    -- one row can match (session_learning_queue's collision-shift loop in
    -- commit_answer_transaction() guarantees unique forced positions per
    -- session).
    select slq.card_id into v_forced_card_id
    from public.session_learning_queue slq
    where slq.session_id = v_session.id
      and slq.forced_reappear_draw_index = v_current_draw_number
    order by slq.card_id
    limit 1;

    if found then
      select c.front as front, c.back as back
      into v_forced_progress
      from public.user_card_progress ucp
      join public.cards c
        on c.id = ucp.card_id
       and c.deck_id = v_session.deck_id
       and c.deleted_at is null
      where ucp.user_id = v_user_id
        and ucp.card_id = v_forced_card_id
        and ucp.card_status in ('NEW', 'LEARNING', 'FORGOTTEN');

      if not found then
        -- Anomaly (see header comment): a card holding a forced-reappearance
        -- reservation is not currently Learning-eligible. Should not occur
        -- under normal play (a Correct answer always clears
        -- forced_reappear_draw_index before a card can reach LEARNED --
        -- 4.7/11.1) -- surfaced rather than silently skipped, since
        -- skipping would deviate from the exact reservation
        -- commit_answer_transaction() itself enforces.
        return jsonb_build_object('status', 'error', 'reason', 'LEARNING_FORCED_CARD_INELIGIBLE');
      end if;

      return jsonb_build_object(
        'status', 'ok',
        'session_id', v_session.id,
        'session_mode', v_session.current_mode,
        'card_id', v_forced_card_id,
        'front', v_forced_progress.front,
        'back', v_forced_progress.back,
        'enemy_type', v_session.current_enemy_type,
        'enemy_hp', v_session.current_enemy_hp,
        'enemy_max_hp', v_session.current_enemy_max_hp,
        'combo', v_session.current_combo
      );
    end if;

    -- Current effective Active Pool size: cards already "in rotation" for
    -- this user's deck (LEARNING + FORGOTTEN only -- see the "Active Pool
    -- target size" header comment). Computed once per call, before Gate 2,
    -- since both the candidate query and the eligible-count fallback below
    -- need the identical value.
    select count(*) into v_active_pool_size
    from public.user_card_progress ucp
    join public.cards c
      on c.id = ucp.card_id
     and c.deck_id = v_session.deck_id
     and c.deleted_at is null
    where ucp.user_id = v_user_id
      and ucp.card_status in ('LEARNING', 'FORGOTTEN');

    -- Gate 2: normal Active Pool priority -- FORGOTTEN, then existing
    -- LEARNING, then NEW as refill only while the pool has room (4.4/9.1)
    -- -- excluding any card still under Learning cooldown via the
    -- identical next_eligible_draw_index comparison commit_answer_
    -- transaction() performs. A card never shown in this session yet has
    -- no session_learning_queue row at all (the LEFT JOIN then yields
    -- NULLs, which the cooldown predicate correctly treats as "not on
    -- cooldown").
    select ucp.card_id as card_id, c.front as front, c.back as back
    into v_pool_card
    from public.user_card_progress ucp
    join public.cards c
      on c.id = ucp.card_id
     and c.deck_id = v_session.deck_id
     and c.deleted_at is null
    left join public.session_learning_queue slq
      on slq.session_id = v_session.id
     and slq.card_id = ucp.card_id
    where ucp.user_id = v_user_id
      and (
        ucp.card_status in ('LEARNING', 'FORGOTTEN')
        or (ucp.card_status = 'NEW' and v_active_pool_size < c_active_pool_target)
      )
      and not (
        slq.next_eligible_draw_index is not null
        and v_current_draw_number < slq.next_eligible_draw_index
      )
    order by
      case ucp.card_status
        when 'FORGOTTEN' then 0
        when 'LEARNING' then 1
        else 2
      end,
      ucp.last_seen_at asc nulls first,
      c.sort_order asc,
      ucp.card_id asc
    limit 1;

    if found then
      return jsonb_build_object(
        'status', 'ok',
        'session_id', v_session.id,
        'session_mode', v_session.current_mode,
        'card_id', v_pool_card.card_id,
        'front', v_pool_card.front,
        'back', v_pool_card.back,
        'enemy_type', v_session.current_enemy_type,
        'enemy_hp', v_session.current_enemy_hp,
        'enemy_max_hp', v_session.current_enemy_max_hp,
        'combo', v_session.current_combo
      );
    end if;

    -- No candidate survived Gate 2. Distinguish "nothing is even
    -- status-eligible" (deck exhausted for Learning -- everything is
    -- LEARNED or absent, or the only remaining cards are NEW ones the
    -- Active Pool target currently has no room for) from "eligible cards
    -- exist but every one is currently on cooldown" (F0 requirement, item
    -- 4). Uses the exact same combined status/pool-size predicate as Gate
    -- 2 above (not the older bare status-only check) so this distinction
    -- stays accurate now that NEW eligibility is pool-gated too: a NEW
    -- card the pool has no room for must not count as "eligible" here
    -- either, or a full-pool deck with everything on cooldown would be
    -- mislabeled ALL_ON_COOLDOWN instead of reflecting that NEW was never
    -- a candidate in the first place. In practice this can only ever
    -- differ from zero when at least one LEARNING/FORGOTTEN row already
    -- exists (see the header comment: the pool-size gate can only block
    -- NEW when the LEARNING+FORGOTTEN count is already >= target).
    select count(*) into v_eligible_count
    from public.user_card_progress ucp
    join public.cards c
      on c.id = ucp.card_id
     and c.deck_id = v_session.deck_id
     and c.deleted_at is null
    where ucp.user_id = v_user_id
      and (
        ucp.card_status in ('LEARNING', 'FORGOTTEN')
        or (ucp.card_status = 'NEW' and v_active_pool_size < c_active_pool_target)
      );

    if v_eligible_count = 0 then
      return jsonb_build_object('status', 'no_card', 'reason', 'LEARNING_NO_ELIGIBLE_CARDS');
    else
      return jsonb_build_object('status', 'no_card', 'reason', 'LEARNING_ALL_ON_COOLDOWN');
    end if;

  else
    return jsonb_build_object('status', 'error', 'reason', 'INVALID_SESSION_MODE');
  end if;
end;
$$;

comment on function public.get_next_session_card(uuid) is
  'SECURITY INVOKER read-only helper (Phase F0, DATABASE_SCHEMA.md 4.4/4.6/4.7/9.1/10.3/11). Returns the authoritative next answerable card for the caller''s own active session (or, for admin, any session -- inherited from existing RLS read access, not newly granted), replicating commit_answer_transaction()''s exact Review/Learning eligibility rules without mutating any state. Never performs the Review -> Learning transition itself. search_path pinned to empty; all references schema-qualified.';

-- Explicitly named, not just `from public`: this project's local Supabase
-- stack applies `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO
-- anon, authenticated, service_role` at the schema level, which grants
-- EXECUTE directly to each of those roles at CREATE FUNCTION time -- a
-- direct role grant, not a PUBLIC grant, so `revoke all ... from public`
-- alone does not remove it (confirmed by a real `supabase test db` run
-- against this exact migration; mirrors the identical pattern already
-- used by commit_answer_transaction()'s own revoke/grant block).
revoke all on function public.get_next_session_card(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_next_session_card(uuid) to authenticated;
