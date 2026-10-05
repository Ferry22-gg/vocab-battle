import "server-only";

/**
 * Learning Engine v1 -- Runtime Cutover RC-C: trusted persistence DAL for
 * the Answer Commit Transaction.
 *
 * Mirrors lib/learning-engine/runtime/claim-dal.ts exactly: performs NO
 * calculation -- every argument it forwards was already computed by the
 * pure answer-context-mapper/prepareLearningEngineAnswer/review-event
 * layers. Uses ONLY getServiceRoleClient() -- neither RPC has any grant
 * for `authenticated`.
 *
 * Not called from any live application code path -- only from
 * lib/learning-engine/runtime/commit-answer.ts and tests.
 */

import { getServiceRoleClient } from "@/lib/supabase/service-role";
import type { RawAnswerContext } from "@/lib/learning-engine/runtime/answer-context-mapper";

const ANSWER_CONTEXT_RPC = "get_learning_engine_v1_answer_context";
const COMMIT_RPC = "commit_learning_engine_v1_answer";

/** The SQLSTATE commit_learning_engine_v1_answer() raises for a stale scheduler_position or card-before snapshot -- this project's existing stale-snapshot convention. */
export const STALE_ANSWER_SNAPSHOT_SQLSTATE = "40001";

export class LearningEngineAnswerCommitError extends Error {
  readonly code: string | undefined;

  constructor(message: string, options: { code?: string; cause: unknown }) {
    super(message, { cause: options.cause });
    this.name = "LearningEngineAnswerCommitError";
    this.code = options.code;
  }
}

export async function fetchAnswerContext(userId: string, sessionId: string, claimId: string): Promise<RawAnswerContext> {
  const supabase = getServiceRoleClient();
  const { data, error } = await supabase.rpc(ANSWER_CONTEXT_RPC, {
    p_user_id: userId,
    p_session_id: sessionId,
    p_claim_id: claimId,
  });

  if (error) {
    throw new LearningEngineAnswerCommitError(`${ANSWER_CONTEXT_RPC} RPC call failed`, { code: error.code, cause: error });
  }

  return data as RawAnswerContext;
}

export interface ExistingAnswerEventRow {
  readonly id: string;
  readonly user_id: string;
  readonly session_id: string;
  readonly card_id: string;
  readonly [key: string]: unknown;
}

/**
 * The orchestration layer's own idempotency pre-check (lib/learning-engine/
 * runtime/commit-answer.ts), mirroring commit_learning_engine_v1_answer()'s
 * own "idempotency check happens first" ordering -- but run from
 * TypeScript, BEFORE fetchAnswerContext/prepareLearningEngineAnswer, so a
 * genuine replay (submitted after the claim this client_event_id
 * originally answered has already moved to ANSWERED) never has to
 * re-read/re-prepare against already-mutated card state. A plain
 * service-role table read, not a second idempotency implementation: it
 * only looks up the row the trusted RPC already wrote; it computes
 * nothing. Returns `null` when no such event exists (a genuinely new
 * answer).
 */
export async function fetchExistingAnswerEvent(
  clientEventId: string,
): Promise<{ readonly answerEvent: ExistingAnswerEventRow; readonly xpEvents: readonly CommittedXpEventRow[] } | null> {
  const supabase = getServiceRoleClient();

  const { data: answerEvent, error: answerEventError } = await supabase
    .from("answer_events")
    .select("*")
    .eq("client_event_id", clientEventId)
    .maybeSingle();

  if (answerEventError) {
    throw new LearningEngineAnswerCommitError("answer_events replay lookup failed", { code: answerEventError.code, cause: answerEventError });
  }
  if (!answerEvent) {
    return null;
  }

  const { data: xpEvents, error: xpEventsError } = await supabase
    .from("xp_events")
    .select("*")
    .eq("source_answer_event_id", answerEvent.id)
    .order("created_at", { ascending: true });

  if (xpEventsError) {
    throw new LearningEngineAnswerCommitError("xp_events replay lookup failed", { code: xpEventsError.code, cause: xpEventsError });
  }

  return { answerEvent: answerEvent as ExistingAnswerEventRow, xpEvents: (xpEvents ?? []) as CommittedXpEventRow[] };
}

