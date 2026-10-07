import "server-only";

/**
 * Learning Engine v1 -- Runtime Cutover RC-C: `commitLearningEngineAnswer`,
 * the trusted server-only orchestration function composing the already-
 * complete pure `prepareLearningEngineAnswer()`
 * (lib/learning-engine/runtime/prepare-answer.ts) with the trusted read/
 * commit RPCs (lib/learning-engine/runtime/{answer-context-mapper,
 * commit-answer-dal}.ts) and the existing Phase 8 review-event builder
 * (lib/learning-engine/telemetry/review-event.ts).
 *
 * Flow per call:
 *   A. READ -- the trusted answer-context RPC, mapped+validated by the
 *      pure answer-context-mapper. Finds the session's current OPEN
 *      claim; there is exactly one by construction (RC-B's own
 *      selection_claims_one_open_per_session_idx).
 *   B. PREPARE -- prepareLearningEngineAnswer(context, answer, now,
 *      random), zero DB access inside.
 *   C. TELEMETRY -- buildReviewEvent(), composing the context's
 *      selection-time fields with prepareLearningEngineAnswer's before/
 *      after card state and FSRS result -- never a second event format.
 *   D. COMMIT -- the trusted commit RPC, passed the prepared result plus
 *      the context's own before-state as the optimistic-concurrency
 *      token (RC-C pre-check A: the claim's own scheduler_position and
 *      the claimed card's own locked row -- never the deck-wide
 *      scheduler_revision).
 *
 * On a stale-snapshot rejection (commit-answer-dal.ts's
 * STALE_ANSWER_SNAPSHOT_SQLSTATE): re-read the answer context, re-run
 * prepareLearningEngineAnswer against the fresh context, retry the
 * commit. Bounded at MAX_COMMIT_ATTEMPTS -- never an unbounded loop,
 * mirroring claim-next-card.ts's own bounded-retry convention exactly.
 * Every OTHER rejection (ownership mismatch, a non-OPEN claim, a deleted
 * card, etc.) propagates immediately, unretried.
 *
 * Wiring (RC-D, reconfirmed RC-F): called live from
 * app/actions/answers.ts via lib/learning/engine-router.ts's
 * `submitAnswerForEngine`, which routes a v1 session's answer here and a
 * legacy session's answer to lib/learning/submit-answer.ts instead -- by
 * the session's own pinned engine_version, never client-chosen.
 */

import { prepareLearningEngineAnswer, type RandomSource } from "@/lib/learning-engine/runtime/prepare-answer";
import { mapRawAnswerContext, type AnswerContext, type AnswerContextCard } from "@/lib/learning-engine/runtime/answer-context-mapper";
import {
  fetchAnswerContext,
  fetchExistingAnswerEvent,
  commitLearningEngineAnswerRpc,
  LearningEngineAnswerCommitError,
  STALE_ANSWER_SNAPSHOT_SQLSTATE,
  type CommittedXpEventRow,
  type ExistingAnswerEventRow,
} from "@/lib/learning-engine/runtime/commit-answer-dal";
import { productionRandomSource } from "@/lib/learning-engine/runtime/random-source";
import { buildReviewEvent } from "@/lib/learning-engine/telemetry/review-event";
import type { ReviewEventPersistencePayload } from "@/lib/learning-engine/telemetry/review-event";
import { deriveRetrievability } from "@/lib/learning-engine/fsrs/adapter";
import { fsrsGradeToRatingText } from "@/lib/learning/commit-answer";
import { LEARNING_ENGINE_FSRS_VERSION } from "@/lib/learning-engine/config";
import type { LearningEngineCardState } from "@/lib/learning-engine/state";
import type { RepairObligation } from "@/lib/learning-engine/repair-scheduler";

export { LearningEngineAnswerCommitError };

/** Mirrors claim-next-card.ts's own bounded-retry convention. */
export const MAX_COMMIT_ATTEMPTS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SubmitLearningEngineAnswerInput {
  readonly clientEventId: string;
  readonly correct: boolean;
  readonly responseTimeMs: number;
  readonly timeToFirstActionMs: number | null;
}

