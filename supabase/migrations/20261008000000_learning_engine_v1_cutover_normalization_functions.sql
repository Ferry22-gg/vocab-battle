-- Learning Engine v1 -- Runtime Cutover RC-A: trusted one-time
-- normalization primitives.
-- Source of truth: the approved Runtime Cutover Architecture plan
-- sections 3/4 (state-normalization plan) and R1/R2/R3 as tightened in
-- the follow-up approval message, plus the resolved pre-RC-A invariant
-- check (legacy FORGOTTEN repair-obligation completeness).
--
-- ---------------------------------------------------------------------
-- Why trusted SQL functions, not "broad client-writable SQL"
-- ---------------------------------------------------------------------
-- Per the approved plan's explicit instruction ("Implement one-time
-- trusted normalization... Do not perform it casually as broad
-- client-writable SQL") and RC-A trust-boundary requirements ("Use RLS
-- and SECURITY DEFINER patterns consistent with the existing project"),
-- this one-time migration of existing legacy rows into v1-shaped state
-- is exposed as two narrow, service_role-only SECURITY DEFINER
-- functions -- the same trust pattern commit_answer_transaction() and
-- the Phase 8 telemetry functions already establish. Neither function
-- is granted to `authenticated` or `anon`; neither is called by any live
-- application code path. A one-time operational script (not part of
-- this migration) is the only intended caller, via the service-role
-- client.
--
-- Both functions are intentionally idempotent (re-running them with the
-- same inputs reproduces the same stored state) so that re-running the
-- one-time normalization script is safe, per the approved clarification
-- "retrying normalization cannot silently change the obligation."
--
-- ---------------------------------------------------------------------
-- Division of labor with the TypeScript normalization module (RC-A)
-- ---------------------------------------------------------------------
-- Per the approved plan: "createRepairObligation() remains the only
-- repair-obligation constructor" -- a Postgres function must not
-- reimplement or approximate the {3,4,5,6} repair-gap sampling formula.
-- These two functions therefore perform NO scheduling computation: they
-- accept an already-fully-computed target state (including, for a
-- FORGOTTEN card, the exact repair_wrong_position/repair_target_position/
-- repair_hard_cap_position a TypeScript caller derived by calling the
-- real, unmodified createRepairObligation() with a deterministic seeded
-- RandomSource) and do three things only: validate structural
-- consistency, validate the row has not drifted since it was audited,
-- and persist.

