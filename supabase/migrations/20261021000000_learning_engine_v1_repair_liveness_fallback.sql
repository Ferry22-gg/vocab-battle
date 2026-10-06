-- Learning Engine v1 -- RC-F small-deck audit follow-up: the Repair
-- liveness fallback.
--
-- Forward-only, strictly additive. Does NOT edit
-- 20261003000000_learning_engine_v1_telemetry.sql (already applied) in
-- place -- that migration's own header explicitly anticipated this:
-- "Both CHECK lists mirror lib/learning-engine/scheduler/next-card.ts's
-- NextCardSource/SelectionReason unions exactly as of Phase 6E/7... update
-- this CHECK by hand if that union ever changes." The TypeScript union is
-- authoritative; this migration brings both DB-side mirrors back in sync
-- with it after adding one new SelectionReason member,
-- 'emergency_repair_relaxation'.
--
-- ---------------------------------------------------------------------
-- What changed and why (RC-F read-only audit, then an explicitly
-- approved product-policy decision to fix it)
-- ---------------------------------------------------------------------
-- scheduler_position only ever advances via a committed answer
-- (commit_learning_engine_v1_answer()), and a committed answer requires a
-- selectable card. If every live card in a deck is simultaneously
-- governed by a repair/relearning obligation and none has reached its own
-- normal gate yet (repair target, or the Spaced Confirmation cooldown
-- gate), and no Due/Near-Due candidate exists either,
-- chooseNextCard() correctly, safely returned 'no_card_all_unavailable' --
-- but that is a true fixed point: nothing can ever make scheduler_position
-- advance past it, so the deck is permanently stuck. Reachable for small
-- decks (at or below the ~6-card Fresh/first-pass batch size) through
-- entirely ordinary play (several brand-new cards answered Wrong in a
-- row, before any individual repair's sampled target arrives).
--
-- The fix (lib/learning-engine/repair-scheduler.ts's
-- selectRepairLivenessCandidate, called from
-- lib/learning-engine/scheduler/next-card.ts) is a distinct, last-resort
-- fallback: when the EXISTING ordinary-cooldown emergency fallback
-- (emergency_cooldown_relaxation, which deliberately never considers a
-- governed card) ALSO finds nothing, release the one Repair/relearning-
-- governed card whose own normal gate is soonest, one answer early. This
-- never changes WRONG_RETRY_MIN_GAP/WRONG_RETRY_HARD_CAP, never relaxes
-- Repair spacing broadly, and never fires while any ordinary or
-- ordinary-cooldown-relaxable candidate exists.
--
-- This migration only widens the two existing CHECK constraints that
-- enumerate SelectionReason string values to admit the one new value --
-- no table/column/function changes, no data migration.
alter table public.learning_engine_selection_traces
  drop constraint learning_engine_selection_traces_selection_reason_check,
  add constraint learning_engine_selection_traces_selection_reason_check
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
      'emergency_repair_relaxation',
      'no_card_all_unavailable'
    ));

alter table public.answer_events
  drop constraint answer_events_selection_reason_check,
  add constraint answer_events_selection_reason_check
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
      'emergency_repair_relaxation',
      'no_card_all_unavailable'
    ));