/**
 * Runtime Cutover RC-D correction: the faithful Battle Engine result,
 * present on BOTH a fresh commit and a genuine replay -- never `null`.
 *
 * Fresh: sourced from this module's own pre-commit `prepared.battle`
 * (the exact values commit_learning_engine_v1_answer() independently
 * re-validated for structural consistency -- combo progression,
 * enemy-HP arithmetic, next-enemy fields on defeat -- before accepting
 * and persisting them).
 *
 * Replay: sourced from the HISTORICAL persisted `answer_events` row
 * (lib/learning-engine/runtime/commit-answer-dal.ts's
 * fetchExistingAnswerEvent()) -- never recomputed, never re-derived from
 * current session/card state. This is safe even when later answers have
 * since changed the session/deck's current Battle/scheduler state,
 * because it reads this ONE historical row by its own id, not anything
 * "current" (supabase/migrations/20261018000000_learning_engine_v1_battle_replay_fidelity.sql
 * persists base_damage/speed_bonus/critical/combo/damage/enemy_hp_before/
 * enemy_hp_after onto that exact row at commit time, fixing the gap
 * where commit_learning_engine_v1_answer() received these values as
 * parameters and re-validated them, but never wrote them --
 * insert_learning_engine_review_event() deliberately never names them at
 * all, see that function's own "Battle Engine concepts, not named by
 * this function at all" header comment).
 *
 * `newEnemyType`/`newEnemyMaxHp`/`newEnemyHp` remain `null` on replay --
 * NOT a residual gap, this mirrors legacy's own long-established replay
 * contract exactly (lib/learning/submit-answer.ts's
 * `SubmitAnswerReplaySuccess`: "new-enemy ... fields are NOT
 * reconstructable and are deliberately absent"). The new-enemy fields
 * are a `session`-row-derived, not an `answer_events`-row-derived,
 * concept for EITHER engine, and `session` is `null` on every replay by
 * design (RC-C's own replay branch never re-reads it).
 *
 * `correct` is deliberately NOT included here: the caller already has
 * it from its own input, on both fresh and replay.
 */
export interface CommitLearningEngineAnswerBattleResult {
  readonly damage: number;
  readonly critical: boolean;
  readonly comboAfter: number;
  readonly enemyHpAfter: number;
  readonly enemyDefeated: boolean;
  readonly newEnemyType: string | null;
  readonly newEnemyMaxHp: number | null;
  readonly newEnemyHp: number | null;
}

export interface CommitLearningEngineAnswerResult {
  readonly isReplay: boolean;
  readonly cardMasteredJustNow: boolean;
  readonly fullMasteryJustAchieved: boolean | null;
  readonly dailyGoalJustCompleted: boolean;
  readonly xpEvents: readonly CommittedXpEventRow[];
  readonly answerEvent: Record<string, unknown>;
  readonly userCardProgress: Record<string, unknown> | null;
  readonly session: Record<string, unknown> | null;
  readonly profile: Record<string, unknown> | null;
  readonly deckState: Record<string, unknown> | null;
  readonly battle: CommitLearningEngineAnswerBattleResult;
  /**
   * Runtime Cutover RC-D addition: the categorical rating for a FRESH
   * commit -- `null` on replay (unreconstructable, same RC-C gap as
   * `battle` above -- answer_events.fsrs_rating is never populated for a
   * v1 row either) AND `null` for a fresh commit whose card never
   * touched FSRS at all (prepareLearningEngineAnswer's `fsrsGrade` is
   * `null` for any answer that isn't an OUTSIDE-pool review -- the v1
   * Active Pool/repair mechanisms do not use an FSRS grade concept per
   * answer the way legacy's Review mode always does). Converted via
   * lib/learning/commit-answer.ts's fsrsGradeToRatingText -- not a
   * second inference, purely re-encoding the same decision
   * prepareLearningEngineAnswer already made.
   */
  readonly rating: "Again" | "Hard" | "Good" | "Easy" | null;
}

