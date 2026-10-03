import "server-only";

/**
 * Learning Engine v1 -- trusted persistence DAL for telemetry (Phase 8,
 * remaining scope after the Phase 8 schema review).
 *
 * Narrowest possible trusted TypeScript boundary around the two Phase 8
 * RPCs (supabase/migrations/20261005000000_learning_engine_v1_telemetry_functions.sql):
 * `insert_learning_engine_selection_trace` and
 * `insert_learning_engine_review_event`. Mirrors lib/learning/commit-answer.ts's
 * own documented contract exactly:
 *
 * This module performs NO calculation. It never infers a value, never
 * runs FSRS, never decides a scheduler outcome, never derives a telemetry
 * field. Every argument it forwards was already computed by
 * lib/learning-engine/telemetry/selection-trace.ts's `serializeSelectionTrace`
 * or lib/learning-engine/telemetry/review-event.ts's `buildReviewEvent`
 * (both pure). This module's only job is to shape that payload into the
 * RPC's parameter names and call it via the service-role client.
 *
 * Uses ONLY getServiceRoleClient() (lib/supabase/service-role.ts) -- never
 * the authenticated cookie client (neither RPC has any grant for
 * `authenticated` at all, per the migration's own revoke/grant
 * statements) and never a separately constructed privileged client.
 *
 * Not called from any live application code path in this phase (this
 * phase's brief section 10/35/45) -- only from tests and, in a future
 * runtime-cutover phase, trusted orchestration.
 */

import { getServiceRoleClient } from "@/lib/supabase/service-role";
import type { SelectionTracePersistencePayload } from "@/lib/learning-engine/telemetry/selection-trace";
import type { ReviewEventPersistencePayload } from "@/lib/learning-engine/telemetry/review-event";

const INSERT_SELECTION_TRACE_RPC = "insert_learning_engine_selection_trace";
const INSERT_REVIEW_EVENT_RPC = "insert_learning_engine_review_event";

/**
 * Preserves the Postgres SQLSTATE as a first-class field, same pattern as
 * lib/learning/commit-answer.ts's `CommitAnswerTransactionError` --
 * callers can branch on `code` (e.g. '42501' for a cross-entity
 * consistency rejection, '23505' for a duplicate trace id or a trace
 * already linked to a different answer event) without parsing message
 * text. `cause` carries the raw driver error for server-side diagnostics
 * only -- never surface it to a browser-facing response.
 */
export class LearningEngineTelemetryError extends Error {
  readonly code: string | undefined;

  constructor(message: string, options: { code?: string; cause: unknown }) {
    super(message, { cause: options.cause });
    this.name = "LearningEngineTelemetryError";
    this.code = options.code;
  }
}

// =============================================================================
// Selection trace
// =============================================================================

function toSelectionTraceRpcParams(payload: SelectionTracePersistencePayload): Record<string, unknown> {
  return {
    p_id: payload.id,
    p_user_id: payload.userId,
    p_deck_id: payload.deckId,
    p_card_id: payload.cardId,
    p_session_id: payload.sessionId,
    p_occurred_at: payload.occurredAt,

    p_scheduler_position: payload.schedulerPosition,
    p_scheduler_revision: payload.schedulerRevision,

    p_source: payload.source,
    p_selection_reason: payload.selectionReason,
    p_scheduler_mode: payload.schedulerMode,

    p_due_count: payload.dueCount,
    p_daily_goal_complete_before: payload.dailyGoalCompleteBefore,

    p_candidate_count_active: payload.candidateCountActive,
    p_candidate_count_due: payload.candidateCountDue,
    p_candidate_count_near: payload.candidateCountNear,
    p_candidate_count_random_mastered: payload.candidateCountRandomMastered,

    p_source_weight_active_raw: payload.sourceWeightActiveRaw,
    p_source_weight_due_raw: payload.sourceWeightDueRaw,
    p_source_weight_near_raw: payload.sourceWeightNearRaw,
    p_source_weight_random_mastered_raw: payload.sourceWeightRandomMasteredRaw,
    p_source_weight_active_normalized: payload.sourceWeightActiveNormalized,
    p_source_weight_due_normalized: payload.sourceWeightDueNormalized,
    p_source_weight_near_normalized: payload.sourceWeightNearNormalized,
    p_source_weight_random_mastered_normalized: payload.sourceWeightRandomMasteredNormalized,

    p_card_priority_weight: payload.cardPriorityWeight,
    p_retrievability: payload.retrievability,
    p_interval_progress: payload.intervalProgress,

    p_admitted_card_ids: payload.admittedCardIds,
    p_first_pass_queue_before: payload.firstPassQueueBefore,
    p_first_pass_queue_after: payload.firstPassQueueAfter,
    p_post_mastery_shuffle_bag_before: payload.postMasteryShuffleBagBefore,
    p_post_mastery_shuffle_bag_after: payload.postMasteryShuffleBagAfter,

    p_emergency_fallback_applied: payload.emergencyFallbackApplied,
    p_random_draws: payload.randomDraws,

    p_policy_version: payload.policyVersion,
    p_trace_payload: payload.tracePayload,
  };
}

