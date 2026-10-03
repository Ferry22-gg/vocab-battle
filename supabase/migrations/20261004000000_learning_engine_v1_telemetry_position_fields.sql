-- Learning Engine v1 -- Phase 8 corrective migration: answer_events
-- position fields.
--
-- Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 30
-- ("Behavioral event logging" -- "POSITION: session_position,
-- scheduler_position, scheduler_revision") and this phase's brief section
-- 11 ("Do not conflate session_position... with scheduler_position...
-- the latter does not reset between Sessions").
--
-- ---------------------------------------------------------------------
-- Why this migration exists (defect found during Phase 8 implementation)
-- ---------------------------------------------------------------------
-- The already-approved supabase/migrations/
-- 20261003000000_learning_engine_v1_telemetry.sql added `scheduler_
-- position`/`scheduler_revision` to `learning_engine_selection_traces`
-- only -- it never added `session_position`, `scheduler_position`, or
-- `scheduler_revision` to `answer_events` (confirmed directly: those
-- three names appear in that migration only on the trace table and in a
-- comment discussing the session_position-vs-scheduler_position
-- distinction, never as actual `answer_events` columns). Spec section 30
-- and this phase's brief section 9 both require the review event itself
-- to carry all three. This migration is the explicitly-approved forward-
-- only fix -- 20261003000000 is NOT modified by this file.
--
-- ---------------------------------------------------------------------
-- Scope (explicitly constrained by this phase's corrective-migration
-- brief)
-- ---------------------------------------------------------------------
-- Exactly three new nullable columns, each with only a non-negative
-- CHECK. No defaults, no backfill, no triggers, no indexes, no NOT NULL
-- constraint, no other schema change. Every existing `answer_events` row
-- (556 at last count) gets all three as NULL -- the only value the
-- column's own absence-of-default produces, which is also the semantically
-- correct answer for every legacy (`session_mode in ('review','learning')`)
-- row: none of them were ever produced by a Learning Engine v1 selection
-- decision, so neither a session-local position nor a scheduler position/
-- revision exists for them to record.
alter table public.answer_events
  -- Position within the current app Session (session-scoped; may restart
  -- in a later Session) -- distinct from scheduler_position below. No
  -- existing answer_events equivalent (the closest legacy concept,
  -- sessions.learning_draw_index, is a session-table counter, not a
  -- per-event column).
  add column session_position integer
    check (session_position is null or session_position >= 0),
  -- Deck-level Learning Engine scheduler_position (supabase/migrations/
  -- 20261002000000_learning_engine_v1_scheduler_position.sql) associated
  -- with the selection that produced this answer -- per-user-deck
  -- monotonic, never reset between Sessions. For a v1 answer linked to a
  -- selection_trace_id, this must equal that trace's own scheduler_position
  -- (enforced procedurally by the trusted insert function, not by a DB
  -- constraint -- consistent with every other cross-entity consistency
  -- rule in this schema, per the Phase 8 schema review's own finding on
  -- commit_answer_transaction()'s equivalent pattern).
  add column scheduler_position integer
    check (scheduler_position is null or scheduler_position >= 0),
  -- The scheduler_revision (same migration as scheduler_position above)
  -- associated with the scheduler snapshot that produced this selection --
  -- an optimistic-concurrency token, not a counter with product meaning
  -- of its own. Same linked-trace equality rule as scheduler_position.
  add column scheduler_revision integer
    check (scheduler_revision is null or scheduler_revision >= 0);
