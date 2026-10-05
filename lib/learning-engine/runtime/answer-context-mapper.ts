/**
 * Learning Engine v1 -- Runtime Cutover RC-C: pure mapping from the
 * trusted `get_learning_engine_v1_answer_context()` RPC's raw jsonb
 * result into a typed, validated `AnswerContext` -- the exact shape
 * `prepareLearningEngineAnswer()` (lib/learning-engine/runtime/
 * prepare-answer.ts) and the review-event builder consume.
 *
 * Pure throughout: no database access, no clock reads, no mutation of
 * input. Mirrors lib/learning-engine/runtime/snapshot-mapper.ts's own
 * "loud rejection, never silent repair" discipline -- a structurally
 * incomplete/impossible card state throws `AnswerContextValidationError`
 * rather than being coerced into something the answer-preparation layer
 * could silently misinterpret.
 */

import { progressToFsrsCard, type UserCardProgressFsrsRow } from "@/lib/learning-engine/fsrs/adapter";
import type { RepairObligation } from "@/lib/learning-engine/repair-scheduler";
import type { CardStatus, LearningStage, PoolStatus, RelearningPhase } from "@/lib/learning-engine/state";
import type { SelectionReason, NextCardSource, AnySchedulerMode } from "@/lib/learning-engine/scheduler/next-card";

export class AnswerContextValidationError extends Error {
  constructor(message: string) {
    super(`AnswerContextValidationError: ${message}`);
    this.name = "AnswerContextValidationError";
  }
}

// =============================================================================
// Raw RPC shape -- one-to-one with get_learning_engine_v1_answer_context()'s
// jsonb_build_object() keys (supabase/migrations/
// 20261013000000_learning_engine_v1_runtime_cutover_rc_c_answer_commit.sql).
// =============================================================================

export interface RawAnswerContext {
  readonly userId: string;
  readonly deckId: string;
  readonly now: string;
  readonly session: { readonly comboBefore: number; readonly enemyHpBefore: number | null; readonly totalAnswersBefore: number };
  readonly claim: {
    readonly id: string;
    readonly cardId: string;
    readonly selectionTraceId: string;
    readonly schedulerPosition: number;
    readonly schedulerRevision: number;
    readonly status: "OPEN" | "ANSWERED" | "ABANDONED";
  };
  readonly trace: {
    readonly source: NextCardSource;
    readonly selectionReason: SelectionReason;
    readonly schedulerMode: AnySchedulerMode;
    readonly sourceWeightActive: number | null;
    readonly sourceWeightDue: number | null;
    readonly sourceWeightNear: number | null;
    readonly sourceWeightRandomMastered: number | null;
    readonly sourceWeightActiveRaw: number | null;
    readonly sourceWeightDueRaw: number | null;
    readonly sourceWeightNearRaw: number | null;
    readonly sourceWeightRandomMasteredRaw: number | null;
    readonly cardPriorityWeight: number | null;
    readonly retrievability: number | null;
    readonly intervalProgress: number | null;
    readonly candidateCount: number | null;
  };
  readonly deckState: {
    readonly schedulerPosition: number;
    readonly schedulerRevision: number;
    readonly desiredRetention: number;
    readonly policyVersion: string;
    readonly lastCriticalDuePosition: number | null;
    readonly masteredCount: number;
    readonly hasAchievedFullMastery: boolean;
  };
  readonly dailyGoal: { readonly enemiesDefeatedToday: number; readonly completed: boolean } | null;
  readonly card: {
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
    readonly lastPresentedSchedulerPosition: number | null;
    readonly sameDaySeenCount: number;
    readonly sameDayWrongCount: number;
    readonly sameDayProgressDate: string | null;
    readonly lastSeenAt: string | null;
  };
}

// =============================================================================
// Typed, validated AnswerContext.
// =============================================================================