export class CommitRetryExhaustedError extends Error {
  constructor(attempts: number, cause: unknown) {
    super(`commitLearningEngineAnswer: exceeded ${attempts} bounded retry attempts under persistent stale-revision conflicts`, { cause });
    this.name = "CommitRetryExhaustedError";
  }
}

function isStaleSnapshotError(err: unknown): boolean {
  return err instanceof LearningEngineAnswerCommitError && err.code === STALE_ANSWER_SNAPSHOT_SQLSTATE;
}

/**
 * Runtime Cutover RC-D correction: reconstructs the faithful Battle
 * result for a replay from the HISTORICAL answer_events row -- never
 * from current session/card state, and never recomputed. Throws rather
 * than silently substituting a fabricated number if the persisted
 * columns are ever missing/malformed (same "loud rejection, never
 * silent repair" discipline this codebase's other mappers use) --
 * matches this project's "no placeholders" rule exactly as strictly as
 * the FRESH path's own validation does.
 *
 * `newEnemyType`/`newEnemyMaxHp`/`newEnemyHp` are always `null` here --
 * not a gap, see CommitLearningEngineAnswerBattleResult's own doc
 * comment (this mirrors legacy's own long-established replay contract).
 */
function battleResultFromHistoricalAnswerEvent(row: ExistingAnswerEventRow): CommitLearningEngineAnswerBattleResult {
  const damage = row.damage;
  const critical = row.critical;
  const comboAfter = row.combo;
  const enemyHpAfter = row.enemy_hp_after;

  if (typeof damage !== "number" || typeof critical !== "boolean" || typeof comboAfter !== "number" || typeof enemyHpAfter !== "number") {
    throw new Error(
      "battleResultFromHistoricalAnswerEvent: the historical answer_events row is missing a persisted Battle column " +
        `(damage=${String(damage)}, critical=${String(critical)}, combo=${String(comboAfter)}, enemy_hp_after=${String(enemyHpAfter)}) -- ` +
        "this row predates 20261018000000_learning_engine_v1_battle_replay_fidelity.sql and cannot be replayed faithfully.",
    );
  }

  return {
    damage,
    critical,
    comboAfter,
    enemyHpAfter,
    enemyDefeated: enemyHpAfter === 0,
    newEnemyType: null,
    newEnemyMaxHp: null,
    newEnemyHp: null,
  };
}

function cardStateFromContext(card: AnswerContextCard): LearningEngineCardState {
  return {
    cardStatus: card.cardStatus,
    learningStage: card.learningStage,
    poolStatus: card.poolStatus,
    relearningPhase: card.relearningPhase,
    hasEverBeenMastered: card.hasEverBeenMastered,
    repairPending: card.repairPending,
    fsrsReviewCorrectCount: card.fsrsReviewCorrectCount,
    fsrsReviewCorrectStreak: card.fsrsReviewCorrectStreak,
  };
}

/** The RAW (never round-tripped through a mapped ts-fsrs Card) optimistic-lock snapshot the trusted commit RPC compares the locked DB row against byte-for-byte -- see AnswerContextCard's own doc comment for why. */
function expectedCardBeforeJson(card: AnswerContextCard): Record<string, unknown> {
  return {
    cardStatus: card.cardStatus,
    learningStage: card.learningStage,
    poolStatus: card.poolStatus,
    relearningPhase: card.relearningPhase,
    hasEverBeenMastered: card.hasEverBeenMastered,
    repairPending: card.repairPending,
    fsrsReviewCorrectCount: card.fsrsReviewCorrectCount,
    fsrsReviewCorrectStreak: card.fsrsReviewCorrectStreak,
    correctCooldownUntilPosition: card.correctCooldownUntilPosition,
    repairWrongPosition: card.repairObligation?.wrongPosition ?? null,
    repairTargetPosition: card.repairObligation?.targetPosition ?? null,
    repairHardCapPosition: card.repairObligation?.hardCapPosition ?? null,
    fsrsDueAt: card.fsrsDueAt?.toISOString() ?? null,
    fsrsStability: card.fsrsStability,
    fsrsDifficulty: card.fsrsDifficulty,
    fsrsElapsedDays: card.fsrsElapsedDays,
    fsrsScheduledDays: card.fsrsScheduledDays,
    fsrsReps: card.fsrsReps,
    fsrsLapses: card.fsrsLapses,
    fsrsLearningSteps: card.fsrsLearningSteps,
    fsrsState: card.fsrsState,
    fsrsLastReviewAt: card.fsrsLastReviewAt?.toISOString() ?? null,
  };
}