export interface CommittedXpEventRow {
  readonly id: string;
  readonly user_id: string;
  readonly session_id: string | null;
  readonly card_id: string | null;
  readonly source_answer_event_id: string | null;
  readonly amount: number;
  readonly reason: "correct_answer" | "card_learned" | "card_relearned" | "enemy_defeated" | "daily_goal_completed" | "admin_adjustment";
  readonly created_at: string;
}

export interface CommitLearningEngineAnswerRpcResult {
  readonly is_replay: boolean;
  readonly answer_event: Record<string, unknown>;
  readonly xp_events: readonly CommittedXpEventRow[];
  readonly daily_goal_just_completed: boolean;
  readonly card_mastered_just_now: boolean;
  readonly full_mastery_just_achieved: boolean | null;
  readonly user_card_progress: Record<string, unknown> | null;
  readonly session: Record<string, unknown> | null;
  readonly profile: Record<string, unknown> | null;
  readonly deck_state: Record<string, unknown> | null;
}

export interface CommitLearningEngineAnswerRpcInput {
  readonly clientEventId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly claimId: string;
  readonly cardId: string;

  readonly expectedSchedulerPosition: number;
  readonly expectedCardBefore: Readonly<Record<string, unknown>>;
  readonly expectedSessionComboBefore: number;
  readonly expectedSessionEnemyHpBefore: number | null;

  readonly cardAfter: Readonly<Record<string, unknown>>;
  readonly repairObligationAfter: Readonly<Record<string, unknown>> | null;

  readonly correct: boolean;
  readonly responseTimeMs: number;
  readonly baseDamage: number;
  readonly speedBonus: number;
  readonly critical: boolean;
  readonly comboAfter: number;
  readonly damage: number;
  readonly enemyHpAfter: number;
  readonly enemyDefeated: boolean;
  readonly newEnemyType: string | null;
  readonly newEnemyMaxHp: number | null;
  readonly newEnemyHp: number | null;

  readonly reviewEvent: Readonly<Record<string, unknown>>;
}

/**
 * Calls `commit_learning_engine_v1_answer`. Throws `LearningEngineAnswerCommitError`
 * on any rejection, including a stale snapshot (`STALE_ANSWER_SNAPSHOT_SQLSTATE`).
 */
export async function commitLearningEngineAnswerRpc(
  input: CommitLearningEngineAnswerRpcInput,
): Promise<CommitLearningEngineAnswerRpcResult> {
  const supabase = getServiceRoleClient();

  const { data, error } = await supabase.rpc(COMMIT_RPC, {
    p_client_event_id: input.clientEventId,
    p_user_id: input.userId,
    p_session_id: input.sessionId,
    p_claim_id: input.claimId,
    p_card_id: input.cardId,

    p_expected_scheduler_position: input.expectedSchedulerPosition,
    p_expected_card_before: input.expectedCardBefore,
    p_expected_session_combo_before: input.expectedSessionComboBefore,
    p_expected_session_enemy_hp_before: input.expectedSessionEnemyHpBefore,

    p_card_after: input.cardAfter,
    p_repair_obligation_after: input.repairObligationAfter,

    p_correct: input.correct,
    p_response_time_ms: input.responseTimeMs,
    p_base_damage: input.baseDamage,
    p_speed_bonus: input.speedBonus,
    p_critical: input.critical,
    p_combo_after: input.comboAfter,
    p_damage: input.damage,
    p_enemy_hp_after: input.enemyHpAfter,
    p_enemy_defeated: input.enemyDefeated,
    p_new_enemy_type: input.newEnemyType,
    p_new_enemy_max_hp: input.newEnemyMaxHp,
    p_new_enemy_hp: input.newEnemyHp,

    p_review_event: input.reviewEvent,
  });

  if (error) {
    throw new LearningEngineAnswerCommitError(`${COMMIT_RPC} RPC call failed`, { code: error.code, cause: error });
  }

  return data as CommitLearningEngineAnswerRpcResult;
}