export interface AnswerContextCard {
  readonly cardId: string;
  readonly cardStatus: CardStatus;
  readonly learningStage: LearningStage;
  readonly poolStatus: PoolStatus;
  readonly relearningPhase: RelearningPhase;
  readonly hasEverBeenMastered: boolean;
  readonly repairPending: boolean;
  readonly correctCooldownUntilPosition: number | null;
  readonly fsrsReviewCorrectCount: number;
  readonly fsrsReviewCorrectStreak: number;
  readonly repairObligation: RepairObligation | null;
  /** The mapped ts-fsrs Card -- for prepareLearningEngineAnswer's FSRS math only. For the trusted commit RPC's before-state optimistic lock, use the RAW fields below instead (see their own doc comment for why). */
  readonly fsrsCard: import("ts-fsrs").Card;
  /**
   * The raw `user_card_progress` FSRS columns, exactly as read -- NOT the
   * same as reading them back off `fsrsCard` above. `progressToFsrsCard`
   * is a lossless 1:1 copy for an ALREADY-reviewed card, but for a
   * never-reviewed one (`fsrsState === null`) it returns
   * `createEmptyCard(now)` instead -- a fabricated, `now`-dependent Card,
   * not a reflection of the raw (null) column values. The trusted
   * answer-commit RPC's optimistic lock compares against the raw locked
   * DB row byte-for-byte, so the snapshot sent back to it must be these
   * raw values, never a round-trip through the mapped Card object.
   */
  readonly fsrsDueAt: Date | null;
  readonly fsrsStability: number | null;
  readonly fsrsDifficulty: number | null;
  readonly fsrsElapsedDays: number;
  readonly fsrsScheduledDays: number;
  readonly fsrsReps: number;
  readonly fsrsLapses: number;
  readonly fsrsLearningSteps: number;
  readonly fsrsState: 0 | 1 | 2 | 3 | null;
  readonly fsrsLastReviewAt: Date | null;
  readonly lastPresentedSchedulerPosition: number | null;
  readonly sameDaySeenCount: number;
  readonly sameDayWrongCount: number;
  readonly sameDayProgressDate: string | null;
  readonly lastSeenAt: Date | null;
}

export interface AnswerContext {
  readonly userId: string;
  readonly deckId: string;
  readonly now: Date;
  readonly session: { readonly comboBefore: number; readonly enemyHpBefore: number | null; readonly totalAnswersBefore: number };
  readonly claim: {
    readonly id: string;
    readonly cardId: string;
    readonly selectionTraceId: string;
    readonly schedulerPosition: number;
    readonly schedulerRevision: number;
  };
  readonly trace: RawAnswerContext["trace"];
  readonly deckState: RawAnswerContext["deckState"];
  readonly dailyGoal: { readonly enemiesDefeatedToday: number; readonly completed: boolean };
  readonly card: AnswerContextCard;
}

function mapRepairObligation(raw: RawAnswerContext["card"]): RepairObligation | null {
  const positions = [raw.repairWrongPosition, raw.repairTargetPosition, raw.repairHardCapPosition];
  const presentCount = positions.filter((p) => p !== null).length;

  if (raw.repairPending) {
    if (presentCount !== 3) {
      throw new AnswerContextValidationError(
        `card ${raw.cardId}: repairPending is true but repair position fields are incomplete ` +
          `(wrong=${raw.repairWrongPosition}, target=${raw.repairTargetPosition}, hardCap=${raw.repairHardCapPosition})`,
      );
    }
    return {
      cardId: raw.cardId,
      wrongPosition: raw.repairWrongPosition as number,
      targetPosition: raw.repairTargetPosition as number,
      hardCapPosition: raw.repairHardCapPosition as number,
    };
  }

  if (presentCount !== 0) {
    throw new AnswerContextValidationError(
      `card ${raw.cardId}: repairPending is false but repair position fields are non-null ` +
        `(wrong=${raw.repairWrongPosition}, target=${raw.repairTargetPosition}, hardCap=${raw.repairHardCapPosition})`,
    );
  }
  return null;
}