function cardAfterJson(
  cardStateAfter: LearningEngineCardState,
  correctCooldownUntilPositionAfter: number | null,
  fsrsUpdate: ReturnType<typeof prepareLearningEngineAnswer>["fsrsUpdate"],
): Record<string, unknown> {
  return {
    cardStatus: cardStateAfter.cardStatus,
    learningStage: cardStateAfter.learningStage,
    poolStatus: cardStateAfter.poolStatus,
    relearningPhase: cardStateAfter.relearningPhase,
    hasEverBeenMastered: cardStateAfter.hasEverBeenMastered,
    fsrsReviewCorrectCount: cardStateAfter.fsrsReviewCorrectCount,
    fsrsReviewCorrectStreak: cardStateAfter.fsrsReviewCorrectStreak,
    correctCooldownUntilPosition: correctCooldownUntilPositionAfter,
    fsrsTouched: fsrsUpdate !== null,
    fsrsDueAt: fsrsUpdate?.fsrs_due_at.toISOString() ?? null,
    fsrsStability: fsrsUpdate?.fsrs_stability ?? null,
    fsrsDifficulty: fsrsUpdate?.fsrs_difficulty ?? null,
    fsrsElapsedDays: fsrsUpdate?.fsrs_elapsed_days ?? null,
    fsrsScheduledDays: fsrsUpdate?.fsrs_scheduled_days ?? null,
    fsrsReps: fsrsUpdate?.fsrs_reps ?? null,
    fsrsLapses: fsrsUpdate?.fsrs_lapses ?? null,
    fsrsLearningSteps: fsrsUpdate?.fsrs_learning_steps ?? null,
    fsrsState: fsrsUpdate?.fsrs_state ?? null,
    fsrsLastReviewAt: fsrsUpdate?.fsrs_last_review_at.toISOString() ?? null,
  };
}

function repairObligationAfterJson(obligation: RepairObligation | null): Record<string, unknown> | null {
  if (obligation === null) {
    return null;
  }
  return { wrongPosition: obligation.wrongPosition, targetPosition: obligation.targetPosition, hardCapPosition: obligation.hardCapPosition };
}

/** Section 12/13 of the Phase 8 brief: elapsed/scheduled days, both in days, ONLY meaningful for an OUTSIDE-pool card -- null otherwise (never a fabricated value for a within-day Active/repair event). */
function fsrsTimingBefore(context: AnswerContext): { elapsedDays: number | null; scheduledIntervalDays: number | null; rBefore: number | null } {
  if (context.card.poolStatus !== "OUTSIDE") {
    return { elapsedDays: null, scheduledIntervalDays: null, rBefore: null };
  }
  const { fsrsCard } = context.card;
  const elapsedDays = fsrsCard.last_review === undefined ? null : (context.now.getTime() - fsrsCard.last_review.getTime()) / MS_PER_DAY;
  return {
    elapsedDays,
    scheduledIntervalDays: fsrsCard.scheduled_days,
    rBefore: deriveRetrievability(fsrsCard, context.now),
  };
}

