/**
 * Learning Engine v1 -- Runtime Cutover RC-B: pure mapping from the
 * trusted `get_learning_engine_v1_scheduler_snapshot()` RPC's raw jsonb
 * result into a typed, validated `DeckSchedulerSnapshot`
 * (lib/learning-engine/scheduler/snapshot.ts) -- the exact shape
 * `chooseNextCard()` (lib/learning-engine/scheduler/next-card.ts) consumes.
 *
 * Pure throughout: no database access, no clock reads (`now` is supplied
 * by the caller, who already has it from the RPC's own `now` field or a
 * trusted clock), no mutation of its input.
 *
 * ---------------------------------------------------------------------
 * Loud rejection, never silent repair (RC-B brief section 5)
 * ---------------------------------------------------------------------
 * This module never invents, infers, or repairs malformed/incomplete v1
 * state. Every structural invariant below throws `SnapshotValidationError`
 * (never a generic Error, so a caller can distinguish "the DB returned
 * state this mapper refuses to trust" from any other failure) rather than
 * coercing a partial shape into something chooseNextCard() could silently
 * misinterpret:
 *
 *   - LEARNING requires a non-null learningStage (FRESH/LEARNING_1/
 *     LEARNING_2) -- never defaulted to FRESH.
 *   - repairPending and the repair position triple
 *     (repairWrongPosition/repairTargetPosition/repairHardCapPosition)
 *     must be ALL-present or ALL-null together, for ANY card status (this
 *     governs both the within-day repair mechanism and the long-term
 *     relearning mechanism -- see lib/learning-engine/repair-scheduler.ts's
 *     own doc comment on why the DB column's coupling is universal, not
 *     FORGOTTEN-specific). A partial RepairObligation is never mapped to
 *     null and silently continued.
 *   - FORGOTTEN must have a non-null relearningPhase (REPAIR_PENDING or
 *     SPACED_CONFIRMATION_PENDING) -- a FORGOTTEN card with no relearning
 *     phase at all is a structurally impossible v1 state (section 13).
 *   - FORGOTTEN + relearningPhase = REPAIR_PENDING requires repairPending
 *     = true (a complete RepairObligation, per the point above).
 *   - FORGOTTEN + relearningPhase = SPACED_CONFIRMATION_PENDING requires
 *     repairPending = false (the triggering obligation was already
 *     cleared -- lib/learning-engine/repair-scheduler.ts's
 *     resolveRelearningRepairCorrect) AND a non-null
 *     correctCooldownUntilPosition (the spaced-confirmation gate itself).
 *   - ACQUIRED/LEARNED require poolStatus = "OUTSIDE" (sections 11.2/25.2).
 *
 * FSRS state completeness is delegated entirely to the existing
 * lib/learning/fsrs.ts `progressToFsrsCard` adapter (via
 * lib/learning-engine/fsrs/adapter.ts's re-export) -- this module does not
 * duplicate that validation; a row with `fsrsState` null but a populated
 * nullable FSRS field already throws there, with the same loud-rejection
 * discipline.
 */

