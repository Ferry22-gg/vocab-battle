import "server-only";

/**
 * Learning Engine v1 -- Runtime Cutover RC-B: trusted persistence DAL for
 * the Selection Claim Transaction.
 *
 * Narrowest possible trusted TypeScript boundary around the two RC-B RPCs
 * (supabase/migrations/20261009000000_learning_engine_v1_runtime_cutover_rc_b_selection_claim.sql):
 * `get_learning_engine_v1_scheduler_snapshot` and
 * `claim_next_learning_engine_card`. Mirrors every other trusted DAL in
 * this tree (lib/learning-engine/telemetry/dal.ts,
 * lib/learning-engine/cutover/dal.ts): performs NO calculation -- every
 * argument it forwards was already computed by the pure
 * snapshot-mapper/chooseNextCard()/orchestrator layers. Uses ONLY
 * getServiceRoleClient() -- neither RPC has any grant for `authenticated`.
 *
 * Wiring (RC-D, reconfirmed RC-F): claim-next-card.ts's
 * `claimNextLearningEngineCard` (this module's own caller) is itself
 * called live from app/actions/sessions.ts via
 * lib/learning/engine-router.ts -- not merely from tests.
 */

import { getServiceRoleClient } from "@/lib/supabase/service-role";
import type { RawSchedulerSnapshot } from "@/lib/learning-engine/runtime/snapshot-mapper";

const SNAPSHOT_RPC = "get_learning_engine_v1_scheduler_snapshot";
const CLAIM_RPC = "claim_next_learning_engine_card";

/** The SQLSTATE claim_next_learning_engine_card() raises when the caller's scheduler_position/scheduler_revision no longer matches the live deck state -- this project's existing stale-snapshot convention (commit_answer_transaction(), normalize_card_progress_for_learning_engine_v1()). */
export const STALE_SNAPSHOT_SQLSTATE = "40001";

/** Preserves the Postgres SQLSTATE as a first-class field, same pattern as every other trusted DAL error class in this codebase. */
export class LearningEngineClaimError extends Error {
  readonly code: string | undefined;

  constructor(message: string, options: { code?: string; cause: unknown }) {
    super(message, { cause: options.cause });
    this.name = "LearningEngineClaimError";
    this.code = options.code;
  }
}

/**
 * Calls `get_learning_engine_v1_scheduler_snapshot`. Returns the raw jsonb
 * shape as-is -- mapping/validation into a `DeckSchedulerSnapshot` is
 * lib/learning-engine/runtime/snapshot-mapper.ts's job, deliberately kept
 * out of this DAL (same "no calculation" discipline as every other DAL
 * here).
 */
export async function fetchSchedulerSnapshot(userId: string, sessionId: string): Promise<RawSchedulerSnapshot> {
  const supabase = getServiceRoleClient();
  const { data, error } = await supabase.rpc(SNAPSHOT_RPC, {
    p_user_id: userId,
    p_session_id: sessionId,
  });

  if (error) {
    throw new LearningEngineClaimError(`${SNAPSHOT_RPC} RPC call failed`, { code: error.code, cause: error });
  }

  return data as RawSchedulerSnapshot;
}

/** One-to-one with `selection_claims`'s own columns, snake_case as Postgres returns them. */
export interface PersistedSelectionClaimRow {
  readonly id: string;
  readonly user_id: string;
  readonly deck_id: string;
  readonly session_id: string;
  readonly card_id: string;
  readonly selection_trace_id: string;
  readonly scheduler_position: number;
  readonly scheduler_revision: number;
  readonly status: "OPEN" | "ANSWERED" | "ABANDONED";
  readonly created_at: string;
  readonly closed_at: string | null;
}

/** One-to-one with `learning_engine_selection_traces`'s own columns -- the subset this phase's caller needs. Mirrors lib/learning-engine/telemetry/dal.ts's own `PersistedSelectionTraceRow`. */
export interface PersistedSelectionTraceRowForClaim {
  readonly id: string;
  readonly card_id: string | null;
  readonly scheduler_position: number;
  readonly scheduler_revision: number;
}

export interface ClaimRpcResult {
  readonly reused: boolean;
  readonly claim: PersistedSelectionClaimRow | null;
  readonly trace: PersistedSelectionTraceRowForClaim | null;
  /** The authoritative scheduler_revision after this call -- unchanged on the fast path and the no-mutation path, incremented by exactly 1 on a genuine claim-time state mutation. Always present; never inferred from `claim` (which is null on a no-card decision even when admissions/queue/bag still mutated). */
  readonly schedulerRevision: number;
}

export interface ClaimNextLearningEngineCardRpcInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly deckId: string;

  readonly expectedSchedulerPosition: number;
  readonly expectedSchedulerRevision: number;

  readonly cardId: string | null;
  readonly source: string | null;
  readonly selectionReason: string;
  readonly admittedCardIds: readonly string[];
  /** RC-B corrective (lib/learning-engine/runtime/active-draw-counters.ts): claim-time active_draws_since_eligible deltas, empty when this decision's source is not "ACTIVE". */
  readonly activeDrawCounterUpdates: readonly { cardId: string; before: number; after: number }[];
  readonly firstPassQueueBefore: readonly string[] | null;
  readonly firstPassQueueAfter: readonly string[] | null;
  readonly postMasteryShuffleBagBefore: readonly string[] | null;
  readonly postMasteryShuffleBagAfter: readonly string[] | null;

  readonly traceId: string;
  readonly occurredAt: Date;
  readonly schedulerMode: string;
  readonly dueCount: number;
  readonly dailyGoalCompleteBefore: boolean;
  readonly candidateCountActive: number;
  readonly candidateCountDue: number;
  readonly candidateCountNear: number;
  readonly candidateCountRandomMastered: number;
  readonly sourceWeightActiveRaw: number;
  readonly sourceWeightDueRaw: number;
  readonly sourceWeightNearRaw: number;
  readonly sourceWeightRandomMasteredRaw: number;
  readonly sourceWeightActiveNormalized: number;
  readonly sourceWeightDueNormalized: number;
  readonly sourceWeightNearNormalized: number;
  readonly sourceWeightRandomMasteredNormalized: number;
  readonly cardPriorityWeight: number | null;
  readonly retrievability: number | null;
  readonly intervalProgress: number | null;
  readonly emergencyFallbackApplied: boolean;
  readonly randomDraws: readonly number[];
  readonly policyVersion: string;
  readonly tracePayload: Readonly<Record<string, unknown>>;
}

/**
 * Calls `claim_next_learning_engine_card`. Throws `LearningEngineClaimError`
 * on any rejection -- including a stale snapshot (`STALE_SNAPSHOT_SQLSTATE`),
 * which the orchestrator (claim-next-card.ts) treats as its bounded-retry
 * signal, and every entity-validation rejection (42501/22023), which it
 * does not retry.
 */
export async function claimNextLearningEngineCardRpc(
  input: ClaimNextLearningEngineCardRpcInput,
): Promise<ClaimRpcResult> {
  const supabase = getServiceRoleClient();

  const { data, error } = await supabase.rpc(CLAIM_RPC, {
    p_user_id: input.userId,
    p_session_id: input.sessionId,
    p_deck_id: input.deckId,

    p_expected_scheduler_position: input.expectedSchedulerPosition,
    p_expected_scheduler_revision: input.expectedSchedulerRevision,

    p_card_id: input.cardId,
    p_source: input.source,
    p_selection_reason: input.selectionReason,
    p_admitted_card_ids: input.admittedCardIds,
    p_active_draw_counter_updates: input.activeDrawCounterUpdates.map((update) => ({
      card_id: update.cardId,
      before: update.before,
      after: update.after,
    })),
    p_first_pass_queue_before: input.firstPassQueueBefore,
    p_first_pass_queue_after: input.firstPassQueueAfter,
    p_post_mastery_shuffle_bag_before: input.postMasteryShuffleBagBefore,
    p_post_mastery_shuffle_bag_after: input.postMasteryShuffleBagAfter,

    p_trace_id: input.traceId,
    p_occurred_at: input.occurredAt,
    p_scheduler_mode: input.schedulerMode,
    p_due_count: input.dueCount,
    p_daily_goal_complete_before: input.dailyGoalCompleteBefore,
    p_candidate_count_active: input.candidateCountActive,
    p_candidate_count_due: input.candidateCountDue,
    p_candidate_count_near: input.candidateCountNear,
    p_candidate_count_random_mastered: input.candidateCountRandomMastered,
    p_source_weight_active_raw: input.sourceWeightActiveRaw,
    p_source_weight_due_raw: input.sourceWeightDueRaw,
    p_source_weight_near_raw: input.sourceWeightNearRaw,
    p_source_weight_random_mastered_raw: input.sourceWeightRandomMasteredRaw,
    p_source_weight_active_normalized: input.sourceWeightActiveNormalized,
    p_source_weight_due_normalized: input.sourceWeightDueNormalized,
    p_source_weight_near_normalized: input.sourceWeightNearNormalized,
    p_source_weight_random_mastered_normalized: input.sourceWeightRandomMasteredNormalized,
    p_card_priority_weight: input.cardPriorityWeight,
    p_retrievability: input.retrievability,
    p_interval_progress: input.intervalProgress,
    p_emergency_fallback_applied: input.emergencyFallbackApplied,
    p_random_draws: input.randomDraws,
    p_policy_version: input.policyVersion,
    p_trace_payload: input.tracePayload,
  });

  if (error) {
    throw new LearningEngineClaimError(`${CLAIM_RPC} RPC call failed`, { code: error.code, cause: error });
  }

  return data as ClaimRpcResult;
}