function buildReviewEventPayload(
  context: AnswerContext,
  sessionId: string,
  answer: SubmitLearningEngineAnswerInput,
  prepared: ReturnType<typeof prepareLearningEngineAnswer>,
  newSchedulerPosition: number,
): ReviewEventPersistencePayload {
  const { elapsedDays, scheduledIntervalDays, rBefore } = fsrsTimingBefore(context);
  const rAfter =
    prepared.fsrsUpdate !== null
      ? deriveRetrievability(
          {
            due: prepared.fsrsUpdate.fsrs_due_at,
            stability: prepared.fsrsUpdate.fsrs_stability,
            difficulty: prepared.fsrsUpdate.fsrs_difficulty,
            elapsed_days: prepared.fsrsUpdate.fsrs_elapsed_days,
            scheduled_days: prepared.fsrsUpdate.fsrs_scheduled_days,
            learning_steps: prepared.fsrsUpdate.fsrs_learning_steps,
            reps: prepared.fsrsUpdate.fsrs_reps,
            lapses: prepared.fsrsUpdate.fsrs_lapses,
            state: prepared.fsrsUpdate.fsrs_state,
            last_review: prepared.fsrsUpdate.fsrs_last_review_at,
          },
          context.now,
        )
      : null;

  return buildReviewEvent({
    identity: {
      clientEventId: answer.clientEventId,
      userId: context.userId,
      deckId: context.deckId,
      cardId: context.claim.cardId,
      sessionId,
      occurredAt: context.now,
    },
    position: {
      sessionPosition: context.session.totalAnswersBefore + 1,
      schedulerPosition: context.claim.schedulerPosition,
      schedulerRevision: context.claim.schedulerRevision,
    },
    behavior: { correct: answer.correct, responseTimeMs: answer.responseTimeMs, timeToFirstActionMs: answer.timeToFirstActionMs },
    selection: {
      selectionTraceId: context.claim.selectionTraceId,
      source: context.trace.source,
      selectionReason: context.trace.selectionReason,
      schedulerMode: context.trace.schedulerMode,
      cardPriorityWeight: context.trace.cardPriorityWeight,
      candidateCount: context.trace.candidateCount,
      sourceWeightActive: context.trace.sourceWeightActive,
      sourceWeightDue: context.trace.sourceWeightDue,
      sourceWeightNear: context.trace.sourceWeightNear,
      sourceWeightRandomMastered: context.trace.sourceWeightRandomMastered,
      sourceWeightActiveRaw: context.trace.sourceWeightActiveRaw,
      sourceWeightDueRaw: context.trace.sourceWeightDueRaw,
      sourceWeightNearRaw: context.trace.sourceWeightNearRaw,
      sourceWeightRandomMasteredRaw: context.trace.sourceWeightRandomMasteredRaw,
    },
    goal: { dailyGoalCompleteBefore: context.dailyGoal.completed },
    exposure: {
      sameDaySeenCountBefore: context.card.sameDaySeenCount,
      sameDayWrongCountBefore: context.card.sameDayWrongCount,
      previousPresentationSchedulerPosition: context.card.lastPresentedSchedulerPosition,
      currentPresentationSchedulerPosition: newSchedulerPosition,
      lastSeenAtBefore: context.card.lastSeenAt,
    },
    fsrs: { fsrsDBefore: context.card.fsrsDifficulty, fsrsSBefore: context.card.fsrsStability, fsrsRBefore: rBefore, fsrsDAfter: prepared.fsrsUpdate?.fsrs_difficulty ?? null, fsrsSAfter: prepared.fsrsUpdate?.fsrs_stability ?? null, fsrsRAfter: rAfter, elapsedDays, scheduledIntervalDays },
    mastery: { fsrsReviewCorrectCountBefore: context.card.fsrsReviewCorrectCount, fsrsReviewCorrectStreakBefore: context.card.fsrsReviewCorrectStreak },
    policy: { policyVersion: context.deckState.policyVersion, fsrsVersion: LEARNING_ENGINE_FSRS_VERSION, parameterSetId: null, experimentAssignmentId: null },
    beforeState: cardStateFromContext(context.card),
    afterState: prepared.cardStateAfter,
    repairObligationAfter: prepared.repairObligationAfter,
    correctCooldownUntilPositionAfter: prepared.correctCooldownUntilPositionAfter,
  });
}