-- =========================================================================
-- normalize_card_progress_for_learning_engine_v1
-- =========================================================================
-- Applies one fully-computed Learning Engine v1 normalized state to one
-- existing user_card_progress row. Deliberately NOT a general-purpose
-- v1 state writer: this is a cutover-only primitive, so it refuses
-- 'ACQUIRED' as a target card_status (no legacy row can honestly
-- normalize to ACQUIRED -- that status does not exist in the legacy
-- enum and inventing same-day acquisition evidence for a legacy row
-- would fabricate history the audit explicitly ruled out, approved plan
-- section 3/R1).
create function public.normalize_card_progress_for_learning_engine_v1(
  p_user_id uuid,
  p_card_id uuid,

  -- Safety: the legacy card_status this row is expected to still have.
  -- Guards against a race where a live legacy answer (from a
  -- not-yet-allowlisted tester, still fully operational per RC-A section
  -- 17) changed this row's state between when the one-time script
  -- audited it and when this function actually runs. Raises SQLSTATE
  -- 40001 (this project's established "stale snapshot" code, see
  -- commit_answer_transaction()) rather than silently overwriting drift.
  p_expected_legacy_card_status text,

  -- Target state. card_status is included explicitly (rather than
  -- always reusing p_expected_legacy_card_status) because the FORGOTTEN
  -- case leaves card_status unchanged while every other field changes --
  -- spelling it out keeps this function's contract uniform across all
  -- four legacy statuses instead of special-casing one of them.
  p_card_status text,
  p_learning_stage text,
  p_pool_status text,
  p_relearning_phase text,
  p_has_ever_been_mastered boolean,

  p_repair_pending boolean,
  p_repair_wrong_position integer,
  p_repair_target_position integer,
  p_repair_hard_cap_position integer,

  p_normalization_version text
)
returns public.user_card_progress
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.user_card_progress;
begin
  if p_card_status not in ('NEW', 'LEARNING', 'LEARNED', 'FORGOTTEN') then
    raise exception 'normalize_card_progress_for_learning_engine_v1: % is not a legal one-time legacy-normalization target card_status (ACQUIRED is never valid here)', p_card_status
      using errcode = '22023';
  end if;

  if p_learning_stage is not null and p_learning_stage not in ('FRESH', 'LEARNING_1', 'LEARNING_2') then
    raise exception 'normalize_card_progress_for_learning_engine_v1: invalid learning_stage %', p_learning_stage
      using errcode = '22023';
  end if;
  if p_pool_status is not null and p_pool_status not in ('ACTIVE', 'OUTSIDE') then
    raise exception 'normalize_card_progress_for_learning_engine_v1: invalid pool_status %', p_pool_status
      using errcode = '22023';
  end if;
  if p_relearning_phase is not null and p_relearning_phase not in ('REPAIR_PENDING', 'SPACED_CONFIRMATION_PENDING') then
    raise exception 'normalize_card_progress_for_learning_engine_v1: invalid relearning_phase %', p_relearning_phase
      using errcode = '22023';
  end if;

  -- Structural repair-obligation completeness -- the exact invariant the
  -- pre-RC-A audit was about. A partial obligation (some but not all of
  -- the three positions present, or repair_pending disagreeing with
  -- their presence) is rejected outright rather than persisted, matching
  -- "no partial repair obligation is ever passed to chooseNextCard()"
  -- one layer further back, at the point of writing the row at all.
  if p_repair_pending then
    if p_repair_wrong_position is null or p_repair_target_position is null or p_repair_hard_cap_position is null then
      raise exception 'normalize_card_progress_for_learning_engine_v1: repair_pending=true requires all three repair positions to be non-null'
        using errcode = '22023';
    end if;
    if not (p_repair_hard_cap_position >= p_repair_target_position and p_repair_target_position >= p_repair_wrong_position) then
      raise exception 'normalize_card_progress_for_learning_engine_v1: repair positions are not internally consistent (expected hard_cap >= target >= wrong)'
        using errcode = '22023';
    end if;
  else
    if p_repair_wrong_position is not null or p_repair_target_position is not null or p_repair_hard_cap_position is not null then
      raise exception 'normalize_card_progress_for_learning_engine_v1: repair_pending=false requires all three repair positions to be null'
        using errcode = '22023';
    end if;
  end if;

  -- A card entering relearning's repair phase must actually have a
  -- repair obligation backing it -- the two columns must agree. (The
  -- inverse -- repair_pending=true with relearning_phase null -- is
  -- legitimate: that is the ordinary within-day Active-pool repair,
  -- which this one-time cutover normalization never produces, but which
  -- this function does not need to rule out for its own sake.)
  if p_relearning_phase = 'REPAIR_PENDING' and not p_repair_pending then
    raise exception 'normalize_card_progress_for_learning_engine_v1: relearning_phase=REPAIR_PENDING requires repair_pending=true'
      using errcode = '22023';
  end if;

  select * into v_row
  from public.user_card_progress
  where user_id = p_user_id and card_id = p_card_id
  for update;

  if not found then
    raise exception 'normalize_card_progress_for_learning_engine_v1: no user_card_progress for user % card %', p_user_id, p_card_id
      using errcode = '42501';
  end if;

  if v_row.card_status is distinct from p_expected_legacy_card_status then
    raise exception 'normalize_card_progress_for_learning_engine_v1: card % drifted from expected legacy card_status % (now %) -- re-audit before normalizing', p_card_id, p_expected_legacy_card_status, v_row.card_status
      using errcode = '40001';
  end if;

  update public.user_card_progress
  set
    card_status = p_card_status,
    learning_stage = p_learning_stage,
    pool_status = p_pool_status,
    relearning_phase = p_relearning_phase,
    has_ever_been_mastered = p_has_ever_been_mastered,
    repair_pending = p_repair_pending,
    repair_wrong_position = p_repair_wrong_position,
    repair_target_position = p_repair_target_position,
    repair_hard_cap_position = p_repair_hard_cap_position
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.normalize_card_progress_for_learning_engine_v1(
  uuid, uuid, text, text, text, text, text, boolean, boolean, integer, integer, integer, text
) is
  'Runtime Cutover RC-A: one-time trusted normalization of a single legacy user_card_progress row into Learning Engine v1 state. SECURITY DEFINER, service_role-only. Never accepts ACQUIRED as a target (no legacy row can honestly normalize to it). Rejects a structurally partial repair obligation and rejects writing if the row has drifted from its expected legacy card_status since being audited (SQLSTATE 40001). Idempotent: re-applying the same inputs reproduces the same stored state. Not called by any live application code path.';