import { progressToFsrsCard, type UserCardProgressFsrsRow } from "@/lib/learning-engine/fsrs/adapter";
import type { RepairObligation } from "@/lib/learning-engine/repair-scheduler";
import type {
  CardStatus,
  LearningStage,
  PoolStatus,
  RelearningPhase,
} from "@/lib/learning-engine/state";
import type { DailyGoalSnapshot, DeckSchedulerSnapshot, DeckSchedulerState, SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

export class SnapshotValidationError extends Error {
  constructor(message: string) {
    super(`SnapshotValidationError: ${message}`);
    this.name = "SnapshotValidationError";
  }
}

// =============================================================================
// Raw RPC shapes -- one-to-one with get_learning_engine_v1_scheduler_snapshot()'s
// jsonb_build_object() keys (supabase/migrations/
// 20261009000000_learning_engine_v1_runtime_cutover_rc_b_selection_claim.sql).
// =============================================================================

export interface RawSchedulerSnapshotDeckState {
  readonly desiredRetention: number;
  readonly policyVersion: string;
  readonly hasAchievedFullMastery: boolean;
  readonly masteredCount: number;
  readonly schedulerPosition: number;
  readonly lastCriticalDuePosition: number | null;
  readonly schedulerRevision: number;
  readonly firstPassQueue: readonly string[] | null;
  readonly postMasteryShuffleBag: readonly string[] | null;
}

export interface RawSchedulerSnapshotDailyGoal {
  readonly enemiesDefeatedToday: number;
  readonly completed: boolean;
}

export interface RawSchedulerSnapshotCard {
  readonly cardId: string;
  readonly cardStatus: CardStatus;
  readonly learningStage: LearningStage;
  readonly poolStatus: PoolStatus;
  readonly relearningPhase: RelearningPhase;
  readonly hasEverBeenMastered: boolean;
  readonly repairPending: boolean;
  readonly repairWrongPosition: number | null;
  readonly repairTargetPosition: number | null;
  readonly repairHardCapPosition: number | null;
  readonly correctCooldownUntilPosition: number | null;
  readonly activeDrawsSinceEligible: number;
  readonly fsrsReviewCorrectCount: number;
  readonly fsrsReviewCorrectStreak: number;
  readonly fsrsDueAt: string | null;
  readonly fsrsStability: number | null;
  readonly fsrsDifficulty: number | null;
  readonly fsrsElapsedDays: number;
  readonly fsrsScheduledDays: number;
  readonly fsrsReps: number;
  readonly fsrsLapses: number;
  readonly fsrsLearningSteps: number;
  readonly fsrsState: 0 | 1 | 2 | 3 | null;
  readonly fsrsLastReviewAt: string | null;
}

export interface RawSchedulerSnapshotOpenClaim {
  readonly id: string;
  readonly cardId: string | null;
  readonly selectionTraceId: string;
  readonly schedulerPosition: number;
  readonly schedulerRevision: number;
  /**
   * Alpha performance optimization: the claimed card's own display
   * content, joined in by the trusted RPC itself so the orchestrator's
   * fast path (claim-next-card.ts) never needs a follow-up SELECT.
   * Never consumed by this module -- `mapRawSchedulerSnapshot()` doesn't
   * surface `openClaim` into `DeckSchedulerSnapshot` at all, since
   * chooseNextCard() never runs on this fast path -- only
   * claim-next-card.ts's own orchestration reads these fields directly.
   */
  readonly front: string | null;
  readonly back: string | null;
}

export interface RawSchedulerSnapshot {
  readonly userId: string;
  readonly deckId: string;
  readonly now: string;
  readonly deckState: RawSchedulerSnapshotDeckState | null;
  readonly dailyGoal: RawSchedulerSnapshotDailyGoal | null;
  readonly cards: readonly RawSchedulerSnapshotCard[];
  readonly openClaim: RawSchedulerSnapshotOpenClaim | null;
}

// =============================================================================
// Per-card validation + mapping
// =============================================================================

function normalizeQueue(queue: readonly string[] | null): readonly string[] | null {
  return queue !== null && queue.length > 0 ? queue : null;
}

/**
 * Validates and maps the repair-obligation triple for one card.
 * Universal rule (see module header): repairPending and the three
 * position fields are all-present or all-null together, for any
 * cardStatus. Returns `null` when no obligation exists.
 */
function mapRepairObligation(raw: RawSchedulerSnapshotCard): RepairObligation | null {
  const positions = [raw.repairWrongPosition, raw.repairTargetPosition, raw.repairHardCapPosition];
  const presentCount = positions.filter((p) => p !== null).length;

  if (raw.repairPending) {
    if (presentCount !== 3) {
      throw new SnapshotValidationError(
        `card ${raw.cardId}: repairPending is true but repair position fields are incomplete ` +
          `(wrong=${raw.repairWrongPosition}, target=${raw.repairTargetPosition}, hardCap=${raw.repairHardCapPosition}) -- ` +
          "a partial RepairObligation must never be mapped and silently continued",
      );
    }
    // `createRepairObligation` is not used here -- these are already-computed,
    // persisted positions, not a fresh sample. Construct the obligation
    // object directly, matching RepairObligation's own field shape.
    return {
      cardId: raw.cardId,
      wrongPosition: raw.repairWrongPosition as number,
      targetPosition: raw.repairTargetPosition as number,
      hardCapPosition: raw.repairHardCapPosition as number,
    };
  }

  if (presentCount !== 0) {
    throw new SnapshotValidationError(
      `card ${raw.cardId}: repairPending is false but repair position fields are non-null ` +
        `(wrong=${raw.repairWrongPosition}, target=${raw.repairTargetPosition}, hardCap=${raw.repairHardCapPosition})`,
    );
  }
  return null;
}

function validateCardInvariants(raw: RawSchedulerSnapshotCard): void {
  if (raw.cardStatus === "LEARNING" && raw.learningStage === null) {
    throw new SnapshotValidationError(`card ${raw.cardId}: cardStatus LEARNING requires a non-null learningStage`);
  }

  if (raw.cardStatus === "FORGOTTEN") {
    if (raw.relearningPhase === null) {
      throw new SnapshotValidationError(
        `card ${raw.cardId}: cardStatus FORGOTTEN requires a non-null relearningPhase (REPAIR_PENDING or SPACED_CONFIRMATION_PENDING)`,
      );
    }
    if (raw.relearningPhase === "REPAIR_PENDING" && !raw.repairPending) {
      throw new SnapshotValidationError(
        `card ${raw.cardId}: relearningPhase REPAIR_PENDING requires repairPending = true`,
      );
    }
    if (raw.relearningPhase === "SPACED_CONFIRMATION_PENDING") {
      if (raw.repairPending) {
        throw new SnapshotValidationError(
          `card ${raw.cardId}: relearningPhase SPACED_CONFIRMATION_PENDING requires repairPending = false ` +
            "(the triggering obligation must already be cleared)",
        );
      }
      if (raw.correctCooldownUntilPosition === null) {
        throw new SnapshotValidationError(
          `card ${raw.cardId}: relearningPhase SPACED_CONFIRMATION_PENDING requires a non-null correctCooldownUntilPosition (the spaced-confirmation gate)`,
        );
      }
    }
  }

  if ((raw.cardStatus === "ACQUIRED" || raw.cardStatus === "LEARNED") && raw.poolStatus !== "OUTSIDE") {
    throw new SnapshotValidationError(
      `card ${raw.cardId}: cardStatus ${raw.cardStatus} requires poolStatus = OUTSIDE (got ${String(raw.poolStatus)})`,
    );
  }
}

function toFsrsRow(raw: RawSchedulerSnapshotCard): UserCardProgressFsrsRow {
  return {
    fsrs_due_at: raw.fsrsDueAt === null ? null : new Date(raw.fsrsDueAt),
    fsrs_stability: raw.fsrsStability,
    fsrs_difficulty: raw.fsrsDifficulty,
    fsrs_elapsed_days: raw.fsrsElapsedDays,
    fsrs_scheduled_days: raw.fsrsScheduledDays,
    fsrs_reps: raw.fsrsReps,
    fsrs_lapses: raw.fsrsLapses,
    fsrs_learning_steps: raw.fsrsLearningSteps,
    fsrs_state: raw.fsrsState,
    fsrs_last_review_at: raw.fsrsLastReviewAt === null ? null : new Date(raw.fsrsLastReviewAt),
  };
}

function mapCard(raw: RawSchedulerSnapshotCard, now: Date): SchedulableCardRow {
  validateCardInvariants(raw);
  const repairObligation = mapRepairObligation(raw);
  const fsrsCard = progressToFsrsCard(toFsrsRow(raw), now);

  return {
    cardId: raw.cardId,
    cardStatus: raw.cardStatus,
    learningStage: raw.learningStage,
    poolStatus: raw.poolStatus,
    relearningPhase: raw.relearningPhase,
    hasEverBeenMastered: raw.hasEverBeenMastered,
    repairPending: raw.repairPending,
    fsrsReviewCorrectCount: raw.fsrsReviewCorrectCount,
    fsrsReviewCorrectStreak: raw.fsrsReviewCorrectStreak,
    correctCooldownUntilPosition: raw.correctCooldownUntilPosition,
    activeDrawsSinceEligible: raw.activeDrawsSinceEligible,
    repairObligation,
    fsrsCard,
  };
}

// =============================================================================
// Top-level mapper
// =============================================================================

/**
 * Maps the trusted RPC's raw jsonb result into a validated
 * `DeckSchedulerSnapshot`. Throws `SnapshotValidationError` for any
 * structurally incomplete/impossible card state (see module header);
 * throws a plain `Error` only for a missing `deckState` (should never
 * happen given the RPC's own lazy-upsert, so this is defense-in-depth,
 * not an expected runtime path).
 */
export function mapRawSchedulerSnapshot(raw: RawSchedulerSnapshot): DeckSchedulerSnapshot {
  if (raw.deckState === null) {
    throw new Error("mapRawSchedulerSnapshot: deckState is null -- the trusted RPC should always lazily create it");
  }

  const now = new Date(raw.now);

  const deckState: DeckSchedulerState = {
    desiredRetention: raw.deckState.desiredRetention,
    policyVersion: raw.deckState.policyVersion,
    hasAchievedFullMastery: raw.deckState.hasAchievedFullMastery,
    masteredCount: raw.deckState.masteredCount,
    schedulerPosition: raw.deckState.schedulerPosition,
    lastCriticalDuePosition: raw.deckState.lastCriticalDuePosition,
    schedulerRevision: raw.deckState.schedulerRevision,
    firstPassQueue: normalizeQueue(raw.deckState.firstPassQueue),
    postMasteryShuffleBag: normalizeQueue(raw.deckState.postMasteryShuffleBag),
  };

  const dailyGoal: DailyGoalSnapshot = {
    enemiesDefeatedToday: raw.dailyGoal?.enemiesDefeatedToday ?? 0,
    completed: raw.dailyGoal?.completed ?? false,
  };

  const cards = raw.cards.map((card) => mapCard(card, now));

  return {
    userId: raw.userId,
    deckId: raw.deckId,
    now,
    deckState,
    dailyGoal,
    cards,
  };
}