function reviewEventRpcPayload(payload: ReviewEventPersistencePayload): Record<string, unknown> {
  return {
    timeToFirstActionMs: payload.timeToFirstActionMs,
    cardsSinceLastSeen: payload.cardsSinceLastSeen,
    secondsSinceLastSeen: payload.secondsSinceLastSeen,
    isRepairRetry: payload.isRepairRetry,
    isStageAdvancingSuccess: payload.isStageAdvancingSuccess,
    repairPendingAfter: payload.repairPendingAfter,
    repairTargetPositionAfter: payload.repairTargetPositionAfter,
    repairHardCapPositionAfter: payload.repairHardCapPositionAfter,
    correctCooldownUntilPositionAfter: payload.correctCooldownUntilPositionAfter,
    fsrsDBefore: payload.fsrsDBefore,
    fsrsSBefore: payload.fsrsSBefore,
    fsrsRBefore: payload.fsrsRBefore,
    fsrsDAfter: payload.fsrsDAfter,
    fsrsSAfter: payload.fsrsSAfter,
    fsrsRAfter: payload.fsrsRAfter,
    scheduledIntervalSec: payload.scheduledIntervalSec,
    intervalProgress: payload.intervalProgress,
    daysOverdue: payload.daysOverdue,
    sourceWeightActive: payload.sourceWeightActive,
    sourceWeightDue: payload.sourceWeightDue,
    sourceWeightNear: payload.sourceWeightNear,
    sourceWeightRandomMastered: payload.sourceWeightRandomMastered,
    sourceWeightActiveRaw: payload.sourceWeightActiveRaw,
    sourceWeightDueRaw: payload.sourceWeightDueRaw,
    sourceWeightNearRaw: payload.sourceWeightNearRaw,
    sourceWeightRandomMasteredRaw: payload.sourceWeightRandomMasteredRaw,
    candidateCount: payload.candidateCount,
    policyVersion: payload.policyVersion,
    fsrsVersion: payload.fsrsVersion,
    parameterSetId: payload.parameterSetId,
    experimentAssignmentId: payload.experimentAssignmentId,
  };
}

/**
 * The trusted runtime primitive. `claimId` is always already held by the
 * caller -- the same identifier `claimNextLearningEngineCard()` returned
 * for the card currently being answered (never rediscovered as "whichever
 * claim happens to be open", see answer-context-mapper.ts's own header
 * for why). `random` defaults to the production RandomSource
 * (Math.random) but is overridable for deterministic tests.
 *
 * Idempotency pre-check FIRST, before any read/prepare/commit attempt --
 * mirrors every other trusted answer-commit function in this codebase.
 * This matters beyond mere efficiency: a genuine replay is submitted
 * AFTER the original call already advanced this claim to ANSWERED, so
 * re-running prepareLearningEngineAnswer against the now-mutated card
 * could violate a pure transition function's own precondition invariant
 * (e.g. a resolved repair's repairPending now reads false) -- the
 * trusted commit RPC's own replay branch would still catch this
 * correctly, but only if TypeScript never throws first trying to get
 * there.
 */
