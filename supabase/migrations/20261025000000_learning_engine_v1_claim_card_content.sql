-- Alpha performance optimization: the Learning Engine v1 next-card path
-- (lib/learning-engine/runtime/claim-next-card.ts's claimNextLearningEngineCard())
-- always followed a successful claim/reuse with a SEPARATE
-- getCardFrontBack() SELECT against public.cards, purely to render the
-- card's display content -- a fourth sequential round trip that adds
-- nothing to scheduling, claiming, or persistence. Both trusted functions
-- below already read (or can cheaply read) the claimed card's row; this
-- migration has each one additionally return that card's `front`/`back`
-- as part of its existing jsonb result, so the caller never needs the
-- follow-up SELECT.
--
-- Forward-only, body-only changes (CREATE OR REPLACE -- neither
-- function's parameter list changes, so no DROP is required, unlike the
-- RC-B corrective migrations that added a new parameter). Does not edit
-- 20261009000000_learning_engine_v1_runtime_cutover_rc_b_selection_claim.sql
-- or 20261011000000_learning_engine_v1_runtime_cutover_rc_b_active_draw_counters.sql
-- -- both remain applied as-is; this migration only layers a later
-- CREATE OR REPLACE on top, exactly the same relationship every other
-- "touch an existing trusted function's behavior" migration in this repo
-- has to the migration that first created it.
--
-- Everything else about both functions is byte-for-byte unchanged:
-- validation order, locking order, the OPEN-claim fast-path's own
-- semantics (still never creates a second claim, never bumps
-- scheduler_position/scheduler_revision, never rerolls admission, never
-- advances active_draws_since_eligible), the stale-snapshot SQLSTATE
-- 40001 convention, and every existing grant. No new database write is
-- introduced -- both additions are pure SELECTs layered onto branches
-- that already read or validate the same card row.

-- =========================================================================
-- get_learning_engine_v1_scheduler_snapshot(): the snapshot's own
-- `openClaim` object (the PRIMARY reload/lost-response fast path -- see
-- claim-next-card.ts's own header: this is checked BEFORE the claim RPC
-- is ever called) now also carries the claimed card's front/back.
-- =========================================================================
create or replace function public.get_learning_engine_v1_scheduler_snapshot(
  p_user_id uuid,
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.sessions;
  v_desired_retention double precision;
  v_stat_date date;
  v_result jsonb;
begin
  if p_user_id is null then
    raise exception 'get_learning_engine_v1_scheduler_snapshot: p_user_id is required'
      using errcode = '22023';
  end if;

  select * into v_session
  from public.sessions
  where id = p_session_id;

  if not found then
    raise exception 'get_learning_engine_v1_scheduler_snapshot: session % not found', p_session_id
      using errcode = '22023';
  end if;
  if v_session.user_id <> p_user_id then
    raise exception 'get_learning_engine_v1_scheduler_snapshot: session % does not belong to caller', p_session_id
      using errcode = '42501';
  end if;
  if v_session.status <> 'active' then
    raise exception 'get_learning_engine_v1_scheduler_snapshot: session % is not active', p_session_id
      using errcode = '42501';
  end if;
  if v_session.engine_version <> 'v1' then
    raise exception 'get_learning_engine_v1_scheduler_snapshot: session % is not an engine_version=v1 session', p_session_id
      using errcode = '42501';
  end if;

  select case when ulp.pain_point = 'retention_loss' then 0.92 else 0.90 end
  into v_desired_retention
  from public.user_learning_preferences ulp
  where ulp.user_id = p_user_id;

  insert into public.user_deck_learning_state (user_id, deck_id, desired_retention)
  values (p_user_id, v_session.deck_id, coalesce(v_desired_retention, 0.90))
  on conflict (user_id, deck_id) do nothing;

  v_stat_date := (now() at time zone 'Asia/Tokyo')::date;

  select jsonb_build_object(
    'userId', p_user_id,
    'deckId', v_session.deck_id,
    'now', now(),
    'deckState', (
      select jsonb_build_object(
        'desiredRetention', uds.desired_retention,
        'policyVersion', uds.policy_version,
        'hasAchievedFullMastery', uds.has_achieved_full_mastery,
        'masteredCount', uds.mastered_count,
        'schedulerPosition', uds.scheduler_position,
        'lastCriticalDuePosition', uds.last_critical_due_position,
        'schedulerRevision', uds.scheduler_revision,
        'firstPassQueue', uds.first_pass_queue,
        'postMasteryShuffleBag', uds.post_mastery_shuffle_bag_state
      )
      from public.user_deck_learning_state uds
      where uds.user_id = p_user_id and uds.deck_id = v_session.deck_id
    ),
    'dailyGoal', (
      select jsonb_build_object(
        'enemiesDefeatedToday', coalesce(dus.enemies_defeated, 0),
        'completed', coalesce(dus.daily_goal_completed, false)
      )
      from public.daily_user_stats dus
      where dus.user_id = p_user_id and dus.stat_date = v_stat_date
    ),
    'cards', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'cardId', c.id,
        'cardStatus', ucp.card_status,
        'learningStage', ucp.learning_stage,
        'poolStatus', ucp.pool_status,
        'relearningPhase', ucp.relearning_phase,
        'hasEverBeenMastered', ucp.has_ever_been_mastered,
        'repairPending', ucp.repair_pending,
        'repairWrongPosition', ucp.repair_wrong_position,
        'repairTargetPosition', ucp.repair_target_position,
        'repairHardCapPosition', ucp.repair_hard_cap_position,
        'correctCooldownUntilPosition', ucp.correct_cooldown_until_position,
        'activeDrawsSinceEligible', ucp.active_draws_since_eligible,
        'fsrsReviewCorrectCount', ucp.fsrs_review_correct_count,
        'fsrsReviewCorrectStreak', ucp.fsrs_review_correct_streak,
        'fsrsDueAt', ucp.fsrs_due_at,
        'fsrsStability', ucp.fsrs_stability,
        'fsrsDifficulty', ucp.fsrs_difficulty,
        'fsrsElapsedDays', ucp.fsrs_elapsed_days,
        'fsrsScheduledDays', ucp.fsrs_scheduled_days,
        'fsrsReps', ucp.fsrs_reps,
        'fsrsLapses', ucp.fsrs_lapses,
        'fsrsLearningSteps', ucp.fsrs_learning_steps,
        'fsrsState', ucp.fsrs_state,
        'fsrsLastReviewAt', ucp.fsrs_last_review_at
      ) order by c.sort_order, c.id), '[]'::jsonb)
      from public.cards c
      join public.user_card_progress ucp
        on ucp.card_id = c.id and ucp.user_id = p_user_id
      where c.deck_id = v_session.deck_id
        and c.deleted_at is null
    ),
    -- Performance optimization addition: 'front'/'back' from the claimed
    -- card's own row, via a plain join -- the fast path no longer leaves
    -- the caller needing a second SELECT to render it. Everything else
    -- about this object (id/cardId/selectionTraceId/schedulerPosition/
    -- schedulerRevision) is unchanged.
    'openClaim', (
      select jsonb_build_object(
        'id', sc.id,
        'cardId', sc.card_id,
        'selectionTraceId', sc.selection_trace_id,
        'schedulerPosition', sc.scheduler_position,
        'schedulerRevision', sc.scheduler_revision,
        'front', oc_card.front,
        'back', oc_card.back
      )
      from public.selection_claims sc
      left join public.cards oc_card on oc_card.id = sc.card_id
      where sc.session_id = p_session_id and sc.status = 'OPEN'
    )
  )
  into v_result;

  return v_result;
