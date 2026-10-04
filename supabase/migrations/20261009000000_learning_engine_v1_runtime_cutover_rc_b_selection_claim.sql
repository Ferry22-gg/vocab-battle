-- Learning Engine v1 -- Runtime Cutover RC-B: the Selection Claim
-- Transaction (trusted read -> decide -> claim path around the
-- already-complete, pure chooseNextCard() scheduler).
--
-- Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md (section 8.4's
-- decide/persist separation) and the RC-B task brief this migration was
-- commissioned under. Builds on RC-A
-- (20261007000000_learning_engine_v1_runtime_cutover_schema.sql,
-- 20261008000000_learning_engine_v1_cutover_normalization_functions.sql)
-- without modifying either.
--
-- Scope: two new SECURITY DEFINER, service_role-only trusted functions,
-- plus one forward-only schema correction (Section A below). Strictly
-- additive: no existing column/constraint/table is dropped or narrowed,
-- get_next_session_card()/commit_answer_transaction()/
-- start_or_resume_session()/finish_session() are completely untouched, and
-- nothing here is wired into any live Server Action or Session UI path.
--
-- ---------------------------------------------------------------------
-- Section A: selection_claims.selection_trace_id -- forward-only 1:1
-- correction (RC-B audit finding, spec/brief section 14)
-- ---------------------------------------------------------------------
-- RC-A's selection_claims schema (20261007000000) gave selection_trace_id
-- a plain FK (on delete restrict) but no UNIQUE constraint -- nothing
-- schema-level prevented two different claims from referencing the same
-- SelectionTrace, even though exactly one logical selection decision must
-- produce exactly one trace and exactly one claim (brief section 14). No
-- code anywhere has ever inserted a second claim against an existing
-- trace (selection_claims has no trusted writer at all before this
-- migration), so this closes a latent schema gap before RC-B's claim
-- transaction becomes the first writer, rather than discovering it after
-- the fact. selection_trace_id is NOT NULL on this table, so a plain
-- (non-partial) unique index is sufficient -- unlike the existing
-- selection_claims_one_open_per_session_idx, there is no "only some rows
-- care" predicate here.
create unique index selection_claims_selection_trace_id_unique_idx
  on public.selection_claims (selection_trace_id);

-- ---------------------------------------------------------------------
-- Section B: get_learning_engine_v1_scheduler_snapshot()
-- ---------------------------------------------------------------------
-- The trusted READ half of the read -> decide -> claim pipeline. Produces
-- exactly one authoritative DeckSchedulerSnapshot (lib/learning-engine/
-- scheduler/snapshot.ts) for one v1 Session, under one PostgreSQL
-- statement snapshot (the single big `select jsonb_build_object(...)`
-- below, which reads user_deck_learning_state/daily_user_stats/cards/
-- user_card_progress/selection_claims together in one query so none of
-- them can observe a different point in time than the others).
--
-- SECURITY DEFINER / service_role-only, same trust boundary as every
-- other Learning Engine v1 trusted function (commit_answer_transaction(),
-- insert_learning_engine_selection_trace()): this cannot run inside the
-- end user's own authenticated Postgres session (no such session exists
-- for a trusted server-side orchestrator), so it accepts p_user_id as an
-- explicit parameter and independently re-verifies session ownership
-- before reading anything -- the same pattern commit_answer_transaction()
-- already established.
--
-- Session's stored deck_id is authoritative (never
-- profiles.selected_deck_id) -- this function reads v_session.deck_id
-- exclusively, per the spec's own explicit instruction.
--
-- A card is NEVER silently repaired here. Validation of complete vs.
-- partial state (FORGOTTEN repair-obligation completeness, etc.) is
-- TypeScript's job (the pure snapshot mapper this function's caller
-- feeds) -- this function's only "write" is the single idempotent
-- user_deck_learning_state lazy-upsert below, which creates nothing but
-- already-correct column defaults, exactly mirroring RC-A's own
-- recompute_user_deck_learning_state_for_v1() precedent for a deck with
-- no existing row (e.g. one duplicated after the Phase 1 backfill ran).
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

  -- Lazy row-exists guarantee (RC-A precedent: recompute_user_deck_learning_state_for_v1()'s
  -- own "ensures a row exists first" comment, same ON CONFLICT DO NOTHING
  -- shape). Section 14.3/27.2: 0.92 only when the caller's persisted
  -- pain_point is 'retention_loss', otherwise the column default of 0.90.
  select case when ulp.pain_point = 'retention_loss' then 0.92 else 0.90 end
  into v_desired_retention
  from public.user_learning_preferences ulp
  where ulp.user_id = p_user_id;

  insert into public.user_deck_learning_state (user_id, deck_id, desired_retention)
  values (p_user_id, v_session.deck_id, coalesce(v_desired_retention, 0.90))
  on conflict (user_id, deck_id) do nothing;

  v_stat_date := (now() at time zone 'Asia/Tokyo')::date;

  -- The single authoritative snapshot statement: deck state, Daily Goal,
  -- every non-deleted card's full schedulable state, and the session's
  -- current OPEN claim (if any, for the orchestrator's fast path) -- all
  -- read together under one statement snapshot.
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
    'openClaim', (
      select jsonb_build_object(
        'id', sc.id,
        'cardId', sc.card_id,
        'selectionTraceId', sc.selection_trace_id,
        'schedulerPosition', sc.scheduler_position,
        'schedulerRevision', sc.scheduler_revision
      )
      from public.selection_claims sc
      where sc.session_id = p_session_id and sc.status = 'OPEN'
    )
  )
  into v_result;

  return v_result;
