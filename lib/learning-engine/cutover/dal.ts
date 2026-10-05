import "server-only";

/**
 * Learning Engine v1 -- Runtime Cutover RC-A: trusted persistence DAL
 * for the one-time legacy-normalization script.
 *
 * Narrowest possible trusted TypeScript boundary around the RC-A/RC-D/
 * pre-RC-E RPCs (supabase/migrations/20261008000000_learning_engine_v1_cutover_normalization_functions.sql,
 * 20261017000000_learning_engine_v1_runtime_cutover_rc_d.sql,
 * 20261019000000_learning_engine_v1_enrollment_active_legacy_session_guard.sql,
 * 20261020000000_learning_engine_v1_enrollment_atomic_commit.sql). Mirrors
 * lib/learning-engine/telemetry/dal.ts's own documented contract
 * exactly: this module performs NO calculation. Every argument it
 * forwards was already computed by lib/learning-engine/cutover/
 * normalize-legacy-state.ts / prepare-normalization.ts (pure). This
 * module's only job is to shape that payload into each RPC's parameter
 * names and call it via the service-role client.
 *
 * `normalizeCardProgress()`/`recomputeUserDeckLearningState()`/
 * `admitUserToLearningEngineV1()` below remain in direct use by the
 * one-time global cutover script (scripts/learning-engine-v1-cutover-normalize.ts,
 * no userId -- normalizes historical legacy data with no live Session to
 * race against) and by tests. The live PER-USER enrollment path
 * (lib/learning-engine/cutover/enroll.ts) no longer calls any of the
 * three individually -- it calls `commitLearningEngineV1Enrollment()`
 * below instead, which composes the equivalent SQL primitives inside one
 * atomic transaction server-side (pre-RC-E correction: calling them as
 * separate round trips left a TOCTOU race against Session creation).
 *
 * Uses ONLY getServiceRoleClient() (lib/supabase/service-role.ts) --
 * never the authenticated cookie client (none of these RPCs have any
 * grant for `authenticated` at all).
 */

import { getServiceRoleClient } from "@/lib/supabase/service-role";
import type { NormalizedCardProgressTarget, LegacyCardStatus } from "@/lib/learning-engine/cutover/normalize-legacy-state";
import type { NormalizationTargetForCard } from "@/lib/learning-engine/cutover/prepare-normalization";

const NORMALIZE_CARD_PROGRESS_RPC = "normalize_card_progress_for_learning_engine_v1";
const RECOMPUTE_DECK_STATE_RPC = "recompute_user_deck_learning_state_for_v1";
const ADMIT_USER_RPC = "admit_user_to_learning_engine_v1";
const COMMIT_ENROLLMENT_RPC = "commit_learning_engine_v1_enrollment";

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

/** One-to-one with learning_engine_v1_rollout's own columns. */
export interface LearningEngineV1RolloutRow {
  readonly user_id: string;
  readonly enabled_at: string;
  readonly first_v1_answer_at: string | null;
}

/**
 * Pre-RC-E enrollment-safety read: does a `learning_engine_v1_rollout` row
 * already exist for this user? FAST-PATH OPTIMIZATION ONLY -- the
 * authoritative repeated-enrollment no-op guarantee now lives inside
 * `commit_learning_engine_v1_enrollment()`'s own transaction (step 2 of
 * its own header comment), which re-checks this under a profile-row lock
 * regardless of what this function returns. This read exists purely so
 * lib/learning-engine/cutover/enroll.ts can skip reading and preparing a
 * full normalization payload for a user who is already enrolled, rather
 * than building that payload only to have the trusted transaction discard
 * it. Plain SELECT, no mutation.
 */
