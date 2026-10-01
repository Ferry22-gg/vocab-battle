-- Learning Engine v1 -- Phase 1: additive schema.
-- Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md (normative),
-- section 29 ("Data model requirements") and section 37 ("Phase 1 --
-- enums and schema"). This migration follows that document's explicit
-- instruction to "adapt names to the existing Supabase schema, but
-- preserve these semantics" -- it does not re-litigate names that already
-- exist with equivalent meaning (see the per-field notes below).
--
-- ---------------------------------------------------------------------
-- Scope and non-goals (per the implementation plan this migration was
-- commissioned under)
-- ---------------------------------------------------------------------
-- This migration is STRICTLY additive:
--   - no existing column is dropped, renamed, or narrowed;
--   - no existing CHECK constraint is narrowed (card_status's is widened
--     only -- see below -- which cannot reject any row that was valid
--     before);
--   - the legacy session_review_cards/session_learning_queue tables and
--     the two-mode commit_answer_transaction()/get_next_session_card()
--     RPCs are left completely untouched and continue to behave exactly
--     as before. Nothing added here is read or written by them.
--   - no new column here is ever written by any existing trusted function
--     (duplicate_starter_deck(), add_card_to_deck(),
--     commit_answer_transaction(), start_or_resume_session()) -- every
--     new user_card_progress column is nullable or has a default, so
--     those functions' existing explicit-column-list INSERT statements
--     (verified against both occurrences: duplicate_starter_deck() and
--     add_card_to_deck() in 20260923210000_tester_deck_card_write_paths.sql)
--     continue to work unmodified.
--
-- This migration deliberately does NOT implement:
--   - Active Pool admission/sizing logic (Phase 3);
--   - the repair scheduler's position/window math (Phase 4);
--   - FSRS wiring for the new engine (Phase 5);
--   - the unified source scheduler (Phase 6);
--   - Post-Mastery mode (Phase 7);
--   - telemetry/selection-trace fields on answer_events/sessions (Phase 8 --
--     deliberately out of scope here; see the Phase 1/2 handoff report for
--     why those fields are not added yet);
--   - any UI-facing change (Phase 9).
-- Those phases will populate/consume the columns and tables added here;
-- this migration only prepares storage for them.
--
-- ---------------------------------------------------------------------
-- Why additive new columns on user_card_progress, not a parallel table
-- ---------------------------------------------------------------------
-- Every new field below that has no pre-existing equivalent (learning_stage,
-- pool_status, relearning_phase, has_ever_been_mastered,
-- first_presented_at, same_day_seen_count, same_day_wrong_count,
-- same_day_progress_date, correct_cooldown_until_position, repair_pending,
-- repair_wrong_position, repair_target_position, repair_hard_cap_position,
-- active_draws_since_eligible, fsrs_review_correct_count,
-- fsrs_review_correct_streak) is added directly to user_card_progress
-- rather than a new side table: the spec (29.1) recommends exactly this
-- set as "per user-card state", and user_card_progress is already the
-- canonical one-row-per-(user_id, card_id) table (UNIQUE (user_id,
-- card_id), enforced since 20260922034033_learning_and_session_tables.sql)
-- that owns that grain. A side table would need the same unique key and
-- buy nothing but join overhead for every future scheduler read.
--
-- card_status itself is handled differently (widened in place, not
-- duplicated into a new column) -- see the dedicated comment block below.
--
-- ---------------------------------------------------------------------
-- Fields intentionally NOT duplicated (adapted to the existing schema,
-- per the spec's own instruction to do so)
-- ---------------------------------------------------------------------
--   spec field               -> existing equivalent reused as-is
--   fsrs_d                   -> user_card_progress.fsrs_difficulty
--   fsrs_s                   -> user_card_progress.fsrs_stability
--   fsrs_last_review_at      -> user_card_progress.fsrs_last_review_at
--   fsrs_due_at              -> user_card_progress.fsrs_due_at
--   fsrs_scheduled_interval_sec -> user_card_progress.fsrs_scheduled_days
--     (unit differs -- days, not seconds -- but the represented concept,
--     "FSRS's current scheduled interval", is identical; a future adapter
--     can convert, same as lib/learning/fsrs.ts already isolates the
--     deprecated-upstream elapsed_days field to one conversion point)
--   last_answer_at            -> user_card_progress.last_seen_at
--     (this application always answers a card immediately on display --
--     there is no persisted "shown but not yet answered" state anywhere
--     in the schema -- so "last seen" and "last answered" are the same
--     instant in every write path that exists today; commit_answer_
--     transaction() already sets last_seen_at = now() on every answer)
--   user_id, card_id           -> already primary join keys
--   created_at, updated_at     -> already present with the standard
--     set_updated_at trigger
--
-- deck_id is deliberately NOT duplicated onto user_card_progress either
-- (it is reachable via cards.deck_id, the same adaptation
-- get_next_session_card() and commit_answer_transaction() already rely
-- on throughout).
--
-- ---------------------------------------------------------------------
-- card_status: widen the CHECK constraint in place to add ACQUIRED
-- ---------------------------------------------------------------------
-- The spec's card_status enum (NEW/LEARNING/ACQUIRED/LEARNED/FORGOTTEN,
-- section 3.1) is a strict superset of the existing one
-- (NEW/LEARNING/LEARNED/FORGOTTEN). Widening the existing CHECK constraint
-- to allow 'ACQUIRED' is therefore purely additive: every row that
-- satisfied the old constraint still satisfies the new one, and no
-- existing trusted function (none of which ever assigns 'ACQUIRED') can
-- start emitting it by accident. This keeps the Learning Engine v1 and
-- legacy engine sharing the SAME card_status column during the review
-- window the implementation plan asked for, rather than forcing a second,
-- competing status column -- the simplest change that lets Phase 2's pure
-- functions (next migration/commit) express ACQUIRED without touching
-- cutover.
--
-- The exact system-generated constraint name is looked up dynamically
-- (rather than hard-coded as the conventional
-- "user_card_progress_card_status_check") so this migration cannot be
-- silently wrong about Postgres's default naming -- it fails loudly if no
-- matching constraint is found, instead of a DROP CONSTRAINT typo doing
-- nothing or erroring confusingly.
do $$
declare
  v_conname text;
begin
  select con.conname into v_conname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'user_card_progress'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%card_status%';

  if v_conname is null then
    raise exception 'learning_engine_v1_additive_schema: could not locate the existing card_status CHECK constraint on public.user_card_progress';
  end if;

  execute format('alter table public.user_card_progress drop constraint %I', v_conname);
end;
$$;

alter table public.user_card_progress
  add constraint user_card_progress_card_status_check
  check (card_status in ('NEW', 'LEARNING', 'ACQUIRED', 'LEARNED', 'FORGOTTEN'));

-- ---------------------------------------------------------------------
-- user_card_progress: new columns (spec section 29.1)
-- ---------------------------------------------------------------------
alter table public.user_card_progress
  -- Within-day acquisition stage (section 5.1). NULL for every card not
  -- currently in the LEARNING-stage acquisition process (NEW, ACQUIRED,
  -- LEARNED, or FORGOTTEN-but-not-yet-touched-by-the-new-engine).
  add column learning_stage text
    check (learning_stage is null or learning_stage in ('FRESH', 'LEARNING_1', 'LEARNING_2')),

  -- Pool/scheduler membership (section 6.2). NULL means "still in the NEW
  -- reservoir, not yet admitted to Active" -- the Active Pool admission
  -- logic that populates this is Phase 3, not this migration; every
  -- existing and newly-inserted row is left NULL here until that phase
  -- runs.
  add column pool_status text
    check (pool_status is null or pool_status in ('ACTIVE', 'OUTSIDE')),

  -- Relearning sub-phase (section 5.1's normalization: kept as a separate
  -- field from learning_stage specifically so the two acquisition-style
  -- enums never collide). NULL outside of an active relearning episode.
  add column relearning_phase text
    check (relearning_phase is null or relearning_phase in ('REPAIR_PENDING', 'SPACED_CONFIRMATION_PENDING')),

  -- Section 15.2 / 25.2 / 34.1: "LEARNED implies has_ever_been_mastered =
  -- true" and drives the previously-mastered short-restoration path.
  -- Reversible mastery (LEARNED -> FORGOTTEN) must never clear this flag.
  add column has_ever_been_mastered boolean not null default false,

  -- Section 3 "NEW" / invariant 34.1: "becomes LEARNING only when first
  -- presented" -- this timestamp is the authoritative record of that
  -- event, distinct from last_seen_at (which keeps advancing on every
  -- subsequent presentation). NULL until the card's first real
  -- presentation.
  add column first_presented_at timestamptz,

  -- Within-day exposure counters (sections 10-12), reset once per local
  -- calendar day by the future within-day engine (not by this migration
  -- or any trigger -- see same_day_progress_date below). Distinct from
  -- the existing lifetime seen_count/correct_streak/wrong_streak columns,
  -- which this migration does not touch or reinterpret.
  add column same_day_seen_count integer not null default 0
    check (same_day_seen_count >= 0),
  add column same_day_wrong_count integer not null default 0
    check (same_day_wrong_count >= 0),
  -- The local calendar day (Asia/Tokyo, matching daily_user_stats.stat_date
  -- and lib/learning/daily-goal-dal.ts's todayInTokyo()) same_day_* was
  -- last reset for. NULL means "never touched by the new engine yet".
  -- A future scheduler compares this against "today" before trusting
  -- same_day_seen_count/same_day_wrong_count, rather than relying on a
  -- cross-midnight DB trigger.
  add column same_day_progress_date date,

  -- Section 11.1 / 29.1: the session-position-based cooldown a normal
  -- stage-advancing Correct sets ("ineligible for the next 5 intervening
  -- cards"). The actual position arithmetic (what "5 intervening cards"
  -- resolves to, and how a position counter is defined across a
  -- voluntary-exit, no-hard-endpoint session) is Phase 3/6 scheduler
  -- work; this column only reserves the storage.
  add column correct_cooldown_until_position integer
    check (correct_cooldown_until_position is null or correct_cooldown_until_position >= 0),

  -- Section 12.1/29.1: whether this card currently owes a repair
  -- retrieval. Phase 2's pure Wrong/Repair-Correct transition functions
  -- set and clear this flag; the position fields below (when the repair
  -- must land, and its hard cap) are populated by Phase 4's repair
  -- scheduler, not by this migration or by Phase 2.
  add column repair_pending boolean not null default false,
  add column repair_wrong_position integer
    check (repair_wrong_position is null or repair_wrong_position >= 0),
  add column repair_target_position integer
    check (repair_target_position is null or repair_target_position >= 0),
  add column repair_hard_cap_position integer
    check (repair_hard_cap_position is null or repair_hard_cap_position >= 0),

  -- Section 19.1: Active-source draws survived since this card became
  -- eligible, feeding both the soft aging multiplier and the hard
  -- starvation guarantee. Phase 3/6 scope to maintain; reserved here.
  add column active_draws_since_eligible integer not null default 0
    check (active_draws_since_eligible >= 0),

  -- Section 15.1/34.3: cumulative "qualifying scheduled FSRS Correct"
  -- evidence, and its streak. Deliberately distinct from the existing
  -- correct_streak column (which the LEGACY engine increments on every
  -- correct answer regardless of source, and which this migration does
  -- not reinterpret) -- these new counters must only ever be incremented
  -- by the future engine's qualifying-FSRS-Correct transition, never by
  -- same-day Active Corrects, repair Corrects, Near-Due Corrects, or
  -- Random Mastered free-play Corrects (section 15).
  add column fsrs_review_correct_count integer not null default 0
    check (fsrs_review_correct_count >= 0),
  add column fsrs_review_correct_streak integer not null default 0
    check (fsrs_review_correct_streak >= 0);

-- Supports the future Active Pool's "which cards are currently ACTIVE"
-- scan (Phase 3+) and the repair scheduler's "which cards owe a repair"
-- scan (Phase 4+). Partial indexes: both predicates are selective (most
-- rows have pool_status IS NULL / repair_pending = false), so a full
-- (user_id, pool_status) index would mostly store NULL-valued entries no
-- query needs.
create index user_card_progress_user_id_pool_status_idx
  on public.user_card_progress (user_id, pool_status)
  where pool_status is not null;

create index user_card_progress_user_id_repair_pending_idx
  on public.user_card_progress (user_id)
  where repair_pending = true;

-- =========================================================================
-- user_learning_preferences (spec section 27, 29.3)
-- =========================================================================
-- One row per user, holding the "weak preference prior" onboarding
-- answers the spec's parameter-mapping rules (section 27) read. Audited
-- against the current onboarding flow (app/actions/onboarding.ts,
-- lib/onboarding/, app/onboarding/**) before writing this migration:
-- today onboarding only collects nickname + starter-deck selection and
-- sets profiles.onboarding_completed -- primary_goal, pain_point, and
-- exam_date are not captured or persisted anywhere yet. This table adds
-- the smallest schema support the spec requires (section 41's "add the
-- smallest schema support required" instruction) so Phase 5's desired-
-- retention wiring (section 14.3/27.2) has somewhere to read from; it
-- does not add onboarding UI or a write path -- every row starts (and, by
-- construction of there being no write path yet, stays) fully NULL until
-- a later phase adds the UI and a trusted write function. This is
-- intentional: see the Phase 1/2 handoff report for why a direct
-- authenticated write grant is not added here.
create table public.user_learning_preferences (
  user_id uuid primary key
    references public.profiles (id) on delete restrict,
  primary_goal text
    check (primary_goal is null or primary_goal in ('deadline_exam', 'habit', 'interest')),
  pain_point text
    check (pain_point is null or pain_point in ('retention_loss', 'creation_cost', 'boredom')),
  -- Section 27.1 / 35.5: "exam_date MUST be optional... must never break
  -- the program or scheduler." Nullable with no default, and no CHECK
  -- requiring primary_goal = 'deadline_exam' for it to be set -- the spec
  -- does not require that coupling, and inventing one here would be an
  -- unauthorized extra invariant.
  exam_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at
  before update on public.user_learning_preferences
  for each row
  execute function public.set_updated_at();

alter table public.user_learning_preferences enable row level security;

-- Trusted-state table, same design decision as every learning-state table
-- in grants_and_rls.sql (20260923180512_grants_and_rls.sql): authenticated
-- gets read-only access scoped by RLS; writes are reserved for a future
-- trusted SECURITY DEFINER function (not added in this phase), not a
-- direct authenticated UPDATE grant.
revoke all on table public.user_learning_preferences from anon, authenticated;
grant select on table public.user_learning_preferences to authenticated;

create policy user_learning_preferences_select_own_or_admin
  on public.user_learning_preferences
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- =========================================================================
-- user_deck_learning_state (spec section 29.2)
-- =========================================================================
-- Per (user, deck) Learning Engine state: Post-Mastery unlock, the
-- absolute Mastered count the spec asks to display (section 28.1), the
-- per-deck desired retention (section 14.3), the shuffle-bag state for
-- Phase 7's Random Mastered source, and the policy/parameter-set version
-- every answer under this deck is governed by (section 7, 30, 41.10). No
-- existing table owns deck-scoped learning state -- profiles.
-- selected_deck_id names only the user's single *currently selected*
-- deck, not a durable per-deck record -- so this is a genuinely new
-- table, not an adaptation of an existing one.
create table public.user_deck_learning_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references public.profiles (id) on delete restrict,
  deck_id uuid not null
    references public.decks (id) on delete restrict,

  -- Section 25.1/34.1: "never becomes false after first unlock." No
  -- application code enforces that monotonicity at the schema level (a
  -- CHECK constraint cannot see the previous row value) -- it must be
  -- enforced by whichever trusted function sets this column in a later
  -- phase (only ever by OR-ing in true, never assigning false outright).
  has_achieved_full_mastery boolean not null default false,
  mastered_count integer not null default 0
    check (mastered_count >= 0),

  -- Section 14.3/27.2: 0.90 default, 0.92 when the user's persisted
  -- pain_point = 'retention_loss'. Not derived automatically by a
  -- trigger on user_learning_preferences (that preference table has no
  -- write path yet either, per the comment above) -- Phase 5 is
  -- responsible for reading user_learning_preferences.pain_point and
  -- writing the resulting value here.
  desired_retention double precision not null default 0.90
    check (desired_retention > 0 and desired_retention < 1),

  -- Phase 7's Random Mastered shuffle-bag state (section 25.4). Opaque to
  -- every phase before 7; stored as jsonb per the spec's own "or
  -- deterministic equivalent" allowance rather than inventing a shape no
  -- consumer exists for yet.
  post_mastery_shuffle_bag_state jsonb,

  -- Section 7/30/41.10: every policy value must be versioned. Fixed
  -- default matches the spec's own recommended literal (section 7,
  -- "Recommended: policy_version = 'learning-engine-v1.0'").
  policy_version text not null default 'learning-engine-v1.0',
  -- Reserved for Phase 5's future FSRS parameter-set hierarchy (section
  -- 40: "Store parameter-set references at user/deck/model level"). No
  -- parameter-set concept exists yet anywhere in this codebase, so this
  -- is intentionally nullable with no foreign key target.
  parameter_set_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_deck_learning_state_user_id_deck_id_key unique (user_id, deck_id)
);

create trigger set_updated_at
  before update on public.user_deck_learning_state
  for each row
  execute function public.set_updated_at();

create index user_deck_learning_state_user_id_idx
  on public.user_deck_learning_state (user_id);

alter table public.user_deck_learning_state enable row level security;

-- Trusted-state table -- same design decision as user_learning_preferences
-- above and every other learning-state table.
revoke all on table public.user_deck_learning_state from anon, authenticated;
grant select on table public.user_deck_learning_state to authenticated;

create policy user_deck_learning_state_select_own_or_admin
  on public.user_deck_learning_state
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- =========================================================================
-- Compatibility / backfill (decision: preserve historical mastery without
-- pretending old cards satisfy the new v1 mastery-evidence thresholds)
-- =========================================================================

-- 1. Every card already LEARNED under the legacy (correct_streak >= 4 AND
--    seen_count >= 5) rule keeps card_status = 'LEARNED' as-is (untouched)
--    and is marked as having once satisfied mastery, so the previously-
--    mastered short-restoration path (section 25.2) is available to it
--    after a future lapse. fsrs_review_correct_count/streak are
--    deliberately NOT backfilled to any nonzero value -- they stay at
--    their column default of 0, because no historical data distinguishes
--    which of a card's past correct answers were "qualifying scheduled
--    FSRS reviews" under the NEW rule (most legacy reviews were same-day
--    Active/Learning-mode answers, which the v1 spec explicitly excludes
--    from this count, section 15). Pretending otherwise would fabricate
--    evidence this migration cannot actually derive.
update public.user_card_progress
set has_ever_been_mastered = true
where card_status = 'LEARNED'
  and has_ever_been_mastered = false;

-- 2. Backfill first_presented_at from real historical data (the earliest
--    answer_events row per user/card) rather than leaving it NULL for
--    cards that undeniably have been presented before. This is a
--    genuine derivation from existing append-only records, not a
--    fabricated value -- answer_events.answered_at already is the
--    authoritative record of every past presentation
--    (20260923172733_answer_and_analytics_tables.sql). Only fills rows
--    that are currently NULL; a non-NULL value is never overwritten.
update public.user_card_progress ucp
set first_presented_at = history.first_answered_at
from (
  select user_id, card_id, min(answered_at) as first_answered_at
  from public.answer_events
  group by user_id, card_id
) history
where history.user_id = ucp.user_id
  and history.card_id = ucp.card_id
  and ucp.first_presented_at is null;

-- 3. One user_deck_learning_state row per (user, deck) pair that already
--    has learner history, with mastered_count/has_achieved_full_mastery
--    computed from that history. desired_retention is left at its 0.90
--    default for every backfilled row: user_learning_preferences is
--    created empty by this same migration (no pain_point value could
--    possibly exist yet), so 0.92 can never apply at backfill time --
--    exactly the "otherwise use 0.90" instruction. Deleted cards
--    (cards.deleted_at is not null) are excluded from both the numerator
--    and denominator, so a soft-deleted card neither helps nor blocks a
--    deck's Full Mastery backfill value.
insert into public.user_deck_learning_state (
  user_id, deck_id, has_achieved_full_mastery, mastered_count, desired_retention, policy_version
)
select
  ucp.user_id,
  c.deck_id,
  count(*) filter (where ucp.card_status = 'LEARNED') = count(*) as has_achieved_full_mastery,
  count(*) filter (where ucp.card_status = 'LEARNED')::integer as mastered_count,
  0.90,
  'learning-engine-v1.0'
from public.user_card_progress ucp
join public.cards c on c.id = ucp.card_id
where c.deleted_at is null
group by ucp.user_id, c.deck_id
on conflict (user_id, deck_id) do nothing;

-- Deliberately NOT backfilled (documented, not silently skipped):
--   - learning_stage / pool_status / relearning_phase stay NULL for
--     every existing row, including already-LEARNING/FORGOTTEN ones.
--     Populating these now would mean guessing Active Pool membership
--     before Phase 3's admission logic (which defines what ACTIVE even
--     means under the new engine) exists at all -- Phase 3 populates
--     these when it first runs, not this migration.
--   - same_day_seen_count / same_day_wrong_count / same_day_progress_date
--     are left at 0/0/NULL for every row rather than reconstructed from
--     today's answer_events. This is a deliberate, low-stakes judgment
--     call: getting "today so far" exactly right requires the same
--     Asia/Tokyo day-boundary conversion daily_user_stats already uses,
--     and this migration has no live database to verify that conversion
--     against; the cost of being conservative here is at most one
--     slightly-stale same-day count on a card's next answer after
--     cutover, which every future same_day_progress_date check already
--     treats as "stale -> reset" by design.
