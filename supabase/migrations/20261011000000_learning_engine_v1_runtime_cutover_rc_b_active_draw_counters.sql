-- Learning Engine v1 -- Runtime Cutover RC-B corrective migration #2:
-- active_draws_since_eligible must advance at CLAIM time, not at a future
-- answer-commit transaction.
--
-- Forward-only correction, same discipline as
-- 20261010000000_learning_engine_v1_runtime_cutover_rc_b_card_set_revision_bump.sql.
-- Does not edit, rewrite, or reinterpret
-- 20261009000000_learning_engine_v1_runtime_cutover_rc_b_selection_claim.sql
-- (already applied) -- its schema, its snapshot function, and every other
-- behavior of its claim function are preserved exactly. This migration
-- DROPs and recreates ONLY claim_next_learning_engine_card() itself, to add
-- one new parameter -- Postgres has no "ALTER FUNCTION ... ADD PARAMETER";
-- changing a function's parameter list requires DROP + CREATE. The
-- function's trust boundary, validation order, idempotency contract, and
-- single-scheduler_revision-bump-per-claim invariant are all unchanged.
--
-- ---------------------------------------------------------------------
-- The gap (RC-C pre-check B, confirmed against the normative spec and the
-- existing pure/simulation code)
-- ---------------------------------------------------------------------
-- Spec clarification 9 (docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section
-- 22.3) ties active_draws_since_eligible's advance to a SELECTION event:
-- "increment by 1 only when ... an ACTIVE source slot actually occurred...
-- [and] a DIFFERENT card was selected" -- true the moment a decision is
-- made, independent of whether that selection is ever answered. The
-- existing TEST-ONLY simulation harness
-- (tests/helpers/learning-engine-simulation.ts) already demonstrates this
-- binding: it calls lib/learning-engine/active-priority.ts's
-- advanceActiveDrawCounters() unconditionally whenever `decision.source ===
-- "ACTIVE"`, BEFORE applying the scripted answer outcome -- i.e. the
-- counter advance does not wait on, or depend on, the eventual answer.
--
-- 20261009000000's claim_next_learning_engine_card() never persisted this.
-- It atomically commits the claimed card, Active admissions, the
-- first-pass queue, and the Post-Mastery shuffle bag -- every OTHER
-- claim-time scheduler-state mutation chooseNextCard() can produce -- but
-- never active_draws_since_eligible, leaving the 40-draw starvation
-- guarantee (section 22.3) structurally non-functional for any ACTIVE
-- claim made through this trusted path. This migration closes that gap at
-- its root, consistent with the architecture established by the
-- card-set-revision-bump corrective migration before it: TypeScript still
-- owns every scheduler semantic (which cards are "ordinary candidates",
-- the reset-to-0/+1/frozen arithmetic); Postgres only validates
-- structurally and persists atomically.
--
-- ---------------------------------------------------------------------
-- The fix
-- ---------------------------------------------------------------------
-- One new parameter, `p_active_draw_counter_updates jsonb` -- a caller-
-- computed array of `{"card_id": uuid, "before": integer, "after":
-- integer}` objects, produced by the new pure TypeScript helper
-- lib/learning-engine/runtime/active-draw-counters.ts's
-- computeClaimTimeActiveDrawCounterUpdates() (empty whenever
-- decision.source is not "ACTIVE" -- see that module's own header for the
-- exact SelectionReason table this covers, including repair_hard_cap,
-- which reports source "ACTIVE" despite being a GLOBAL interrupt).
--
-- This function does NOT re-derive, and must never be asked to re-derive,
-- WHY a card was or was not an eligible "ordinary Active candidate" --
-- that remains exclusively TypeScript's job, already computed under the
-- same scheduler_revision-protected snapshot the rest of this decision was
-- computed from. It validates only structural safety: every referenced
-- card belongs to the same user and deck and is non-deleted, every
-- after-value is non-negative, and -- the same "stale snapshot" hazard
-- class as the existing scheduler_position/scheduler_revision check,
-- raising the SAME SQLSTATE 40001 so the existing TypeScript bounded-retry
-- loop (lib/learning-engine/runtime/claim-next-card.ts's
-- isStaleSnapshotError) transparently covers this new failure mode with no
-- additional retry logic -- that each referenced card's CURRENT
-- active_draws_since_eligible still matches the caller's own expected
-- `before` value.
--
-- Persisted inside the SAME `v_has_mutation` branch as every other
-- claim-time mutation, under the SAME single scheduler_revision increment
-- -- never a second bump. In practice counter updates are only ever
-- non-empty when `p_card_id` is non-null (decision.source = "ACTIVE"
-- implies a card was selected), which already makes v_has_mutation true on
-- its own; the OR-clause below is defense-in-depth, not a new mutation
-- category that could fire alone.
--
-- ---------------------------------------------------------------------
-- Abandonment / idempotency semantics (locked explicitly, per the RC-C
-- brief)
-- ---------------------------------------------------------------------
-- A claim that is later ABANDONED (the session ended, or was superseded,
-- while the claim was still OPEN and unanswered) never revisits this
-- counter update -- the Active selection opportunity already genuinely
-- occurred at claim time, and nothing in clarification 9 conditions the
-- advance on an answer ever being committed. A future RC-C answer-commit
-- transaction MUST NOT touch active_draws_since_eligible at all; it is
-- now exclusively this function's concern. The OPEN-claim fast path
-- (lost-response retry) returns the existing claim unchanged and never
-- reaches this code at all -- no second counter update, exactly like every
-- other claim-time mutation.
drop function if exists public.claim_next_learning_engine_card(
  uuid, uuid, uuid, integer, integer, uuid, text, text, uuid[], uuid[], uuid[], uuid[], uuid[],
  uuid, timestamptz, text, integer, boolean, integer, integer, integer, integer,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, boolean, double precision[], text, jsonb
);