end;
$$;

comment on function public.get_learning_engine_v1_scheduler_snapshot(uuid, uuid) is
  'Runtime Cutover RC-B (Alpha perf addition): trusted single-statement read of one authoritative DeckSchedulerSnapshot for a v1 Session (deck state, Daily Goal, every non-deleted card''s full schedulable state, and the session''s current OPEN claim if any -- now including that claim''s card front/back, so the orchestrator''s fast path never needs a follow-up SELECT). SECURITY DEFINER, service_role-only. Rejects a non-v1/inactive/foreign session. Session.deck_id is authoritative, never profiles.selected_deck_id. Its only write is an idempotent lazy user_deck_learning_state upsert (RC-A precedent).';

revoke all on function public.get_learning_engine_v1_scheduler_snapshot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_learning_engine_v1_scheduler_snapshot(uuid, uuid) to service_role;

-- =========================================================================
-- claim_next_learning_engine_card(): both the rare RPC-level "existing
-- OPEN claim" race-window branch and the normal fresh-claim branch now
-- also return the claimed card's front/back. The no-card/no-mutation
-- branch returns null for both (no card was claimed). Validation order,
-- locking order, every existing exception/SQLSTATE, and the single-
-- scheduler_revision-bump-per-claim invariant are all unchanged -- only
-- the three `jsonb_build_object(...)` return expressions gained two new
-- keys each.
-- =========================================================================
create or replace function public.claim_next_learning_engine_card(
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
  -- Step 4-5: OPEN-claim fast path (lost-response retry / rare race
  -- window -- the PRIMARY reload fast path is the snapshot RPC's own
  -- `openClaim`, checked by the caller before this function is ever
  -- invoked; this branch only fires if a concurrent caller created the
  -- claim between that read and this call). Serialized by the session
  -- row lock above -- no concurrent caller can observe "no OPEN claim"
  -- and then lose a race to create one; the second caller simply blocks
  -- on the lock above until the first commits, then finds it here.
  -- Never reaches the active-draw-counter logic below -- a reused claim
  -- never advances any counter a second time, never creates a second
  -- claim, and never bumps scheduler_position/scheduler_revision.
  --
  -- Performance optimization addition: this branch now also returns the
  -- existing claim's card content -- a plain SELECT against the already-
  -- identified card_id, not a second claim/mutation of any kind. A claim
  -- row's card_id is NOT NULL and FK-constrained to an existing card, so
  -- failing to find it here is a genuine invariant violation, not a
  -- normal outcome -- raised loudly rather than silently returned as
  -- null content.
  -- =========================================================================
  select * into v_existing_claim
  from public.selection_claims
  where session_id = p_session_id and status = 'OPEN';

  if found then
    select * into v_card
    from public.cards
    where id = v_existing_claim.card_id;

    if not found then
      raise exception 'claim_next_learning_engine_card: existing OPEN claim % references card % which no longer exists', v_existing_claim.id, v_existing_claim.card_id
        using errcode = '42501';
    end if;

    return jsonb_build_object(
      'reused', true,
      'claim', to_jsonb(v_existing_claim),
      'schedulerRevision', v_existing_claim.scheduler_revision,
      'cardFront', v_card.front,
      'cardBack', v_card.back
    );
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
  -- Performance optimization: this is also where v_card (used for the
  -- card-content fields in the final return below) is populated, so no
  -- extra SELECT is introduced -- this validation read already happened
  -- on every prior version of this function; only its result is now
  -- carried through to the return value too.
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
  -- Step 8b: active_draws_since_eligible updates -- structural validation
  -- ONLY. This block does not, and must never, re-derive why a card was
  -- or was not an eligible ordinary Active candidate (that remains
  -- exclusively TypeScript's job). It locks and validates each referenced
  -- user_card_progress row before any write below actually happens.
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
  -- trace (append-only; safe regardless of outcome). Only a genuine
  -- claim-time STATE MUTATION bumps scheduler_revision and writes the
  -- corresponding state -- never for a no-card decision with no other
  -- side effect.
  -- =========================================================================
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
    -- No card was claimed (p_card_id is null whenever this branch is
    -- reachable with no mutation at all -- see v_has_mutation above), so
    -- there is no card content to return.
    return jsonb_build_object('reused', false, 'claim', null, 'trace', to_jsonb(v_trace), 'schedulerRevision', v_deck_state.scheduler_revision, 'cardFront', null, 'cardBack', null);
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
    'schedulerRevision', v_next_revision,
    'cardFront', case when p_card_id is null then null else v_card.front end,
    'cardBack', case when p_card_id is null then null else v_card.back end
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
  'Runtime Cutover RC-B (Alpha perf addition): the atomic Selection Claim Transaction. SECURITY DEFINER, service_role-only. Serializes on the sessions row, returns an existing OPEN claim unchanged (lost-response retry / race window -- now including that claim''s card front/back), rejects a stale scheduler_position/scheduler_revision snapshot or a stale active_draws_since_eligible before-value (both SQLSTATE 40001), independently revalidates every referenced card id, and atomically persists the SelectionTrace plus -- only on a genuine claim-time state mutation -- the new selection_claims row (now returned together with its card''s front/back), Active admissions, first-pass queue, shuffle bag, claim-time active_draws_since_eligible deltas, and a single scheduler_revision increment. Never advances scheduler_position or any card lifecycle/FSRS/mastery field. No new database write versus the prior version of this function -- only two additional keys in the existing jsonb result.';

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
