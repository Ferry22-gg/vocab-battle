-- Learning Engine v1 -- Phase 8: telemetry persistence.
-- Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections
-- 29-32 ("Data model requirements" / "Behavioral event logging" /
-- "Session logging" / "Binary input and future personalization") and 41
-- ("Claude Code working instructions").
--
-- ---------------------------------------------------------------------
-- Scope and non-goals (same additive discipline as
-- 20261001000000_learning_engine_v1_additive_schema.sql and
-- 20261002000000_learning_engine_v1_scheduler_position.sql)
-- ---------------------------------------------------------------------
-- This migration is STRICTLY additive:
--   - no existing column is dropped, renamed, or narrowed;
--   - the only two existing CHECK constraints touched are
--     answer_events.card_status_before/card_status_after, each WIDENED
--     (not narrowed -- see the dedicated comment block below) the same
--     way Phase 1 widened user_card_progress.card_status;
--   - commit_answer_transaction(), get_next_session_card(),
--     start_or_resume_session(), and every legacy write path are left
--     completely untouched. Nothing added here is read or written by
--     them. Every new column on answer_events/sessions is nullable (or
--     has a default that matches the column's existing legacy
--     behavior), so their existing explicit-column-list INSERT/UPDATE
--     statements continue to work unmodified.
--   - this migration does NOT wire any new column into a live write
--     path. It only prepares storage + a standalone trusted insert
--     primitive (lib/learning-engine/telemetry/dal.ts) for Phase 8's own
--     tests and for a FUTURE runtime-cutover phase to use. No live
--     session begins calling chooseNextCard() or v1 transition logic as
--     a result of this migration.
--
-- ---------------------------------------------------------------------
-- Why one new table (learning_engine_selection_traces) plus additive
-- columns on two existing tables (answer_events, sessions), not three
-- new tables
-- ---------------------------------------------------------------------
-- Selection traces have no existing equivalent anywhere in the schema
-- (chooseNextCard()'s SelectionTrace, lib/learning-engine/scheduler/
-- next-card.ts, is purely in-memory today) -- a genuinely new table is
-- the only option, and an append-only one: a trace is a historical fact
-- about what the scheduler decided, never corrected in place.
--
-- The v1 review event (spec section 30) and the v1 session telemetry
-- fields (spec section 31) DO have existing equivalents: answer_events
-- and sessions are already exactly the right grain (one row per
-- answered card; one row per session) and are already the authoritative
-- raw-history / current-state homes for the legacy engine's own
-- telemetry. Spec section 41.1 ("read the existing schema first; do not
-- create duplicate concepts if equivalent fields already exist") and
-- section 7 of this phase's own brief ("audit existing answer_events
-- before altering... extend it additively where practical") both argue
-- directly against a parallel v1-only events/sessions table: that would
-- split one logical review-event stream across two tables for no
-- semantic reason, and would need its own idempotency/RLS/index
-- machinery duplicating what answer_events already has.
--
-- ---------------------------------------------------------------------
-- Observed data vs policy data (spec section 3 of this phase's brief)
-- ---------------------------------------------------------------------
-- Every column added below is commented as either an OBSERVED/BEHAVIORAL
-- fact (what happened: correctness, timing, counts, FSRS state, which
-- source/reason a trusted decision actually used) or a POLICY/SCHEDULER
-- parameter (what regime was in force: policy_version, fsrs_version,
-- parameter_set_id, nominal source weights, scheduler_mode). The two are
-- never collapsed into one opaque JSON blob -- jsonb is used only for
-- learning_engine_selection_traces.trace_payload, as a canonical,
-- complete mirror of the typed columns for debugging/round-trip fidelity
-- (spec section 4: "queryable typed columns + a canonical JSONB
-- trace_payload"), never as the only storage for a field that needs
-- filtering/indexing.

-- =========================================================================
-- learning_engine_selection_traces
-- =========================================================================
-- Append-only. One row per chooseNextCard() decision a future trusted
-- commit/claim path persists -- including a no-card decision
-- (card_id/source NULL, selection_reason = 'no_card_all_unavailable',
-- spec section 31 of the normative spec) and an emergency-fallback
-- decision (emergency_fallback_applied = true, spec section 32). Nothing
-- in this migration or Phase 1-7 writes to this table yet; Phase 8's own
-- tests and lib/learning-engine/telemetry/dal.ts are the only writers
-- until a future cutover phase wires it into the trusted selection path
-- (see this migration's header and the Phase 8 handoff report's
-- "Atomicity design" section for why this is deliberately not done yet).
--
-- `id` IS the trace_id (spec section 5: "SelectionTrace currently comes
-- from a pure scheduler and must remain pure... the trusted caller/
-- persistence layer owns trace_id, selected_at, session_id, user
-- identity"). No separate client-supplied idempotency column is needed
-- the way answer_events.client_event_id is: there is no browser/client
-- party in this write path at all (chooseNextCard() is pure and takes no
-- id/clock input; the DAL generates or accepts an explicit id so Phase
-- 8's own tests can supply deterministic values -- see dal.ts). A
-- regular PRIMARY KEY already prevents silently overwriting an existing
-- historical trace with different content (spec section 22: "do not
-- silently overwrite an existing historical trace") -- any attempted
-- re-insert of the same id is a hard conflict, not a silent UPSERT.
create table public.learning_engine_selection_traces (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references public.profiles (id) on delete restrict,
  deck_id uuid not null
    references public.decks (id) on delete restrict,
  -- Nullable: spec section 31 ("A scheduler decision may return
  -- no_card_all_unavailable... The selection-trace table must be able to
  -- store card_id = NULL").
  card_id uuid
    references public.cards (id) on delete restrict,
  session_id uuid not null
    references public.sessions (id) on delete restrict,

  -- "selected_at / occurred_at" (spec section 4). The trusted caller
  -- supplies `now` to chooseNextCard() already (DeckSchedulerSnapshot.now,
  -- lib/learning-engine/scheduler/snapshot.ts) -- this is that same
  -- instant, recorded by the persistence layer, not re-derived from
  -- wall-clock time inside this migration.
  occurred_at timestamptz not null default now(),

  -- OBSERVED: scheduler position/revision this decision was computed
  -- against (supabase/migrations/20261002000000_learning_engine_v1_scheduler_position.sql).
  scheduler_position integer not null
    check (scheduler_position >= 0),
  scheduler_revision integer not null
    check (scheduler_revision >= 0),

  -- OBSERVED: what the scheduler actually decided. `source` is nullable
  -- for the no-card outcome; `selection_reason` is never null (even
  -- no_card_all_unavailable is itself a reason). Both CHECK lists mirror
  -- lib/learning-engine/scheduler/next-card.ts's NextCardSource/
  -- SelectionReason unions exactly as of Phase 6E/7 -- the TypeScript
  -- union is authoritative (spec section 26); update this CHECK by hand
  -- if that union ever changes.
  source text
    check (source is null or source in ('ACTIVE', 'FSRS_DUE', 'NEAR_DUE', 'RANDOM_MASTERED')),
  selection_reason text not null
    check (selection_reason in (
      'repair_hard_cap',
      'critical_due_interrupt',
      'active_first_pass',
      'active_starvation',
      'repair_target',
      'spaced_confirmation',
      'active_weighted_selection',
      'due_weighted_selection',
      'near_due_weighted_selection',
      'random_mastered_shuffle_bag',
      'emergency_cooldown_relaxation',
      'no_card_all_unavailable'
    )),
  -- POLICY: which regime produced this decision. Mirrors
  -- lib/learning-engine/scheduler/source-policy.ts's SchedulerMode (6
  -- ordinary values) union lib/learning-engine/scheduler/
  -- post-mastery-source-policy.ts's PostMasterySchedulerMode (6
  -- Post-Mastery values) -- spec section 27: "audit the actual current
  -- scheduler-mode union... store what the scheduler actually emitted."
  scheduler_mode text not null
    check (scheduler_mode in (
      'pre_goal_active_focus',
      'pre_goal_balanced',
      'pre_goal_review_pressure',
      'post_goal_active_focus',
      'post_goal_balanced',
      'post_goal_review_pressure',
      'post_mastery_pre_goal_active_focus',
      'post_mastery_pre_goal_balanced',
      'post_mastery_pre_goal_review_pressure',
      'post_mastery_post_goal_active_focus',
      'post_mastery_post_goal_balanced',
      'post_mastery_post_goal_review_pressure'
    )),

  -- OBSERVED: due-pressure/goal state this decision read.
  due_count integer not null
    check (due_count >= 0),
  daily_goal_complete_before boolean not null,

  -- OBSERVED: SourceCandidateCounts (lib/learning-engine/scheduler/
  -- next-card.ts). ACTIVE's count already folds in starvation/repair-
  -- target/spaced-confirmation candidates (see that module's own
  -- computeActiveCandidateCount doc comment) -- not re-derived here.
  candidate_count_active integer not null
    check (candidate_count_active >= 0),
  candidate_count_due integer not null
    check (candidate_count_due >= 0),
  candidate_count_near integer not null
    check (candidate_count_near >= 0),
  candidate_count_random_mastered integer not null
    check (candidate_count_random_mastered >= 0),

  -- POLICY (raw) vs OBSERVED (normalized actual sampling probability) --
  -- spec section 9: "Preserve BOTH... RAW: nominal scheduler policy
  -- before empty-source masking/renormalization. NORMALIZED: actual
  -- source probabilities used for the ordinary weighted draw." Always
  -- present (FullSourceWeights, next-card.ts: "the dimension irrelevant
  -- to the current mode is always exactly 0, never omitted"), so NOT
  -- NULL throughout; bounded to [0, 1] since both raw and normalized
  -- weights are policy-fraction/probability values by construction.
  source_weight_active_raw double precision not null
    check (source_weight_active_raw >= 0 and source_weight_active_raw <= 1),
  source_weight_due_raw double precision not null
    check (source_weight_due_raw >= 0 and source_weight_due_raw <= 1),
  source_weight_near_raw double precision not null
    check (source_weight_near_raw >= 0 and source_weight_near_raw <= 1),
  source_weight_random_mastered_raw double precision not null
    check (source_weight_random_mastered_raw >= 0 and source_weight_random_mastered_raw <= 1),
  source_weight_active_normalized double precision not null
    check (source_weight_active_normalized >= 0 and source_weight_active_normalized <= 1),
  source_weight_due_normalized double precision not null
    check (source_weight_due_normalized >= 0 and source_weight_due_normalized <= 1),
  source_weight_near_normalized double precision not null
    check (source_weight_near_normalized >= 0 and source_weight_near_normalized <= 1),
  source_weight_random_mastered_normalized double precision not null
    check (source_weight_random_mastered_normalized >= 0 and source_weight_random_mastered_normalized <= 1),

  -- OBSERVED, all nullable per spec section 18's own per-reason nullability
  -- rules (lib/learning-engine/scheduler/next-card.ts's SelectionTrace
  -- doc comment): cardPriorityWeight is null for every deterministic-
  -- priority reason; retrievability only for due_weighted_selection/
  -- critical_due_interrupt; intervalProgress only for
  -- near_due_weighted_selection.
  card_priority_weight double precision
    check (card_priority_weight is null or card_priority_weight >= 0),
  retrievability double precision
    check (retrievability is null or (retrievability >= 0 and retrievability <= 1)),
  interval_progress double precision
    check (interval_progress is null or interval_progress >= 0),

  -- OBSERVED: NEW cards virtually admitted to ACTIVE during this
  -- decision (spec section 4 of the normative spec's Active Pool
  -- lifecycle; next-card.ts's admittedCardIds). Empty array, not NULL,
  -- when nothing was admitted -- there is always a well-defined
  -- (possibly empty) admission set for every decision.
  admitted_card_ids uuid[] not null default '{}',

  -- OBSERVED: first-pass queue / Post-Mastery shuffle-bag state this
  -- decision read and the state a future trusted commit should persist
  -- (spec sections 31/34; next-card.ts's firstPassQueueBefore/After,
  -- postMasteryShuffleBagBefore/After). NULL means "no batch/cycle in
  -- flight" -- the same normalization next-card.ts itself already
  -- applies (empty array collapsed to null), preserved verbatim rather
  -- than re-normalized here.
  first_pass_queue_before uuid[],
  first_pass_queue_after uuid[],
  post_mastery_shuffle_bag_before uuid[],
  post_mastery_shuffle_bag_after uuid[],

  -- OBSERVED: spec section 32 ("persist emergencyFallbackApplied...
  -- required to audit invariant fallback frequency later"). True for
  -- BOTH emergency outcomes (a relaxed selection succeeded, or none could
  -- even be found) -- see next-card.ts's own doc comment on this field.
  emergency_fallback_applied boolean not null default false,

  -- OBSERVED, replay/debugging context only (spec section 33: "Prefer
  -- JSONB or equivalent for the ordered draw list... It is replay/
  -- debugging context... Do not generate extra random values merely for
  -- telemetry"). Every value the injected RandomSource produced during
  -- this one decision, in consumption order. Empty array, not NULL, when
  -- no randomness was consumed (e.g. a deterministic repair_hard_cap with
  -- no tie-break needed).
  random_draws double precision[] not null default '{}',

  -- POLICY: spec section 29 ("every v1 review event and selection trace
  -- must preserve the values active at that decision... do not query
  -- 'current policy' later and assume it was the policy used
  -- historically"). Not null -- deckState.policyVersion is always
  -- populated on every snapshot (user_deck_learning_state.policy_version
  -- has a non-null default).
  policy_version text not null,

  -- Canonical full mirror of this row's own typed columns (plus the
  -- original camelCase SelectionTrace shape) for debugging/round-trip
  -- fidelity (spec section 4) -- never the ONLY storage for a field that
  -- needs filtering/indexing; every column above already exists in typed
  -- form for that purpose.
  trace_payload jsonb not null,

  created_at timestamptz not null default now()
);

create index learning_engine_selection_traces_user_id_occurred_at_idx
  on public.learning_engine_selection_traces (user_id, occurred_at);

create index learning_engine_selection_traces_deck_id_occurred_at_idx
  on public.learning_engine_selection_traces (deck_id, occurred_at);

create index learning_engine_selection_traces_card_id_occurred_at_idx
  on public.learning_engine_selection_traces (card_id, occurred_at)
  where card_id is not null;

create index learning_engine_selection_traces_session_id_occurred_at_idx
  on public.learning_engine_selection_traces (session_id, occurred_at);

create index learning_engine_selection_traces_selection_reason_idx
  on public.learning_engine_selection_traces (selection_reason);

create index learning_engine_selection_traces_policy_version_idx
  on public.learning_engine_selection_traces (policy_version);

-- RLS: same "trusted-state, append-only" design decision as answer_events/
-- xp_events (20260923180512_grants_and_rls.sql's header comment) --
-- authenticated gets SELECT only, scoped to their own rows or admin; no
-- INSERT/UPDATE/DELETE grant at all, so a direct authenticated write is
-- rejected by the grant system before RLS is even evaluated (spec section
-- 6: "normal authenticated users must not be able to update old traces,
-- rewrite policy/version fields, delete individual traces, forge another
-- user's trace"). service_role keeps its default (Supabase
-- auto_expose_new_tables) grants, which is what lib/learning-engine/
-- telemetry/dal.ts's trusted insert path relies on -- see that module and
-- supabase/tests/017_learning_engine_v1_telemetry_test.sql for the
-- "valid trusted write path works" proof.
alter table public.learning_engine_selection_traces enable row level security;

revoke all on table public.learning_engine_selection_traces from anon, authenticated;
grant select on table public.learning_engine_selection_traces to authenticated;

create policy learning_engine_selection_traces_select_own_or_admin
  on public.learning_engine_selection_traces
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- =========================================================================
-- answer_events: widen card_status_before/card_status_after to add
-- ACQUIRED (same technique as Phase 1's user_card_progress.card_status
-- widening, applied here for the same reason: a v1 review event can
-- legitimately have card_status_before/after = 'ACQUIRED', e.g. a
-- qualifying FSRS Correct on an already-ACQUIRED card, or the
-- LEARNING_2 -> ACQUIRED acquisition-graduation Correct itself)
-- =========================================================================
-- Purely additive: every row that satisfied the old 4-value constraint
-- still satisfies the new 5-value one, and no existing trusted function
-- (none of which ever write 'ACQUIRED') can start emitting it by
-- accident. Constraint names are looked up dynamically via conkey/
-- attnum (not conname ilike pattern-matching on the constraint
-- definition text) so the two separate per-column constraints
-- (card_status_before's and card_status_after's) cannot be confused with
-- each other -- an ilike '%card_status%' match would hit both.
do $$
declare
  v_conname text;
begin
  select con.conname into v_conname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  join pg_attribute att on att.attrelid = rel.oid and att.attnum = con.conkey[1]
  where nsp.nspname = 'public'
    and rel.relname = 'answer_events'
    and con.contype = 'c'
    and array_length(con.conkey, 1) = 1
    and att.attname = 'card_status_before';

  if v_conname is null then
    raise exception 'learning_engine_v1_telemetry: could not locate the existing card_status_before CHECK constraint on public.answer_events';
  end if;

  execute format('alter table public.answer_events drop constraint %I', v_conname);
end;
$$;

alter table public.answer_events
  add constraint answer_events_card_status_before_check
  check (card_status_before in ('NEW', 'LEARNING', 'ACQUIRED', 'LEARNED', 'FORGOTTEN'));

do $$
declare
  v_conname text;
begin
  select con.conname into v_conname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  join pg_attribute att on att.attrelid = rel.oid and att.attnum = con.conkey[1]
  where nsp.nspname = 'public'
    and rel.relname = 'answer_events'
    and con.contype = 'c'
    and array_length(con.conkey, 1) = 1
    and att.attname = 'card_status_after';

  if v_conname is null then
    raise exception 'learning_engine_v1_telemetry: could not locate the existing card_status_after CHECK constraint on public.answer_events';
  end if;

  execute format('alter table public.answer_events drop constraint %I', v_conname);
end;
$$;

alter table public.answer_events
  add constraint answer_events_card_status_after_check
  check (card_status_after in ('NEW', 'LEARNING', 'ACQUIRED', 'LEARNED', 'FORGOTTEN'));

-- answer_events.session_mode: widen to add 'v1' (same additive technique).
-- Legacy session_mode ('review'/'learning') encodes the LEGACY dual-queue
-- model (spec section 1.2: v1 explicitly removes the separate Learn/
-- Review-session split -- "Do not create separate user-facing 'Learn' and
-- 'Review' sessions"). Neither legacy value honestly describes a v1
-- unified-stream event, and this NOT NULL column has no v1-shaped
-- equivalent elsewhere on the row (source/selection_reason below carry
-- the actual v1 selection context) -- 'v1' is added as a third literal
-- value meaning exactly that: "this row was produced by the v1 engine's
-- unified stream; see source/selection_reason/scheduler_mode for the real
-- context," never reinterpreting what 'review'/'learning' mean for
-- existing/legacy rows.
do $$
declare
  v_conname text;
begin
  select con.conname into v_conname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  join pg_attribute att on att.attrelid = rel.oid and att.attnum = con.conkey[1]
  where nsp.nspname = 'public'
    and rel.relname = 'answer_events'
    and con.contype = 'c'
    and array_length(con.conkey, 1) = 1
    and att.attname = 'session_mode';

  if v_conname is null then
    raise exception 'learning_engine_v1_telemetry: could not locate the existing session_mode CHECK constraint on public.answer_events';
  end if;

  execute format('alter table public.answer_events drop constraint %I', v_conname);
end;
$$;

alter table public.answer_events
  add constraint answer_events_session_mode_check
  check (session_mode in ('review', 'learning', 'v1'));

-- =========================================================================
-- answer_events: new v1-only columns (spec section 8 / 30, this phase's
-- brief sections 7-17). Every column nullable: legacy rows (session_mode
-- in ('review','learning')) never populate any of these, and
-- commit_answer_transaction()'s existing explicit-column-list INSERT is
-- therefore completely unaffected (it never names any column below).
-- =========================================================================
alter table public.answer_events
  -- SELECTION: links this answer to the exact persisted scheduler
  -- decision that produced it (spec section 21). RESTRICT, not CASCADE/
  -- SET NULL: a selection trace is itself append-only historical fact
  -- (same RESTRICT convention this table already uses for every other
  -- reference to a durable/historical row) and must never be silently
  -- orphaned out from under an answer_event that cites it. Nullable:
  -- legacy rows have no trace at all, and this phase does not enforce
  -- NOT NULL even for v1 rows yet (spec section 21: "Do NOT enforce
  -- global NOT NULL now if legacy runtime cannot supply it" -- the
  -- eventual v1-only NOT NULL constraint is cutover-phase scope).
  add column selection_trace_id uuid
    references public.learning_engine_selection_traces (id) on delete restrict,

  -- SELECTION (observed): what the trusted scheduler decided for this
  -- card. Mirrors the same CHECK lists as
  -- learning_engine_selection_traces.source/selection_reason/
  -- scheduler_mode above -- kept as three separate statements (not a
  -- shared domain type) for the same reason Postgres CHECK constraints
  -- generally are: no cross-table DOMAIN indirection this schema does not
  -- already use elsewhere.
  add column source text
    check (source is null or source in ('ACTIVE', 'FSRS_DUE', 'NEAR_DUE', 'RANDOM_MASTERED')),
  add column selection_reason text
    check (selection_reason is null or selection_reason in (
      'repair_hard_cap',
      'critical_due_interrupt',
      'active_first_pass',
      'active_starvation',
      'repair_target',
      'spaced_confirmation',
      'active_weighted_selection',
      'due_weighted_selection',
      'near_due_weighted_selection',
      'random_mastered_shuffle_bag',
      'emergency_cooldown_relaxation',
      'no_card_all_unavailable'
    )),
  add column scheduler_mode text
    check (scheduler_mode is null or scheduler_mode in (
      'pre_goal_active_focus',
      'pre_goal_balanced',
      'pre_goal_review_pressure',
      'post_goal_active_focus',
      'post_goal_balanced',
      'post_goal_review_pressure',
      'post_mastery_pre_goal_active_focus',
      'post_mastery_pre_goal_balanced',
      'post_mastery_pre_goal_review_pressure',
      'post_mastery_post_goal_active_focus',
      'post_mastery_post_goal_balanced',
      'post_mastery_post_goal_review_pressure'
    )),

  -- BEHAVIOR: spec section 30's time_to_first_action_ms, nullable
  -- ("preserve... time to first action" section 32, but "nullable" per
  -- section 8 -- not every presentation surface can measure a distinct
  -- first-action moment from response_time_ms).
  add column time_to_first_action_ms integer
    check (time_to_first_action_ms is null or time_to_first_action_ms >= 0),

  -- CARD STATE: within-day learning_stage before/after (section 5.1 of
  -- the normative spec; user_card_progress.learning_stage, Phase 1). No
  -- existing answer_events equivalent -- card_status_before/after
  -- (widened above) already covers card_status; learning_stage is a
  -- genuinely separate, narrower concept Phase 1 deliberately kept out
  -- of card_status itself.
  add column learning_stage_before text
    check (learning_stage_before is null or learning_stage_before in ('FRESH', 'LEARNING_1', 'LEARNING_2')),
  add column learning_stage_after text
    check (learning_stage_after is null or learning_stage_after in ('FRESH', 'LEARNING_1', 'LEARNING_2')),

  -- CARD STATE: spec section 8 lists this once (not before/after-paired
  -- like the rows above it), immediately after card_status_after/
  -- learning_stage_after -- read as the value AS OF AFTER this event
  -- (mastery-granting, when it happens, happens on the very answer this
  -- row records). Mirrors user_card_progress.has_ever_been_mastered
  -- (Phase 1) at that same instant; never reset once true (invariant
  -- 34.1), so an "after" reading is also always a superset of "before".
  add column has_ever_been_mastered boolean,

  -- REPAIR CONTEXT (section 8/16): repair_pending_before,
  -- is_repair_retry, is_stage_advancing_success. Deliberately NOT adding
  -- repair_wrong_position_before/repair_target_position_before/
  -- repair_hard_cap_position_before per this phase's own section 16
  -- instruction ("audit before adding redundant columns... may already
  -- provide enough information") -- see this migration's header comment
  -- and the Phase 8 handoff report's "Repair-history preservation"
  -- section for the full reasoning: selection_reason (repair_target /
  -- repair_hard_cap / spaced_confirmation) + repair_pending_before +
  -- is_repair_retry + card_status_before/after + relearning_phase
  -- (reconstructable from the adjacent user_card_progress snapshot, not
  -- duplicated per-event) are sufficient to reconstruct "a Wrong that
  -- created repair -> retry -> repair Correct -> spaced confirmation ->
  -- restoration" from the answer_events stream alone.
  add column repair_pending_before boolean,
  add column is_repair_retry boolean,
  add column is_stage_advancing_success boolean,

  -- EXPOSURE CONTEXT (section 8/14): same_day_seen_count_before/
  -- same_day_wrong_count_before mirror user_card_progress's own Phase 1
  -- columns at answer time. cards_since_last_seen/seconds_since_last_seen
  -- are new v1-specific derived observations -- see the dedicated
  -- comment on seconds_since_last_seen below for why they are NOT the
  -- same column as the existing legacy card_seen_count_at_answer/
  -- time_since_last_seen (different counting semantics, not a
  -- duplicate).
  add column same_day_seen_count_before integer
    check (same_day_seen_count_before is null or same_day_seen_count_before >= 0),
  add column same_day_wrong_count_before integer
    check (same_day_wrong_count_before is null or same_day_wrong_count_before >= 0),
  add column cards_since_last_seen integer
    check (cards_since_last_seen is null or cards_since_last_seen >= 0),
  -- Deliberately NOT reusing the existing `time_since_last_seen bigint`
  -- column (milliseconds, legacy Learning-mode reappearance-floor
  -- semantics -- 20260927000000_learning_wrong_reappearance_floor.sql).
  -- This phase's brief section 14 explicitly requires "seconds_since_
  -- last_seen: prefer authoritative last_seen_at before mutation" as its
  -- own named field with its own unit (seconds); collapsing it onto the
  -- existing ms-unit legacy column would silently change that column's
  -- unit/meaning for every historical and future legacy row. Kept as a
  -- separate, explicitly-named v1 column instead (same resolution this
  -- phase's brief section 9 prescribes for the raw-vs-normalized source-
  -- weight ambiguity: do not collapse, add an explicitly-named sibling).
  add column seconds_since_last_seen bigint
    check (seconds_since_last_seen is null or seconds_since_last_seen >= 0),

  -- FSRS BEFORE/AFTER (section 8/12): D/S/R. No existing answer_events
  -- equivalent at all -- the legacy table only ever stored fsrs_rating/
  -- fsrs_due_before/fsrs_due_after (no stability/difficulty/
  -- retrievability snapshot). R is bounded [0,1] (a probability); D/S
  -- have no natural upper bound in ts-fsrs's own model, so only a
  -- non-negativity check is applied to those two.
  add column fsrs_d_before double precision
    check (fsrs_d_before is null or fsrs_d_before >= 0),
  add column fsrs_s_before double precision
    check (fsrs_s_before is null or fsrs_s_before >= 0),
  add column fsrs_r_before double precision
    check (fsrs_r_before is null or (fsrs_r_before >= 0 and fsrs_r_before <= 1)),
  add column fsrs_d_after double precision
    check (fsrs_d_after is null or fsrs_d_after >= 0),
  add column fsrs_s_after double precision
    check (fsrs_s_after is null or fsrs_s_after >= 0),
  add column fsrs_r_after double precision
    check (fsrs_r_after is null or (fsrs_r_after >= 0 and fsrs_r_after <= 1)),

  -- LONG-TERM TIMING (section 8/13): scheduled_interval_sec,
  -- interval_progress, days_overdue. Not reusing the existing
  -- `previous_review_interval integer` (legacy, undocumented unit/
  -- semantics tied to the old review-queue model) for the same
  -- do-not-silently-reinterpret-a-legacy-column reason as
  -- seconds_since_last_seen above. No upper-bound check on
  -- interval_progress/days_overdue: a card can be arbitrarily overdue
  -- (progress and days-overdue both grow unbounded above 1.0/0), so only
  -- non-negativity is enforced, per this phase's brief section 13 ("NULL
  -- is preferable to a fake zero" for events where the concept does not
  -- apply -- never an invented upper clamp either).
  add column scheduled_interval_sec integer
    check (scheduled_interval_sec is null or scheduled_interval_sec >= 0),
  add column interval_progress double precision
    check (interval_progress is null or interval_progress >= 0),
  add column days_overdue double precision
    check (days_overdue is null or days_overdue >= 0),

  -- MASTERY EVIDENCE BEFORE (section 8/15): mirrors
  -- user_card_progress.fsrs_review_correct_count/streak (Phase 1) at
  -- answer time, so a per-event snapshot survives independent of that
  -- row's current (mutable) value.
  add column fsrs_review_correct_count_before integer
    check (fsrs_review_correct_count_before is null or fsrs_review_correct_count_before >= 0),
  add column fsrs_review_correct_streak_before integer
    check (fsrs_review_correct_streak_before is null or fsrs_review_correct_streak_before >= 0),

  -- SOURCE WEIGHTS (section 8/9): per this phase's brief section 9's
  -- explicit resolution -- "If the existing answer_events minimum names
  -- (source_weight_active, source_weight_due, ...) need to remain for
  -- compatibility, document exactly whether those fields store
  -- normalized probabilities and add explicit _raw fields. Do not leave
  -- the meaning ambiguous." Decision: the bare names below
  -- (source_weight_active/due/near/random_mastered) store the
  -- NORMALIZED actual sampling probability (what the weighted draw
  -- really used, after empty-source renormalization) -- matching the
  -- normative spec section 30's bare field names most directly, since
  -- "the weight this card's source was actually drawn with" is the more
  -- immediately useful per-event quantity. The nominal/raw policy
  -- weights (before renormalization) are preserved separately as
  -- `_raw`-suffixed siblings, exactly as learning_engine_selection_traces
  -- already does. All nullable: these are only meaningful for an
  -- ordinary-mode source-weighted draw context, not every
  -- selection_reason populates them (e.g. repair_hard_cap does not).
  add column source_weight_active double precision
    check (source_weight_active is null or (source_weight_active >= 0 and source_weight_active <= 1)),
  add column source_weight_due double precision
    check (source_weight_due is null or (source_weight_due >= 0 and source_weight_due <= 1)),
  add column source_weight_near double precision
    check (source_weight_near is null or (source_weight_near >= 0 and source_weight_near <= 1)),
  add column source_weight_random_mastered double precision
    check (source_weight_random_mastered is null or (source_weight_random_mastered >= 0 and source_weight_random_mastered <= 1)),
  add column source_weight_active_raw double precision
    check (source_weight_active_raw is null or (source_weight_active_raw >= 0 and source_weight_active_raw <= 1)),
  add column source_weight_due_raw double precision
    check (source_weight_due_raw is null or (source_weight_due_raw >= 0 and source_weight_due_raw <= 1)),
  add column source_weight_near_raw double precision
    check (source_weight_near_raw is null or (source_weight_near_raw >= 0 and source_weight_near_raw <= 1)),
  add column source_weight_random_mastered_raw double precision
    check (source_weight_random_mastered_raw is null or (source_weight_random_mastered_raw >= 0 and source_weight_random_mastered_raw <= 1)),

  -- SELECTION CONTEXT (section 8/10): card_priority_weight (the weight
  -- the winning card itself was drawn with -- distinct from the
  -- source_weight_* columns above, which are the SOURCE-level weights),
  -- candidate_count (the candidate count for the selected source/path
  -- where meaningful -- per-source breakdowns live on
  -- learning_engine_selection_traces, not duplicated per-event here).
  add column card_priority_weight double precision
    check (card_priority_weight is null or card_priority_weight >= 0),
  add column candidate_count integer
    check (candidate_count is null or candidate_count >= 0),

  -- POLICY (section 8/28/29): every value active at decision time,
  -- preserved verbatim on the event row rather than ever reconstructed
  -- from "current policy" later.
  add column policy_version text,
  add column fsrs_version text,
  add column parameter_set_id text,
  -- EXPERIMENT (section 30): reserved, nullable, no experimentation
  -- infrastructure implemented in this phase (brief section 30: "NULL is
  -- valid... the field exists for future analysis").
  add column experiment_assignment_id text,

  -- GOAL STATE BEFORE ANSWER (section 8/25): kept deliberately separate,
  -- per this phase's brief section 25 ("Keep them separate... Daily
  -- Goal/streak-minimum timestamps"). daily_goal_complete_before already
  -- has a legacy-adjacent concept on sessions (daily_goal_completed) but
  -- no per-EVENT snapshot exists; streak_minimum_complete_before has no
  -- existing equivalent anywhere. Both nullable: this phase only adds
  -- storage, it does not change the live runtime's streak-minimum
  -- implementation (brief section 25: "If the live runtime does not yet
  -- implement the final streak-minimum rule, telemetry fields may remain
  -- unpopulated until cutover").
  add column daily_goal_complete_before boolean,
  add column streak_minimum_complete_before boolean;

create index answer_events_selection_trace_id_idx
  on public.answer_events (selection_trace_id)
  where selection_trace_id is not null;

create index answer_events_selection_reason_idx
  on public.answer_events (selection_reason)
  where selection_reason is not null;

create index answer_events_policy_version_idx
  on public.answer_events (policy_version)
  where policy_version is not null;

-- =========================================================================
-- sessions: new v1-only session-telemetry columns (spec section 31,
-- this phase's brief sections 23-25). All nullable or zero-defaulted
-- exactly like every other per-session counter this table already has
-- (enemies_defeated, critical_hits, etc.) -- no existing trusted function
-- names any of these in its explicit column list, so
-- start_or_resume_session()/commit_answer_transaction() are unaffected.
-- =========================================================================
alter table public.sessions
  -- "questions_answered"/"correct_answers"/"enemies_defeated" from
  -- section 23's list are NOT duplicated here: this table's existing
  -- total_answers/correct_answers/enemies_defeated already mean exactly
  -- that (brief section 41.1: reuse an existing equivalent rather than
  -- duplicate it).

  -- Kept deliberately separate from the existing daily_goal_completed
  -- boolean (brief section 25: "Keep them separate... distinguish
  -- streak_minimum_complete_before / daily_goal_complete_before and
  -- session timestamps for each"). Neither has an existing timestamp on
  -- this table today -- daily_goal_completed is boolean-only.
  add column streak_minimum_completed_at timestamptz,
  add column daily_goal_completed_at timestamptz,

  -- continued_after_daily_goal (existing boolean) already covers
  -- "continued_after_goal" from section 31's list one-for-one -- not
  -- duplicated. questions_after_goal/seconds_after_goal are new:
  -- daily_user_stats has an analogous `post_goal_answers` (per-DAY
  -- aggregate, 20260923172733_answer_and_analytics_tables.sql), but
  -- nothing per-SESSION exists yet, and section 31 asks for it on
  -- sessions specifically.
  add column questions_after_goal integer not null default 0
    check (questions_after_goal >= 0),
  add column seconds_after_goal integer
    check (seconds_after_goal is null or seconds_after_goal >= 0),

  -- voluntary_exit_position (section 24): the deck-global
  -- scheduler_position (Phase 6) at the moment the user chose to end --
  -- distinct from this table's existing session-LOCAL
  -- learning_draw_index (brief section 11: "Do not conflate
  -- session_position... scheduler_position... the latter does not reset
  -- between Sessions"). Nullable: unpopulated until a session actually
  -- ends via a future trusted write path that knows the current
  -- scheduler_position.
  add column voluntary_exit_position integer
    check (voluntary_exit_position is null or voluntary_exit_position >= 0),

  -- Active Pool / Due-count snapshots at session start/end (section 23).
  -- No existing equivalent -- user_card_progress/user_deck_learning_state
  -- hold CURRENT pool/due state, never a per-session start/end snapshot.
  add column active_pool_start integer
    check (active_pool_start is null or active_pool_start >= 0),
  add column active_pool_end integer
    check (active_pool_end is null or active_pool_end >= 0),
  add column due_count_start integer
    check (due_count_start is null or due_count_start >= 0),
  add column due_count_end integer
    check (due_count_end is null or due_count_end >= 0),

  -- Per-session counters of specific selection_reason occurrences
  -- (section 24's exact semantics: "count of actual repair retry
  -- presentations/answers", "count of selections whose reason is
  -- critical_due_interrupt", "...active_starvation" -- "Do not infer
  -- these from card status loosely"). Zero-defaulted like every other
  -- per-session counter on this table; a future trusted commit path
  -- increments them per matching answer_events.selection_reason, never
  -- reconstructs them from card_status.
  add column repair_events integer not null default 0
    check (repair_events >= 0),
  add column critical_due_interrupts integer not null default 0
    check (critical_due_interrupts >= 0),
  add column active_starvation_guarantees integer not null default 0
    check (active_starvation_guarantees >= 0),

  -- POLICY (section 23/29): the policy version in force for this
  -- session. Nullable: unpopulated for every legacy/pre-v1 session.
  add column policy_version text;
