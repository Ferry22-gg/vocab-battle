/**
 * Learning Engine v1 -- session telemetry helpers (Phase 8, remaining
 * scope after the Phase 8 schema review).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 31
 * ("Session logging") and this phase's brief sections 23-26, against the
 * approved migration's additive `sessions` columns (supabase/migrations/
 * 20261003000000_learning_engine_v1_telemetry.sql, schema review: APPROVE
 * AS-IS).
 *
 * Pure throughout: no DB access, no `Date.now()` (every timestamp is a
 * caller-supplied `Date`), no mutation of input. This module only
 * computes WHAT a trusted write path should persist -- it never writes
 * anything itself (section 26 of this phase's brief: "Keep these pure
 * where possible. No live wiring yet").
 *
 * ---------------------------------------------------------------------
 * Not duplicated (section 24/41.1 of this phase's brief: "reuse an
 * existing equivalent rather than duplicate it")
 * ---------------------------------------------------------------------
 * `sessions.total_answers`/`correct_answers`/`enemies_defeated`/
 * `continued_after_daily_goal` already exist (pre-v1, confirmed against
 * supabase/migrations/20260922034033_learning_and_session_tables.sql) and
 * already mean exactly "questions_answered"/"correct_answers"/
 * "enemies_defeated"/"continued_after_goal" from spec section 31's list --
 * this module has no equivalent for any of those four. It only covers the
 * genuinely NEW Phase 8 columns.
 *
 * ---------------------------------------------------------------------
 * No separate streak-minimum concept (policy-alignment correction before
 * Phase 9)
 * ---------------------------------------------------------------------
 * v1 has no separate streak-minimum threshold -- a day counts toward the
 * streak only when Daily Goal is completed (spec section 26). There is
 * therefore no `streakMinimumCompletedAt`/`applyStreakMinimumCompletion`
 * here: `dailyGoalCompletedAt`/`applyDailyGoalCompletion` above ARE the
 * streak-day qualification event, not a separate one to track alongside.
 */

import type { SelectionReason } from "@/lib/learning-engine/scheduler/next-card";

/** One-to-one with the approved migration's additive `sessions` v1 columns (camelCase mirror). `null` means "not yet reached/recorded" for every timestamp/position field. */
export interface SessionTelemetryState {
  readonly dailyGoalCompletedAt: Date | null;
  readonly questionsAfterGoal: number;
  readonly voluntaryExitPosition: number | null;
  readonly activePoolStart: number | null;
  readonly activePoolEnd: number | null;
  readonly dueCountStart: number | null;
  readonly dueCountEnd: number | null;
  readonly repairEvents: number;
  readonly criticalDueInterrupts: number;
  readonly activeStarvationGuarantees: number;
  readonly policyVersion: string | null;
}

/** The state every session starts in: every counter at 0, every timestamp/position null, matching the approved migration's own column defaults/nullability. */
export const INITIAL_SESSION_TELEMETRY_STATE: SessionTelemetryState = {
  dailyGoalCompletedAt: null,
  questionsAfterGoal: 0,
  voluntaryExitPosition: null,
  activePoolStart: null,
  activePoolEnd: null,
  dueCountStart: null,
  dueCountEnd: null,
  repairEvents: 0,
  criticalDueInterrupts: 0,
  activeStarvationGuarantees: 0,
  policyVersion: null,
};

export interface SessionStartSnapshot {
  readonly activePoolSize: number;
  readonly dueCount: number;
  readonly policyVersion: string;
}

/** Section 23: the start-of-session snapshot fields. Composes onto `INITIAL_SESSION_TELEMETRY_STATE`, never constructed standalone, so every other field keeps its documented starting value. */
export function buildSessionStartTelemetry(snapshot: SessionStartSnapshot): SessionTelemetryState {
  return {
    ...INITIAL_SESSION_TELEMETRY_STATE,
    activePoolStart: snapshot.activePoolSize,
    dueCountStart: snapshot.dueCount,
    policyVersion: snapshot.policyVersion,
  };
}

export interface CommittedAnswerTelemetryInput {
  readonly selectionReason: SelectionReason;
  /** From review-event.ts's buildReviewEvent output -- the same derived fact, not re-derived here. */
  readonly isRepairRetry: boolean;
  /** The value THIS answer's review event recorded for daily_goal_complete_before -- i.e. the pre-update value, so the answer that CROSSES the goal does not itself count as post-goal (same convention as commit_answer_transaction()'s own v_post_goal_answer). */
  readonly dailyGoalCompleteBeforeThisAnswer: boolean | null;
}

/**
 * Section 24: increments the four per-answer counters this phase adds.
 * One committed answer -> at most one increment per counter (an answer is
 * never, for example, both a repair retry AND a critical-due interrupt --
 * `selectionReason` is a single value -- so these never double-count a
 * single event against two counters that are mutually exclusive by
 * construction).
 */
export function applyCommittedAnswerToSessionTelemetry(
  state: SessionTelemetryState,
  input: CommittedAnswerTelemetryInput,
): SessionTelemetryState {
  return {
    ...state,
    questionsAfterGoal: state.questionsAfterGoal + (input.dailyGoalCompleteBeforeThisAnswer ? 1 : 0),
    repairEvents: state.repairEvents + (input.isRepairRetry ? 1 : 0),
    criticalDueInterrupts: state.criticalDueInterrupts + (input.selectionReason === "critical_due_interrupt" ? 1 : 0),
    activeStarvationGuarantees:
      state.activeStarvationGuarantees + (input.selectionReason === "active_starvation" ? 1 : 0),
  };
}

/** Section 24/25: records the Daily Goal completion instant. Idempotent -- a second call after it is already set never overwrites the first (monotonic: completion happens exactly once per session, by construction of "goal complete" being a one-way transition). */
export function applyDailyGoalCompletion(state: SessionTelemetryState, completedAt: Date): SessionTelemetryState {
  if (state.dailyGoalCompletedAt !== null) {
    return state;
  }
  return { ...state, dailyGoalCompletedAt: completedAt };
}

export interface SessionEndSnapshot {
  readonly activePoolSize: number;
  readonly dueCount: number;
  /** The scheduler_position at which the user chose to end -- null for a non-voluntary end (e.g. timeout/error), matching `end_reason`'s own existing nullability pattern on `sessions`. */
  readonly voluntaryExitPosition: number | null;
}

/** Section 23/24: the end-of-session snapshot fields. */
export function buildSessionEndTelemetry(state: SessionTelemetryState, snapshot: SessionEndSnapshot): SessionTelemetryState {
  return {
    ...state,
    activePoolEnd: snapshot.activePoolSize,
    dueCountEnd: snapshot.dueCount,
    voluntaryExitPosition: snapshot.voluntaryExitPosition,
  };
}

/**
 * Section 24: "wall-clock seconds from goal completion until session end
 * or last relevant event, using trusted timestamps." Computed on demand
 * from the two trusted timestamps already recorded, rather than
 * maintained as a running counter incremented on every answer -- a plain
 * subtraction of two instants cannot drift the way an accumulator could.
 * Null before the Daily Goal has been completed at all (the concept does
 * not yet apply -- never a fabricated 0).
 */
export function deriveSecondsAfterGoal(state: SessionTelemetryState, asOf: Date): number | null {
  if (state.dailyGoalCompletedAt === null) {
    return null;
  }
  return Math.max(0, Math.round((asOf.getTime() - state.dailyGoalCompletedAt.getTime()) / 1000));
}