/** One-to-one with `learning_engine_selection_traces`'s own columns (the RPC's `returning *`), snake_case as Postgres returns them. */
export interface PersistedSelectionTraceRow {
  readonly id: string;
  readonly user_id: string;
  readonly deck_id: string;
  readonly card_id: string | null;
  readonly session_id: string;
  readonly occurred_at: string;
  readonly scheduler_position: number;
  readonly scheduler_revision: number;
  readonly source: string | null;
  readonly selection_reason: string;
  readonly scheduler_mode: string;
  readonly due_count: number;
  readonly daily_goal_complete_before: boolean;
  readonly candidate_count_active: number;
  readonly candidate_count_due: number;
  readonly candidate_count_near: number;
  readonly candidate_count_random_mastered: number;
  readonly source_weight_active_raw: number;
  readonly source_weight_due_raw: number;
  readonly source_weight_near_raw: number;
  readonly source_weight_random_mastered_raw: number;
  readonly source_weight_active_normalized: number;
  readonly source_weight_due_normalized: number;
  readonly source_weight_near_normalized: number;
  readonly source_weight_random_mastered_normalized: number;
  readonly card_priority_weight: number | null;
  readonly retrievability: number | null;
  readonly interval_progress: number | null;
  readonly admitted_card_ids: readonly string[];
  readonly first_pass_queue_before: readonly string[] | null;
  readonly first_pass_queue_after: readonly string[] | null;
  readonly post_mastery_shuffle_bag_before: readonly string[] | null;
  readonly post_mastery_shuffle_bag_after: readonly string[] | null;
  readonly emergency_fallback_applied: boolean;
  readonly random_draws: readonly number[];
  readonly policy_version: string;
  readonly trace_payload: Record<string, unknown>;
  readonly created_at: string;
}

/**
 * Calls `insert_learning_engine_selection_trace` with one already-
 * serialized payload via the service-role client. Throws
 * `LearningEngineTelemetryError` (never a raw Supabase error) on any
 * rejection -- including a cross-entity mismatch (42501) or a duplicate
 * trace id (23505, append-only: see this phase's brief section 22).
 */
export async function persistSelectionTrace(
  payload: SelectionTracePersistencePayload,
): Promise<PersistedSelectionTraceRow> {
  const supabase = getServiceRoleClient();

  const { data, error } = await supabase.rpc(INSERT_SELECTION_TRACE_RPC, toSelectionTraceRpcParams(payload));

  if (error) {
    throw new LearningEngineTelemetryError(`${INSERT_SELECTION_TRACE_RPC} RPC call failed`, {
      code: error.code,
      cause: error,
    });
  }

  return data as PersistedSelectionTraceRow;
}

// =============================================================================
// Review event
// =============================================================================

function toReviewEventRpcParams(payload: ReviewEventPersistencePayload): Record<string, unknown> {
  return {
    p_client_event_id: payload.clientEventId,
    p_user_id: payload.userId,
    p_deck_id: payload.deckId,
    p_card_id: payload.cardId,
    p_session_id: payload.sessionId,
    p_occurred_at: payload.occurredAt,

    // p_session_position has no cross-check against live session state,
    // unlike p_scheduler_position/p_scheduler_revision below (verified
    // against the linked trace by the RPC itself) -- see
    // lib/learning-engine/telemetry/review-event.ts's
    // ReviewEventPosition doc comment ("RUNTIME-CUTOVER ACCEPTANCE
    // REQUIREMENT") for the future obligation this leaves open.
    p_session_position: payload.sessionPosition,
    p_scheduler_position: payload.schedulerPosition,
    p_scheduler_revision: payload.schedulerRevision,

    p_correct: payload.correct,
    p_response_time_ms: payload.responseTimeMs,
    p_time_to_first_action_ms: payload.timeToFirstActionMs,

    p_selection_trace_id: payload.selectionTraceId,
    p_source: payload.source,
    p_selection_reason: payload.selectionReason,
    p_scheduler_mode: payload.schedulerMode,

    p_daily_goal_complete_before: payload.dailyGoalCompleteBefore,
    p_streak_minimum_complete_before: payload.streakMinimumCompleteBefore,

    p_card_status_before: payload.cardStatusBefore,
    p_learning_stage_before: payload.learningStageBefore,
    p_card_status_after: payload.cardStatusAfter,
    p_learning_stage_after: payload.learningStageAfter,
    p_has_ever_been_mastered: payload.hasEverBeenMastered,

    p_same_day_seen_count_before: payload.sameDaySeenCountBefore,
    p_same_day_wrong_count_before: payload.sameDayWrongCountBefore,
    p_cards_since_last_seen: payload.cardsSinceLastSeen,
    p_seconds_since_last_seen: payload.secondsSinceLastSeen,

    p_repair_pending_before: payload.repairPendingBefore,
    p_is_repair_retry: payload.isRepairRetry,
    p_is_stage_advancing_success: payload.isStageAdvancingSuccess,

    p_fsrs_d_before: payload.fsrsDBefore,
    p_fsrs_s_before: payload.fsrsSBefore,
    p_fsrs_r_before: payload.fsrsRBefore,
    p_fsrs_d_after: payload.fsrsDAfter,
    p_fsrs_s_after: payload.fsrsSAfter,
    p_fsrs_r_after: payload.fsrsRAfter,

    p_scheduled_interval_sec: payload.scheduledIntervalSec,
    p_interval_progress: payload.intervalProgress,
    p_days_overdue: payload.daysOverdue,

    p_fsrs_review_correct_count_before: payload.fsrsReviewCorrectCountBefore,
    p_fsrs_review_correct_streak_before: payload.fsrsReviewCorrectStreakBefore,

    p_source_weight_active: payload.sourceWeightActive,
    p_source_weight_due: payload.sourceWeightDue,
    p_source_weight_near: payload.sourceWeightNear,
    p_source_weight_random_mastered: payload.sourceWeightRandomMastered,
    p_source_weight_active_raw: payload.sourceWeightActiveRaw,
    p_source_weight_due_raw: payload.sourceWeightDueRaw,
    p_source_weight_near_raw: payload.sourceWeightNearRaw,
    p_source_weight_random_mastered_raw: payload.sourceWeightRandomMasteredRaw,

    p_card_priority_weight: payload.cardPriorityWeight,
    p_candidate_count: payload.candidateCount,

    p_policy_version: payload.policyVersion,
    p_fsrs_version: payload.fsrsVersion,
    p_parameter_set_id: payload.parameterSetId,
    p_experiment_assignment_id: payload.experimentAssignmentId,
  };
}