export async function getLearningEngineV1RolloutRow(userId: string): Promise<LearningEngineV1RolloutRow | null> {
  const supabase = getServiceRoleClient();

  const { data, error } = await supabase
    .from("learning_engine_v1_rollout")
    .select("user_id, enabled_at, first_v1_answer_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new LearningEngineCutoverError("learning_engine_v1_rollout read failed", { code: error.code, cause: error });
  }

  return data as LearningEngineV1RolloutRow | null;
}

/** Narrow shape for the active-legacy-session enrollment guard below -- only the one column the guard needs. */
export interface ActiveLegacySessionRow {
  readonly id: string;
}

/**
 * Pre-RC-E enrollment-safety read: does this user currently have an
 * ACTIVE, engine_version='legacy' session? FAST-PATH OPTIMIZATION ONLY,
 * same caveat as getLearningEngineV1RolloutRow above: this read has a
 * TOCTOU gap all on its own (a session can be created the instant after
 * this resolves) and is NOT what makes enrollment safe. The authoritative
 * guard lives inside `commit_learning_engine_v1_enrollment()`'s own
 * transaction, which re-checks this under the SAME profile-row lock that
 * serializes it against a concurrent start_or_resume_session() call --
 * see that migration's header
 * (20261020000000_learning_engine_v1_enrollment_atomic_commit.sql) for
 * why that closes the race this function cannot. This function exists
 * purely to let lib/learning-engine/cutover/enroll.ts fail fast with a
 * friendly, correctly-identified error in the common case, before ever
 * reading/preparing a normalization payload -- never as the sole thing
 * standing between an active legacy Session and a corrupting
 * normalization write.
 */