function validateCardInvariants(raw: RawAnswerContext["card"]): void {
  if (raw.cardStatus === "LEARNING" && raw.learningStage === null) {
    throw new AnswerContextValidationError(`card ${raw.cardId}: cardStatus LEARNING requires a non-null learningStage`);
  }
  if (raw.cardStatus === "FORGOTTEN") {
    if (raw.relearningPhase === null) {
      throw new AnswerContextValidationError(`card ${raw.cardId}: cardStatus FORGOTTEN requires a non-null relearningPhase`);
    }
    if (raw.relearningPhase === "REPAIR_PENDING" && !raw.repairPending) {
      throw new AnswerContextValidationError(`card ${raw.cardId}: relearningPhase REPAIR_PENDING requires repairPending = true`);
    }
    if (raw.relearningPhase === "SPACED_CONFIRMATION_PENDING" && raw.repairPending) {
      throw new AnswerContextValidationError(`card ${raw.cardId}: relearningPhase SPACED_CONFIRMATION_PENDING requires repairPending = false`);
    }
  }
  if ((raw.cardStatus === "ACQUIRED" || raw.cardStatus === "LEARNED") && raw.poolStatus !== "OUTSIDE") {
    throw new AnswerContextValidationError(`card ${raw.cardId}: cardStatus ${raw.cardStatus} requires poolStatus = OUTSIDE`);
  }
}

function toFsrsRow(raw: RawAnswerContext["card"]): UserCardProgressFsrsRow {
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

/**
 * Maps the trusted RPC's raw jsonb result into a validated
 * `AnswerContext`. Throws `AnswerContextValidationError` for a
 * structurally impossible card state; throws a plain `Error` for a
 * missing `dailyGoal`/`card` object (should never happen given the RPC's
 * own `coalesce`/lazy-upsert guarantees -- defense-in-depth, not an
 * expected runtime path).
 */
export function mapRawAnswerContext(raw: RawAnswerContext): AnswerContext {
  if (raw.card === null || raw.card === undefined) {
    throw new Error("mapRawAnswerContext: card is null -- the trusted RPC should always return the claimed card's state");
  }

  validateCardInvariants(raw.card);
  const now = new Date(raw.now);
  const fsrsCard = progressToFsrsCard(toFsrsRow(raw.card), now);

  return {
    userId: raw.userId,
    deckId: raw.deckId,
    now,
    session: raw.session,
    claim: {
      id: raw.claim.id,
      cardId: raw.claim.cardId,
      selectionTraceId: raw.claim.selectionTraceId,
      schedulerPosition: raw.claim.schedulerPosition,
      schedulerRevision: raw.claim.schedulerRevision,
    },
    trace: raw.trace,
    deckState: raw.deckState,
    dailyGoal: raw.dailyGoal ?? { enemiesDefeatedToday: 0, completed: false },
    card: {
      cardId: raw.card.cardId,
      cardStatus: raw.card.cardStatus,
      learningStage: raw.card.learningStage,
      poolStatus: raw.card.poolStatus,
      relearningPhase: raw.card.relearningPhase,
      hasEverBeenMastered: raw.card.hasEverBeenMastered,
      repairPending: raw.card.repairPending,
      correctCooldownUntilPosition: raw.card.correctCooldownUntilPosition,
      fsrsReviewCorrectCount: raw.card.fsrsReviewCorrectCount,
      fsrsReviewCorrectStreak: raw.card.fsrsReviewCorrectStreak,
      repairObligation: mapRepairObligation(raw.card),
      fsrsCard,
      fsrsDueAt: raw.card.fsrsDueAt === null ? null : new Date(raw.card.fsrsDueAt),
      fsrsStability: raw.card.fsrsStability,
      fsrsDifficulty: raw.card.fsrsDifficulty,
      fsrsElapsedDays: raw.card.fsrsElapsedDays,
      fsrsScheduledDays: raw.card.fsrsScheduledDays,
      fsrsReps: raw.card.fsrsReps,
      fsrsLapses: raw.card.fsrsLapses,
      fsrsLearningSteps: raw.card.fsrsLearningSteps,
      fsrsState: raw.card.fsrsState,
      fsrsLastReviewAt: raw.card.fsrsLastReviewAt === null ? null : new Date(raw.card.fsrsLastReviewAt),
      lastPresentedSchedulerPosition: raw.card.lastPresentedSchedulerPosition,
      sameDaySeenCount: raw.card.sameDaySeenCount,
      sameDayWrongCount: raw.card.sameDayWrongCount,
      sameDayProgressDate: raw.card.sameDayProgressDate,
      lastSeenAt: raw.card.lastSeenAt === null ? null : new Date(raw.card.lastSeenAt),
    },
  };
}