export async function commitLearningEngineAnswer(
  userId: string,
  sessionId: string,
  claimId: string,
  answer: SubmitLearningEngineAnswerInput,
  random: RandomSource = productionRandomSource,
): Promise<CommitLearningEngineAnswerResult> {
  const existing = await fetchExistingAnswerEvent(answer.clientEventId);
  if (existing !== null) {
    if (existing.answerEvent.user_id !== userId || existing.answerEvent.session_id !== sessionId) {
      throw new LearningEngineAnswerCommitError(
        `client_event_id ${answer.clientEventId} already recorded for a different user/session`,
        { code: "42501", cause: undefined },
      );
    }
    return {
      isReplay: true,
      cardMasteredJustNow: existing.xpEvents.some((e) => e.reason === "card_learned" || e.reason === "card_relearned"),
      fullMasteryJustAchieved: null,
      dailyGoalJustCompleted: existing.xpEvents.some((e) => e.reason === "daily_goal_completed"),
      xpEvents: existing.xpEvents,
      answerEvent: existing.answerEvent,
      userCardProgress: null,
      session: null,
      profile: null,
      deckState: null,
      battle: battleResultFromHistoricalAnswerEvent(existing.answerEvent),
      // rating remains unreconstructable on replay (orthogonal to this
      // correction -- answer_events.fsrs_rating is never populated for a
      // v1 row at all, fresh or replayed; out of RC-D's Battle-fidelity
      // scope).
      rating: null,
    };
  }

  let lastStaleError: unknown;

  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const raw = await fetchAnswerContext(userId, sessionId, claimId);
    const context = mapRawAnswerContext(raw);

    const newSchedulerPosition = context.claim.schedulerPosition + 1;

    const prepared = prepareLearningEngineAnswer({
      cardId: context.claim.cardId,
      cardState: cardStateFromContext(context.card),
      fsrsCard: context.card.fsrsCard,
      selectionReason: context.trace.selectionReason,
      desiredRetention: context.deckState.desiredRetention,
      newSchedulerPosition,
      correct: answer.correct,
      responseTimeMs: answer.responseTimeMs,
      comboBefore: context.session.comboBefore,
      enemyHpBefore: context.session.enemyHpBefore ?? 0,
      random,
      now: context.now,
    });

    const reviewEventPayload = buildReviewEventPayload(context, sessionId, answer, prepared, newSchedulerPosition);

    try {
      const result = await commitLearningEngineAnswerRpc({
        clientEventId: answer.clientEventId,
        userId,
        sessionId,
        claimId: context.claim.id,
        cardId: context.claim.cardId,

        expectedSchedulerPosition: context.claim.schedulerPosition,
        expectedCardBefore: expectedCardBeforeJson(context.card),
        expectedSessionComboBefore: context.session.comboBefore,
        expectedSessionEnemyHpBefore: context.session.enemyHpBefore,

        cardAfter: cardAfterJson(prepared.cardStateAfter, prepared.correctCooldownUntilPositionAfter, prepared.fsrsUpdate),
        repairObligationAfter: repairObligationAfterJson(prepared.repairObligationAfter),

        correct: answer.correct,
        responseTimeMs: answer.responseTimeMs,
        baseDamage: prepared.battle.baseDamage,
        speedBonus: prepared.battle.speedBonus,
        critical: prepared.battle.critical,
        comboAfter: prepared.battle.comboAfter,
        damage: prepared.battle.damage,
        enemyHpAfter: prepared.battle.enemyHpAfter,
        enemyDefeated: prepared.battle.enemyDefeated,
        newEnemyType: prepared.battle.newEnemyType,
        newEnemyMaxHp: prepared.battle.newEnemyMaxHp,
        newEnemyHp: prepared.battle.newEnemyHp,

        reviewEvent: reviewEventRpcPayload(reviewEventPayload),
      });

      return {
        isReplay: result.is_replay,
        cardMasteredJustNow: result.card_mastered_just_now,
        fullMasteryJustAchieved: result.full_mastery_just_achieved,
        dailyGoalJustCompleted: result.daily_goal_just_completed,
        xpEvents: result.xp_events,
        answerEvent: result.answer_event,
        userCardProgress: result.user_card_progress,
        session: result.session,
        profile: result.profile,
        deckState: result.deck_state,
        battle: {
          damage: prepared.battle.damage,
          critical: prepared.battle.critical,
          comboAfter: prepared.battle.comboAfter,
          enemyHpAfter: prepared.battle.enemyHpAfter,
          enemyDefeated: prepared.battle.enemyDefeated,
          newEnemyType: prepared.battle.newEnemyType,
          newEnemyMaxHp: prepared.battle.newEnemyMaxHp,
          newEnemyHp: prepared.battle.newEnemyHp,
        },
        rating: prepared.fsrsGrade === null ? null : fsrsGradeToRatingText(prepared.fsrsGrade),
      };
    } catch (err) {
      if (isStaleSnapshotError(err)) {
        lastStaleError = err;
        continue;
      }
      throw err;
    }
  }

  throw new CommitRetryExhaustedError(MAX_COMMIT_ATTEMPTS, lastStaleError);
}
