import "server-only";

/**
 * Learning Engine v1 -- Runtime Cutover RC-A: trusted persistence DAL
 * for the one-time legacy-normalization script.
 *
 * Narrowest possible trusted TypeScript boundary around the two RC-A
 * RPCs (supabase/migrations/20261008000000_learning_engine_v1_cutover_normalization_functions.sql):
 * `normalize_card_progress_for_learning_engine_v1` and
 * `recompute_user_deck_learning_state_for_v1`. Mirrors
 * lib/learning-engine/telemetry/dal.ts's own documented contract
 * exactly: this module performs NO calculation. Every argument it
 * forwards was already computed by lib/learning-engine/cutover/
 * normalize-legacy-state.ts (pure). This module's only job is to shape
 * that payload into the RPC's parameter names and call it via the
 * service-role client.
 *
 * Uses ONLY getServiceRoleClient() (lib/supabase/service-role.ts) --
 * never the authenticated cookie client (neither RPC has any grant for
 * `authenticated` at all). Not called from any live application code
 * path -- only from the one-time normalization script
 * (scripts/learning-engine-v1-cutover-normalize.ts) and from tests.
 */

import { getServiceRoleClient } from "@/lib/supabase/service-role";
import type { NormalizedCardProgressTarget, LegacyCardStatus } from "@/lib/learning-engine/cutover/normalize-legacy-state";

const NORMALIZE_CARD_PROGRESS_RPC = "normalize_card_progress_for_learning_engine_v1";
const RECOMPUTE_DECK_STATE_RPC = "recompute_user_deck_learning_state_for_v1";

/** Preserves the Postgres SQLSTATE as a first-class field, same pattern as every other trusted DAL error class in this codebase (lib/learning/commit-answer.ts's CommitAnswerTransactionError, lib/learning-engine/telemetry/dal.ts's LearningEngineTelemetryError). */
export class LearningEngineCutoverError extends Error {
  readonly code: string | undefined;

  constructor(message: string, options: { code?: string; cause: unknown }) {
    super(message, { cause: options.cause });
    this.name = "LearningEngineCutoverError";
    this.code = options.code;
  }
}

/** The SQLSTATE normalize_card_progress_for_learning_engine_v1() raises when the row has drifted from its expected legacy card_status since being audited -- the same code this project's "stale snapshot" convention already uses (commit_answer_transaction()). */
export const CUTOVER_NORMALIZATION_DRIFTED_SQLSTATE = "40001";

export interface NormalizeCardProgressInput {
  readonly userId: string;
  readonly cardId: string;
  readonly expectedLegacyCardStatus: LegacyCardStatus;
  readonly target: NormalizedCardProgressTarget;
  readonly normalizationVersion: string;
}

/** One-to-one with user_card_progress's own columns (the RPC's `returning *`), snake_case as Postgres returns them -- only the subset this phase's caller needs to verify, not the full row. */
export interface NormalizedCardProgressRow {
  readonly id: string;
  readonly user_id: string;
  readonly card_id: string;
  readonly card_status: string;
  readonly learning_stage: string | null;
  readonly pool_status: string | null;
  readonly relearning_phase: string | null;
  readonly has_ever_been_mastered: boolean;
  readonly repair_pending: boolean;
  readonly repair_wrong_position: number | null;
  readonly repair_target_position: number | null;
  readonly repair_hard_cap_position: number | null;
}

/**
 * Calls `normalize_card_progress_for_learning_engine_v1` for one card.
 * Throws `LearningEngineCutoverError` on any rejection -- including a
 * drifted-row rejection (`CUTOVER_NORMALIZATION_DRIFTED_SQLSTATE`), which
 * callers should treat as "re-audit this card before normalizing it",
 * never retried blindly.
 */
export async function normalizeCardProgress(input: NormalizeCardProgressInput): Promise<NormalizedCardProgressRow> {
  const supabase = getServiceRoleClient();

  const { data, error } = await supabase.rpc(NORMALIZE_CARD_PROGRESS_RPC, {
    p_user_id: input.userId,
    p_card_id: input.cardId,
    p_expected_legacy_card_status: input.expectedLegacyCardStatus,
    p_card_status: input.target.cardStatus,
    p_learning_stage: input.target.learningStage,
    p_pool_status: input.target.poolStatus,
    p_relearning_phase: input.target.relearningPhase,
    p_has_ever_been_mastered: input.target.hasEverBeenMastered,
    p_repair_pending: input.target.repairPending,
    p_repair_wrong_position: input.target.repairWrongPosition,
    p_repair_target_position: input.target.repairTargetPosition,
    p_repair_hard_cap_position: input.target.repairHardCapPosition,
    p_normalization_version: input.normalizationVersion,
  });

  if (error) {
    throw new LearningEngineCutoverError(`${NORMALIZE_CARD_PROGRESS_RPC} RPC call failed`, {
      code: error.code,
      cause: error,
    });
  }

  return data as NormalizedCardProgressRow;
}

/** One-to-one with user_deck_learning_state's own columns relevant to this phase. */
export interface RecomputedDeckStateRow {
  readonly user_id: string;
  readonly deck_id: string;
  readonly mastered_count: number;
  readonly has_achieved_full_mastery: boolean;
}

/** Calls `recompute_user_deck_learning_state_for_v1` for one (user, deck) pair. Must be called AFTER every card in that deck has already been normalized via normalizeCardProgress() above -- see that RPC's own doc comment. */
export async function recomputeUserDeckLearningState(
  userId: string,
  deckId: string,
): Promise<RecomputedDeckStateRow> {
  const supabase = getServiceRoleClient();

  const { data, error } = await supabase.rpc(RECOMPUTE_DECK_STATE_RPC, {
    p_user_id: userId,
    p_deck_id: deckId,
  });

  if (error) {
    throw new LearningEngineCutoverError(`${RECOMPUTE_DECK_STATE_RPC} RPC call failed`, {
      code: error.code,
      cause: error,
    });
  }

  return data as RecomputedDeckStateRow;
}
