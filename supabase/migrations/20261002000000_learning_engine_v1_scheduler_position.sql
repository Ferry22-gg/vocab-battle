-- Learning Engine v1 -- Phase 6 (scheduler) additive schema.
-- Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 22.2
-- ("Critical Due"), plus the explicit architecture decisions made for
-- Phase 6's "read -> decide -> commit" design (not literally quoted in
-- the spec document, since position/revision are an implementation
-- mechanism the spec leaves to "application/session logic", section
-- 4.4-style).
--
-- Strictly additive, same discipline as
-- 20261001000000_learning_engine_v1_additive_schema.sql: no existing
-- column/constraint is touched, nothing here is read or written by any
-- legacy trusted function, and user_deck_learning_state keeps its
-- existing RLS policy and SELECT-only grant to authenticated (adding
-- columns to an already-RLS-enabled, already-granted table needs no new
-- grant statements -- the existing `grant select on table ... to
-- authenticated` already covers every column, present and future).
--
-- ---------------------------------------------------------------------
-- scheduler_position (per-user-deck monotonic draw counter)
-- ---------------------------------------------------------------------
-- Phase 6 architecture decision: one position step = one successfully
-- committed answered question, counted per (user, deck) and never reset
-- between sessions -- not the legacy, session-scoped, learning-mode-only
-- sessions.learning_draw_index (which Phase 6 does not read or write;
-- see this migration's header and the Phase 6 architecture plan for why
-- that counter is insufficient for a continuous, no-hard-endpoint v1
-- stream that mixes sources on every draw, not just "learning mode"
-- draws).
--
-- This is the SAME "position" every lib/learning-engine/* pure function
-- written so far already takes as an opaque integer parameter
-- (active-priority.ts's isEligibleForNormalSelection/
-- applyCorrectCooldown, repair-scheduler.ts's createRepairObligation/
-- isRepairTargetReached/isRepairHardCapReached) -- those functions never
-- assumed where the counter lives or how it resets; this column is where
-- it now canonically lives for Phase 6 onward. No existing Phase 1-5 pure
-- function needs to change for this.
--
-- integer (not bigint), matching every existing per-card position column
-- this will be compared against (user_card_progress.
-- correct_cooldown_until_position/repair_target_position/
-- repair_hard_cap_position, all integer) -- a type mismatch between the
-- authoritative counter and the position references compared against it
-- would be a real bug waiting to happen, and integer's ~2.1 billion
-- ceiling is not a practical concern for a per-deck draw counter.
alter table public.user_deck_learning_state
  add column scheduler_position integer not null default 0
    check (scheduler_position >= 0);

-- ---------------------------------------------------------------------
-- last_critical_due_position (section 22.2's 5-global-question guarantee)
-- ---------------------------------------------------------------------
-- NULL until the first time a Critical Due card is ever force-selected
-- for this (user, deck) -- "no Critical Due card has appeared" is then
-- vacuously true. Once set, section 22.2's "no Critical Due card has
-- been presented in the last 5 global questions" becomes the EXACT
-- (not approximated) comparison, evaluated against the PERSISTED
-- scheduler_position (the most recently committed question, not a
-- pre-incremented "next" value):
-- `scheduler_position - last_critical_due_position >= 5` for the NEXT
-- question to be eligible to force again -- NOT `>= 6` (a review caught
-- and corrected exactly this off-by-one: scheduler_position = P+5 must
-- already be the eligible case, since the 5 most recently completed
-- questions at that point, P+1..P+5, no longer include P). See
-- lib/learning-engine/scheduler/position.ts's
-- hasCriticalDueAppearedRecently and its boundary tests for the full
-- worked proof. A single position column is sufficient for this --
-- no ring buffer of the last N selection reasons is needed, since the
-- guarantee only ever needs to compare against the MOST RECENT
-- occurrence.
--
-- Constrained to never exceed scheduler_position: a Critical Due
-- selection is only ever recorded for the position it was JUST selected
-- at, in the same commit that advances scheduler_position for that same
-- draw -- so last_critical_due_position can never legitimately be in the
-- future relative to the deck's current position.
alter table public.user_deck_learning_state
  add column last_critical_due_position integer
    check (last_critical_due_position is null or last_critical_due_position >= 0),
  add constraint user_deck_learning_state_critical_due_not_future_check
    check (last_critical_due_position is null or last_critical_due_position <= scheduler_position);

-- ---------------------------------------------------------------------
-- scheduler_revision (optimistic-concurrency token for the deck-wide
-- scheduler snapshot)
-- ---------------------------------------------------------------------
-- Phase 6 architecture decision: distinct from, and in addition to, the
-- existing per-row p_expected_* staleness pattern
-- commit_answer_transaction() already uses (which only proves one card's
-- row is unchanged). A scheduler DECISION is computed from a read over
-- the ENTIRE deck's card set plus deck-level state -- a card the
-- decision did not select could change in a way that invalidates the
-- decision itself (e.g. a different card's repair hard cap was reached
-- moments after the snapshot was read, which should have forced a
-- different pick) even though the SELECTED card's own row is still
-- individually unchanged. scheduler_revision exists to catch exactly
-- that: every scheduler-relevant committed mutation for this (user,
-- deck) must increment it, a scheduler snapshot captures its value at
-- read time, and the eventual trusted selection/commit path (a later
-- phase -- not built by Phase 6A/6B, which stays pure/isolated) must
-- reject a decision computed against a stale revision and force a
-- re-run of scheduling, rather than trusting that the one card submitted
-- happens to still be individually eligible.
--
-- No trigger is added here to auto-increment this column: not every
-- update to this row is necessarily "scheduler-relevant" (e.g. a future
-- admin correction to policy_version), so blanket-incrementing on every
-- UPDATE would overcount. Incrementing it correctly is the responsibility
-- of whichever later phase builds the actual trusted write path that
-- mutates scheduler-relevant state -- reserved here, not enforced yet.
alter table public.user_deck_learning_state
  add column scheduler_revision integer not null default 0
    check (scheduler_revision >= 0);