/** One-to-one with `answer_events`'s own columns (the RPC's `returning *`), snake_case as Postgres returns them. Legacy-shaped columns this phase's builder never populates (base_damage, fsrs_rating, etc.) are included for completeness since `returning *` always includes every column. */
export interface PersistedReviewEventRow {
  readonly id: string;
  readonly client_event_id: string;
  readonly user_id: string;
  readonly card_id: string;
  readonly deck_id: string;
  readonly session_id: string;
  readonly answered_at: string;
  readonly correct: boolean;
  readonly response_time_ms: number;
  readonly session_mode: string;
  readonly card_status_before: string;
  readonly card_status_after: string;
  readonly session_position: number | null;
  readonly scheduler_position: number | null;
  readonly scheduler_revision: number | null;
  readonly selection_trace_id: string | null;
  readonly source: string | null;
  readonly selection_reason: string | null;
  readonly scheduler_mode: string | null;
  readonly learning_stage_before: string | null;
  readonly learning_stage_after: string | null;
  readonly has_ever_been_mastered: boolean | null;
  readonly same_day_seen_count_before: number | null;
  readonly same_day_wrong_count_before: number | null;
  readonly cards_since_last_seen: number | null;
  readonly seconds_since_last_seen: number | null;
  readonly repair_pending_before: boolean | null;
  readonly is_repair_retry: boolean | null;
  readonly is_stage_advancing_success: boolean | null;
  readonly fsrs_d_before: number | null;
  readonly fsrs_s_before: number | null;
  readonly fsrs_r_before: number | null;
  readonly fsrs_d_after: number | null;
  readonly fsrs_s_after: number | null;
  readonly fsrs_r_after: number | null;
  readonly scheduled_interval_sec: number | null;
  readonly interval_progress: number | null;
  readonly days_overdue: number | null;
  readonly fsrs_review_correct_count_before: number | null;
  readonly fsrs_review_correct_streak_before: number | null;
  readonly source_weight_active: number | null;
  readonly source_weight_due: number | null;
  readonly source_weight_near: number | null;
  readonly source_weight_random_mastered: number | null;
  readonly source_weight_active_raw: number | null;
  readonly source_weight_due_raw: number | null;
  readonly source_weight_near_raw: number | null;
  readonly source_weight_random_mastered_raw: number | null;
  readonly card_priority_weight: number | null;
  readonly candidate_count: number | null;
  readonly policy_version: string | null;
  readonly fsrs_version: string | null;
  readonly parameter_set_id: string | null;
  readonly experiment_assignment_id: string | null;
  readonly daily_goal_complete_before: boolean | null;
  readonly streak_minimum_complete_before: boolean | null;
  readonly created_at: string;
}

/**
 * Calls `insert_learning_engine_review_event` with one already-built
 * payload via the service-role client. Replays (returns the original
 * row unchanged) on a retried `clientEventId` -- never throws for that
 * case. Throws `LearningEngineTelemetryError` for every genuine
 * rejection (cross-entity mismatch, unknown trace, trace already linked
 * to a different event, etc.).
 */
export async function persistReviewEvent(payload: ReviewEventPersistencePayload): Promise<PersistedReviewEventRow> {
  const supabase = getServiceRoleClient();

  const { data, error } = await supabase.rpc(INSERT_REVIEW_EVENT_RPC, toReviewEventRpcParams(payload));

  if (error) {
    throw new LearningEngineTelemetryError(`${INSERT_REVIEW_EVENT_RPC} RPC call failed`, {
      code: error.code,
      cause: error,
    });
  }

  return data as PersistedReviewEventRow;
}