export async function getActiveLegacySessionForUser(userId: string): Promise<ActiveLegacySessionRow | null> {
  const supabase = getServiceRoleClient();

  const { data, error } = await supabase
    .from("sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "active")
    .eq("engine_version", "legacy")
    .maybeSingle();

  if (error) {
    throw new LearningEngineCutoverError("active legacy session read failed", { code: error.code, cause: error });
  }

  return data as ActiveLegacySessionRow | null;
}

/**
 * Runtime Cutover RC-D (pre-RC-E corrected): calls
 * `admit_user_to_learning_engine_v1` -- the minimal trusted,
 * service_role-only rollout-admission primitive
 * (supabase/migrations/20261017000000_learning_engine_v1_runtime_cutover_rc_d.sql,
 * 20261019000000_learning_engine_v1_enrollment_active_legacy_session_guard.sql).
 * Write-only; performs no normalization itself, and (as of the second
 * migration above) rejects a user with an active legacy Session under
 * its own profile-row lock. No longer called directly from TypeScript
 * for the live per-user enrollment path -- `commit_learning_engine_v1_enrollment()`
 * (called via `commitLearningEngineV1Enrollment()` below) calls it as a
 * plain nested function call from within its own transaction instead, so
 * admission commits atomically with normalization. Still used directly
 * by the one-time global cutover script and by tests exercising this
 * primitive in isolation. Idempotent: admitting an already-admitted user
 * is a safe no-op.
 */
export async function admitUserToLearningEngineV1(userId: string): Promise<LearningEngineV1RolloutRow> {
  const supabase = getServiceRoleClient();

  const { data, error } = await supabase.rpc(ADMIT_USER_RPC, { p_user_id: userId });

  if (error) {
    throw new LearningEngineCutoverError(`${ADMIT_USER_RPC} RPC call failed`, {
      code: error.code,
      cause: error,
    });
  }

  return data as LearningEngineV1RolloutRow;
}

// =============================================================================
// commitLearningEngineV1Enrollment() -- pre-RC-E corrective atomic
// enrollment transaction (20261020000000_learning_engine_v1_enrollment_atomic_commit.sql)
// =============================================================================

export interface CommitLearningEngineV1EnrollmentInput {
  readonly normalizationVersion: string;
  readonly cards: readonly NormalizationTargetForCard[];
  readonly deckIds: readonly string[];
}

export type CommitLearningEngineV1EnrollmentResult =
  | { readonly status: "ok"; readonly rollout: LearningEngineV1RolloutRow; readonly cardsNormalized: number; readonly decksRecomputed: number }
  | { readonly status: "already_enrolled"; readonly rollout: LearningEngineV1RolloutRow }
  | { readonly status: "active_legacy_session"; readonly sessionId: string };

/**
 * Calls `commit_learning_engine_v1_enrollment` -- the single atomic
 * enrollment transaction that closes the TOCTOU race a prepare-then-
 * separately-admit sequence left open (see that migration's own header).
 * `input.cards` is the fully pre-computed normalization payload from
 * `lib/learning-engine/cutover/prepare-normalization.ts`'s
 * `prepareLearningEngineV1NormalizationForUser()` -- this function
 * performs no computation of its own, only reshaping into the RPC's
 * jsonb parameter shape (camelCase keys, matching this codebase's
 * existing jsonb-payload convention, e.g.
 * commit_learning_engine_v1_answer()'s `p_card_after`). Each card's
 * `userId` field is deliberately NOT sent -- every row is normalized
 * under the single `userId` parameter below, so this payload can never
 * address another user's data regardless of its contents.
 *
 * The three result variants are the SQL function's own status envelope
 * (not exceptions) for three equally-expected outcomes: a fresh
 * enrollment commit, a true no-op for an already-enrolled user, or a
 * rejection because the user currently has an active legacy Session --
 * the last of which is the rare race this migration exists to catch
 * when `getActiveLegacySessionForUser()`'s own fast-path pre-check
 * (lib/learning-engine/cutover/enroll.ts) missed it by a matter of
 * milliseconds.
 */
export async function commitLearningEngineV1Enrollment(
  userId: string,
  input: CommitLearningEngineV1EnrollmentInput,
): Promise<CommitLearningEngineV1EnrollmentResult> {
  const supabase = getServiceRoleClient();

  const { data, error } = await supabase.rpc(COMMIT_ENROLLMENT_RPC, {
    p_user_id: userId,
    p_normalization_version: input.normalizationVersion,
    p_cards: input.cards.map((card) => ({
      cardId: card.cardId,
      expectedLegacyCardStatus: card.expectedLegacyCardStatus,
      cardStatus: card.target.cardStatus,
      learningStage: card.target.learningStage,
      poolStatus: card.target.poolStatus,
      relearningPhase: card.target.relearningPhase,
      hasEverBeenMastered: card.target.hasEverBeenMastered,
      repairPending: card.target.repairPending,
      repairWrongPosition: card.target.repairWrongPosition,
      repairTargetPosition: card.target.repairTargetPosition,
      repairHardCapPosition: card.target.repairHardCapPosition,
    })),
    p_deck_ids: input.deckIds,
  });

  if (error) {
    throw new LearningEngineCutoverError(`${COMMIT_ENROLLMENT_RPC} RPC call failed`, {
      code: error.code,
      cause: error,
    });
  }

  const row = data as {
    status: "ok" | "already_enrolled" | "active_legacy_session";
    rollout?: LearningEngineV1RolloutRow;
    cards_normalized?: number;
    decks_recomputed?: number;
    session_id?: string;
  };

  if (row.status === "ok") {
    return {
      status: "ok",
      rollout: row.rollout as LearningEngineV1RolloutRow,
      cardsNormalized: row.cards_normalized ?? 0,
      decksRecomputed: row.decks_recomputed ?? 0,
    };
  }
  if (row.status === "already_enrolled") {
    return { status: "already_enrolled", rollout: row.rollout as LearningEngineV1RolloutRow };
  }
  if (row.status === "active_legacy_session") {
    return { status: "active_legacy_session", sessionId: row.session_id as string };
  }

  throw new LearningEngineCutoverError(`${COMMIT_ENROLLMENT_RPC}: unrecognized status ${JSON.stringify(row.status)}`, {
    cause: row,
  });
}