revoke all on function public.normalize_card_progress_for_learning_engine_v1(
  uuid, uuid, text, text, text, text, text, boolean, boolean, integer, integer, integer, text
) from public, anon, authenticated;

grant execute on function public.normalize_card_progress_for_learning_engine_v1(
  uuid, uuid, text, text, text, text, text, boolean, boolean, integer, integer, integer, text
) to service_role;

-- =========================================================================
-- recompute_user_deck_learning_state_for_v1
-- =========================================================================
-- Approved Runtime Cutover plan section 4/13: user_deck_learning_state.
-- mastered_count/has_achieved_full_mastery are stale (populated exactly
-- once by the Phase 1 backfill, never updated since -- see docs/
-- LEARNING_ENGINE_V1_RUNTIME_CUTOVER_TODO.md's "Stale
-- user_deck_learning_state"). This function recomputes both from the
-- FINAL normalized live user_card_progress state for one (user, deck)
-- pair -- it must run AFTER every affected card in that deck has already
-- been normalized via the function above, never before, so it sees
-- post-normalization card_status values rather than stale
-- pre-normalization ones.
--
-- Monotonicity (approved plan, invariant 25.1): has_achieved_full_mastery
-- is only ever OR'd with its freshly-computed value, never assigned
-- false outright, so a value this function (or any future answer-commit
-- transaction) already set to true can never be cleared by a later call.
--
-- Ensures a row exists first (the same ON CONFLICT DO NOTHING shape the
-- Phase 1 backfill already uses) so this function is also safe to call
-- for a (user, deck) pair the original backfill missed (e.g. a deck
-- created after that migration ran, or one with zero historical
-- answers) -- in that case it simply recomputes from a freshly-defaulted
-- row (scheduler_position=0, scheduler_revision=0, desired_retention=0.90,
-- etc., all already-correct column defaults -- approved plan section
-- 4/R3, nothing here overrides them).
create function public.recompute_user_deck_learning_state_for_v1(
  p_user_id uuid,
  p_deck_id uuid
)
returns public.user_deck_learning_state
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total_cards integer;
  v_mastered_count integer;
  v_row public.user_deck_learning_state;
begin
  insert into public.user_deck_learning_state (user_id, deck_id)
  values (p_user_id, p_deck_id)
  on conflict (user_id, deck_id) do nothing;

  select *
  into v_row
  from public.user_deck_learning_state
  where user_id = p_user_id and deck_id = p_deck_id
  for update;

  if not found then
    raise exception 'recompute_user_deck_learning_state_for_v1: failed to find or create a row for user % deck %', p_user_id, p_deck_id
      using errcode = '42501';
  end if;

  select count(*) into v_total_cards
  from public.cards
  where deck_id = p_deck_id
    and deleted_at is null;

  select count(*) into v_mastered_count
  from public.user_card_progress ucp
  join public.cards c on c.id = ucp.card_id
  where ucp.user_id = p_user_id
    and c.deck_id = p_deck_id
    and c.deleted_at is null
    and ucp.card_status = 'LEARNED';

  update public.user_deck_learning_state
  set
    mastered_count = v_mastered_count,
    has_achieved_full_mastery = has_achieved_full_mastery or (v_total_cards > 0 and v_mastered_count = v_total_cards)
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.recompute_user_deck_learning_state_for_v1(uuid, uuid) is
  'Runtime Cutover RC-A: recomputes user_deck_learning_state.mastered_count/has_achieved_full_mastery for one (user, deck) pair from the current live user_card_progress state, correcting the Phase 1 one-time backfill''s staleness. has_achieved_full_mastery is only ever OR''d with its prior value, never cleared. SECURITY DEFINER, service_role-only. Idempotent. Must be called after every card in the deck has already been normalized. Not called by any live application code path.';

revoke all on function public.recompute_user_deck_learning_state_for_v1(uuid, uuid) from public, anon, authenticated;
grant execute on function public.recompute_user_deck_learning_state_for_v1(uuid, uuid) to service_role;