end;
$$;

comment on function public.get_learning_engine_v1_scheduler_snapshot(uuid, uuid) is
  'Runtime Cutover RC-B: trusted single-statement read of one authoritative DeckSchedulerSnapshot for a v1 Session (deck state, Daily Goal, every non-deleted card''s full schedulable state, and the session''s current OPEN claim if any). SECURITY DEFINER, service_role-only. Rejects a non-v1/inactive/foreign session. Session.deck_id is authoritative, never profiles.selected_deck_id. Its only write is an idempotent lazy user_deck_learning_state upsert (RC-A precedent). Not wired into any live call site.';

revoke all on function public.get_learning_engine_v1_scheduler_snapshot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_learning_engine_v1_scheduler_snapshot(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------
-- Section C: claim_next_learning_engine_card()
-- ---------------------------------------------------------------------
-- The trusted CLAIM half: atomically persists one chooseNextCard()
-- decision as a durable OPEN selection_claims row, or -- the lost-response
-- retry path -- returns the session's existing OPEN claim unchanged.
--
-- Concurrency ordering (brief section 7): lock sessions row first (same
-- "lock the target row before validating/updating it" pattern
-- finish_session() already uses) -- this alone serializes every
-- concurrent claim attempt for this session, so the subsequent "does an
-- OPEN claim already exist" check can never race with a concurrent
-- insert. Then lock+read user_deck_learning_state for the
-- scheduler_position/scheduler_revision optimistic-concurrency check.
-- Locking order: sessions -> user_deck_learning_state -> (trace insert
-- via the existing Phase 8 primitive) -> selection_claims insert ->
-- user_card_progress admissions, matching this project's existing fixed-
-- order convention (commit_answer_transaction()'s own header comment).
--
-- Never advances scheduler_position, card_status, learning_stage, FSRS
-- state, or mastery counters -- those remain exclusively RC-C/answer-
-- commit concerns (brief sections 12/18).
create or replace function public.claim_next_learning_engine_card(
  p_user_id uuid,
  p_session_id uuid,
  p_deck_id uuid,

  -- Optimistic-concurrency token: the PRE-claim snapshot values the
  -- decision was computed from.
  p_expected_scheduler_position integer,
  p_expected_scheduler_revision integer,

  -- The NextCardDecision itself (nullable card_id for no_card_all_unavailable).
  p_card_id uuid,
  p_source text,
  p_selection_reason text,
  p_admitted_card_ids uuid[],
  p_first_pass_queue_before uuid[],
  p_first_pass_queue_after uuid[],
  p_post_mastery_shuffle_bag_before uuid[],
  p_post_mastery_shuffle_bag_after uuid[],

  -- SelectionTrace fields, forwarded verbatim to the existing Phase 8
  -- insert_learning_engine_selection_trace() primitive -- never
  -- recomputed or reinterpreted here.
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
  p_trace_payload jsonb
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
  -- Step 9: atomic persistence. Always persist the historical telemetry
  -- trace (append-only; safe regardless of outcome -- Phase 8 already
  -- supports card_id = NULL for a no_card_all_unavailable decision). Only
  -- a genuine claim-time STATE MUTATION (a card was claimed, cards were
  -- admitted, or the first-pass queue/shuffle bag changed) bumps
  -- scheduler_revision and writes the corresponding state -- never for a
  -- no-card decision with no other side effect (brief section 10).
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
    or (coalesce(p_post_mastery_shuffle_bag_after, '{}') <> coalesce(p_post_mastery_shuffle_bag_before, '{}'));

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
  double precision, double precision, double precision, boolean, double precision[], text, jsonb
) is
  'Runtime Cutover RC-B: the atomic Selection Claim Transaction. SECURITY DEFINER, service_role-only. Serializes on the sessions row, returns an existing OPEN claim unchanged (lost-response retry), rejects a stale scheduler_position/scheduler_revision snapshot (SQLSTATE 40001), independently revalidates every referenced card id, and atomically persists the SelectionTrace (via insert_learning_engine_selection_trace) plus -- only on a genuine claim-time state mutation -- the new selection_claims row, Active admissions, first-pass queue, shuffle bag, and a single scheduler_revision increment. Never advances scheduler_position or any card lifecycle/FSRS/mastery field. Not wired into any live call site.';

revoke all on function public.claim_next_learning_engine_card(
  uuid, uuid, uuid, integer, integer, uuid, text, text, uuid[], uuid[], uuid[], uuid[], uuid[],
  uuid, timestamptz, text, integer, boolean, integer, integer, integer, integer,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, boolean, double precision[], text, jsonb
) from public, anon, authenticated;

grant execute on function public.claim_next_learning_engine_card(
  uuid, uuid, uuid, integer, integer, uuid, text, text, uuid[], uuid[], uuid[], uuid[], uuid[],
  uuid, timestamptz, text, integer, boolean, integer, integer, integer, integer,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, boolean, double precision[], text, jsonb
) to service_role;