create function public.claim_next_learning_engine_card(
  p_user_id uuid,
  p_session_id uuid,
  p_deck_id uuid,

  p_expected_scheduler_position integer,
  p_expected_scheduler_revision integer,

  p_card_id uuid,
  p_source text,
  p_selection_reason text,
  p_admitted_card_ids uuid[],
  p_first_pass_queue_before uuid[],
  p_first_pass_queue_after uuid[],
  p_post_mastery_shuffle_bag_before uuid[],
  p_post_mastery_shuffle_bag_after uuid[],

  p_trace_id uuid,
  p_occurred_at timestamptz,
  p_scheduler_mode text,
  p_due_count integer,
  p_daily_goal_complete_before boolean,
  p_candidate_count_active integer,
  p_candidate_count_due integer,
  p_candidate_count_near integer,
  p_candidate_count_random_mastered integer,
  p_source_weight_active_raw double precision,
  p_source_weight_due_raw double precision,
  p_source_weight_near_raw double precision,
  p_source_weight_random_mastered_raw double precision,
  p_source_weight_active_normalized double precision,
  p_source_weight_due_normalized double precision,
  p_source_weight_near_normalized double precision,
  p_source_weight_random_mastered_normalized double precision,
  p_card_priority_weight double precision,
  p_retrievability double precision,
  p_interval_progress double precision,
  p_emergency_fallback_applied boolean,
  p_random_draws double precision[],
  p_policy_version text,
  p_trace_payload jsonb,

  -- RC-B corrective: claim-time active_draws_since_eligible deltas. Array
  -- of {"card_id": uuid, "before": integer, "after": integer}; null/empty
  -- whenever this decision's source is not "ACTIVE" (see migration header).
  p_active_draw_counter_updates jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
  v_deck_state public.user_deck_learning_state;
  v_existing_claim public.selection_claims;
  v_trace public.learning_engine_selection_traces;
  v_claim public.selection_claims;
  v_card public.cards;
  v_bad_id uuid;
  v_has_mutation boolean;
  v_next_revision integer;
  v_counter jsonb;
  v_counter_card_id uuid;
  v_counter_before integer;
  v_counter_after integer;
  v_counter_current integer;
begin
  if p_user_id is null then
    raise exception 'claim_next_learning_engine_card: p_user_id is required'
      using errcode = '22023';
  end if;

  -- =========================================================================
  -- Step 1-3: Session serialization + validation.
  -- =========================================================================
  select * into v_session
  from public.sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'claim_next_learning_engine_card: session % not found', p_session_id
      using errcode = '22023';
  end if;
  if v_session.user_id <> p_user_id then
    raise exception 'claim_next_learning_engine_card: session % does not belong to caller', p_session_id
      using errcode = '42501';
  end if;
  if v_session.status <> 'active' then
    raise exception 'claim_next_learning_engine_card: session % is not active', p_session_id
      using errcode = '42501';
  end if;
  if v_session.engine_version <> 'v1' then
    raise exception 'claim_next_learning_engine_card: session % is not an engine_version=v1 session', p_session_id
      using errcode = '42501';
  end if;
  if v_session.deck_id <> p_deck_id then
    raise exception 'claim_next_learning_engine_card: p_deck_id does not match session %''s deck', p_session_id
      using errcode = '42501';
  end if;

  -- =========================================================================
  -- Step 4-5: OPEN-claim fast path (lost-response retry). Serialized by the
  -- session row lock above -- no concurrent caller can observe "no OPEN
  -- claim" and then lose a race to create one; the second caller simply
  -- blocks on the lock above until the first commits, then finds it here.
  -- Never reaches the active-draw-counter logic below -- a reused claim
  -- never advances any counter a second time.
  -- =========================================================================
  select * into v_existing_claim
  from public.selection_claims
  where session_id = p_session_id and status = 'OPEN';

  if found then
    return jsonb_build_object('reused', true, 'claim', to_jsonb(v_existing_claim), 'schedulerRevision', v_existing_claim.scheduler_revision);
  end if;

  -- =========================================================================
  -- Step 6-7: lock/read authoritative deck state; verify the optimistic-
  -- concurrency token. SQLSTATE 40001, this project's existing
  -- stale-snapshot convention (commit_answer_transaction(),
  -- normalize_card_progress_for_learning_engine_v1()).
  -- =========================================================================
  select * into v_deck_state
  from public.user_deck_learning_state
  where user_id = p_user_id and deck_id = p_deck_id
  for update;

  if not found then
    raise exception 'claim_next_learning_engine_card: no user_deck_learning_state for user % deck %', p_user_id, p_deck_id
      using errcode = '42501';
  end if;

  if v_deck_state.scheduler_position <> p_expected_scheduler_position
     or v_deck_state.scheduler_revision <> p_expected_scheduler_revision then
    raise exception 'claim_next_learning_engine_card: stale scheduler snapshot for user % deck % (expected position=%, revision=%; actual position=%, revision=%)',
      p_user_id, p_deck_id, p_expected_scheduler_position, p_expected_scheduler_revision,
      v_deck_state.scheduler_position, v_deck_state.scheduler_revision
      using errcode = '40001';
  end if;

  -- =========================================================================
  -- Step 8: independent entity validation -- never trust a client/TS-
  -- supplied id merely because TypeScript produced it (brief section 11).
  -- =========================================================================
  if p_card_id is not null then
    select * into v_card from public.cards where id = p_card_id;
    if not found or v_card.deck_id <> p_deck_id or v_card.deleted_at is not null then
      raise exception 'claim_next_learning_engine_card: selected card % is not a valid, non-deleted card in deck %', p_card_id, p_deck_id
        using errcode = '42501';
    end if;
  end if;

  if coalesce(array_length(p_admitted_card_ids, 1), 0) > 0 then
    select admitted.id into v_bad_id
    from unnest(p_admitted_card_ids) as admitted(id)
    left join public.cards c on c.id = admitted.id and c.deck_id = p_deck_id and c.deleted_at is null
    left join public.user_card_progress ucp on ucp.card_id = admitted.id and ucp.user_id = p_user_id and ucp.card_status = 'NEW'
    where c.id is null or ucp.card_id is null
    limit 1;
    if v_bad_id is not null then
      raise exception 'claim_next_learning_engine_card: admitted card % is not a valid NEW admission candidate in deck % for user %', v_bad_id, p_deck_id, p_user_id
        using errcode = '42501';
    end if;
  end if;

  if coalesce(array_length(p_first_pass_queue_after, 1), 0) > 0 then
    select q.id into v_bad_id
    from unnest(p_first_pass_queue_after) as q(id)
    left join public.cards c on c.id = q.id and c.deck_id = p_deck_id and c.deleted_at is null
    where c.id is null
    limit 1;
    if v_bad_id is not null then
      raise exception 'claim_next_learning_engine_card: first-pass queue references card % which is not a valid, non-deleted card in deck %', v_bad_id, p_deck_id
        using errcode = '42501';
    end if;
  end if;

  if coalesce(array_length(p_post_mastery_shuffle_bag_after, 1), 0) > 0 then
    select b.id into v_bad_id
    from unnest(p_post_mastery_shuffle_bag_after) as b(id)
    left join public.cards c on c.id = b.id and c.deck_id = p_deck_id and c.deleted_at is null
    where c.id is null
    limit 1;
    if v_bad_id is not null then
      raise exception 'claim_next_learning_engine_card: shuffle bag references card % which is not a valid, non-deleted card in deck %', v_bad_id, p_deck_id
        using errcode = '42501';
    end if;
  end if;

  -- =========================================================================
  -- Step 8b (new): active_draws_since_eligible updates -- structural
  -- validation ONLY. This block does not, and must never, re-derive why a
  -- card was or was not an eligible ordinary Active candidate (that
  -- remains exclusively TypeScript's job -- see migration header). It
  -- locks and validates each referenced user_card_progress row before any
  -- write below actually happens.
  -- =========================================================================
  if p_active_draw_counter_updates is not null and jsonb_array_length(p_active_draw_counter_updates) > 0 then
    for v_counter in select * from jsonb_array_elements(p_active_draw_counter_updates)
    loop
      v_counter_card_id := (v_counter ->> 'card_id')::uuid;
      v_counter_before := (v_counter ->> 'before')::integer;
      v_counter_after := (v_counter ->> 'after')::integer;

      if v_counter_card_id is null or v_counter_before is null or v_counter_after is null then
        raise exception 'claim_next_learning_engine_card: active draw counter update is missing card_id/before/after'
          using errcode = '22023';
      end if;
      if v_counter_after < 0 then
        raise exception 'claim_next_learning_engine_card: active draw counter update for card % has a negative after-value (%)', v_counter_card_id, v_counter_after
          using errcode = '22023';
      end if;

      select ucp.active_draws_since_eligible into v_counter_current
      from public.user_card_progress ucp
      join public.cards c on c.id = ucp.card_id
      where ucp.user_id = p_user_id
        and ucp.card_id = v_counter_card_id
        and c.deck_id = p_deck_id
        and c.deleted_at is null
      for update of ucp;

      if not found then
        raise exception 'claim_next_learning_engine_card: active draw counter update references card % which is not a valid, non-deleted card in deck % for user %', v_counter_card_id, p_deck_id, p_user_id
          using errcode = '42501';
      end if;

      if v_counter_current <> v_counter_before then
        raise exception 'claim_next_learning_engine_card: stale active_draws_since_eligible for card % (expected before=%, actual=%)', v_counter_card_id, v_counter_before, v_counter_current
          using errcode = '40001';
      end if;

      update public.user_card_progress
      set active_draws_since_eligible = v_counter_after
      where user_id = p_user_id and card_id = v_counter_card_id;
    end loop;
  end if;

  -- =========================================================================
  -- Step 9: atomic persistence. Always persist the historical telemetry
  -- trace (append-only; safe regardless of outcome -- Phase 8 already
  -- supports card_id = NULL for a no_card_all_unavailable decision). Only
  -- a genuine claim-time STATE MUTATION (a card was claimed, cards were
  -- admitted, the first-pass queue/shuffle bag changed, or an active-draw
  -- counter changed) bumps scheduler_revision and writes the corresponding
  -- state -- never for a no-card decision with no other side effect
  -- (brief section 10).
  -- =========================================================================
  -- NOTE: deliberately `select t.* into v_trace from function(...) as t`,
  -- not the seemingly-equivalent `select function(...) into v_trace` --
  -- the latter was verified (direct reproduction against this exact
  -- function) to occasionally bind positionally against v_trace's first
  -- FIELD (id uuid) using the whole composite's text representation,
  -- raising "invalid input syntax for type uuid", rather than performing
  -- a whole-row assignment. The `FROM function(...) AS t` + `t.*` form
  -- forces genuine column-by-column binding and has none of that ambiguity.
  select t.* into v_trace
  from public.insert_learning_engine_selection_trace(
    p_trace_id, p_user_id, p_deck_id, p_card_id, p_session_id, p_occurred_at,
    p_expected_scheduler_position, p_expected_scheduler_revision,
    p_source, p_selection_reason, p_scheduler_mode,
    p_due_count, p_daily_goal_complete_before,
    p_candidate_count_active, p_candidate_count_due, p_candidate_count_near, p_candidate_count_random_mastered,
    p_source_weight_active_raw, p_source_weight_due_raw, p_source_weight_near_raw, p_source_weight_random_mastered_raw,
    p_source_weight_active_normalized, p_source_weight_due_normalized, p_source_weight_near_normalized, p_source_weight_random_mastered_normalized,
    p_card_priority_weight, p_retrievability, p_interval_progress,
    p_admitted_card_ids,
    p_first_pass_queue_before, p_first_pass_queue_after,
    p_post_mastery_shuffle_bag_before, p_post_mastery_shuffle_bag_after,
    p_emergency_fallback_applied, p_random_draws,
    p_policy_version, p_trace_payload
  ) as t;

  v_has_mutation :=
    p_card_id is not null
    or (coalesce(array_length(p_admitted_card_ids, 1), 0) > 0)
    or (coalesce(p_first_pass_queue_after, '{}') <> coalesce(p_first_pass_queue_before, '{}'))
    or (coalesce(p_post_mastery_shuffle_bag_after, '{}') <> coalesce(p_post_mastery_shuffle_bag_before, '{}'))
    or (p_active_draw_counter_updates is not null and jsonb_array_length(p_active_draw_counter_updates) > 0);

  if not v_has_mutation then
    return jsonb_build_object('reused', false, 'claim', null, 'trace', to_jsonb(v_trace), 'schedulerRevision', v_deck_state.scheduler_revision);
  end if;

  v_next_revision := v_deck_state.scheduler_revision + 1;

  update public.user_deck_learning_state
  set scheduler_revision = v_next_revision,
      first_pass_queue = to_jsonb(p_first_pass_queue_after),
      post_mastery_shuffle_bag_state = to_jsonb(p_post_mastery_shuffle_bag_after)
  where user_id = p_user_id and deck_id = p_deck_id;

  if coalesce(array_length(p_admitted_card_ids, 1), 0) > 0 then
    update public.user_card_progress
    set pool_status = 'ACTIVE'
    where user_id = p_user_id
      and card_id = any(p_admitted_card_ids)
      and card_status = 'NEW';
  end if;

  if p_card_id is not null then
    insert into public.selection_claims (
      user_id, deck_id, session_id, card_id, selection_trace_id,
      scheduler_position, scheduler_revision, status
    )
    values (
      p_user_id, p_deck_id, p_session_id, p_card_id, v_trace.id,
      p_expected_scheduler_position, v_next_revision, 'OPEN'
    )
    returning * into v_claim;
  end if;

  return jsonb_build_object(
    'reused', false,
    'claim', case when v_claim.id is null then null else to_jsonb(v_claim) end,
    'trace', to_jsonb(v_trace),
    'schedulerRevision', v_next_revision
  );
end;
$$;

comment on function public.claim_next_learning_engine_card(
  uuid, uuid, uuid, integer, integer, uuid, text, text, uuid[], uuid[], uuid[], uuid[], uuid[],
  uuid, timestamptz, text, integer, boolean, integer, integer, integer, integer,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, boolean, double precision[], text, jsonb, jsonb
) is
  'Runtime Cutover RC-B (corrected): the atomic Selection Claim Transaction. SECURITY DEFINER, service_role-only. Serializes on the sessions row, returns an existing OPEN claim unchanged (lost-response retry), rejects a stale scheduler_position/scheduler_revision snapshot or a stale active_draws_since_eligible before-value (both SQLSTATE 40001), independently revalidates every referenced card id, and atomically persists the SelectionTrace (via insert_learning_engine_selection_trace) plus -- only on a genuine claim-time state mutation -- the new selection_claims row, Active admissions, first-pass queue, shuffle bag, claim-time active_draws_since_eligible deltas, and a single scheduler_revision increment. Never advances scheduler_position or any card lifecycle/FSRS/mastery field. active_draws_since_eligible is now exclusively a claim-time concern (RC-C pre-check B) -- a future answer-commit transaction must not touch it. Not wired into any live call site.';

revoke all on function public.claim_next_learning_engine_card(
  uuid, uuid, uuid, integer, integer, uuid, text, text, uuid[], uuid[], uuid[], uuid[], uuid[],
  uuid, timestamptz, text, integer, boolean, integer, integer, integer, integer,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, boolean, double precision[], text, jsonb, jsonb
) from public, anon, authenticated;

grant execute on function public.claim_next_learning_engine_card(
  uuid, uuid, uuid, integer, integer, uuid, text, text, uuid[], uuid[], uuid[], uuid[], uuid[],
  uuid, timestamptz, text, integer, boolean, integer, integer, integer, integer,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, boolean, double precision[], text, jsonb, jsonb
) to service_role;
