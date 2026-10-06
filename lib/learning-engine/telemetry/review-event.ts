/**
 * Learning Engine v1 -- review-event telemetry builder (Phase 8, remaining
 * scope after the Phase 8 schema review).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 8
 * (review event minimum fields), 9 (raw vs normalized source weights), 12
 * (FSRS R values), 13 (interval_progress/days_overdue), 14 (cards/seconds
 * since last seen), 15 (historical accuracy), 16 (repair history), 30
 * (behavioral event logging), 32 (binary input and future
 * personalization); and the approved migration's additive `answer_events`
 * columns (supabase/migrations/20261003000000_learning_engine_v1_telemetry.sql,
 * schema review: APPROVE AS-IS).
 *
 * ---------------------------------------------------------------------
 * Purity
 * ---------------------------------------------------------------------
 * Pure: no Supabase access, no `Date.now()` (every timestamp is a caller-
 * supplied `Date`), no generated IDs (`eventId`/`clientEventId` come from
 * the caller -- the same client_event_id idempotency key the legacy path
 * already uses, per this phase's brief section 21), no mutation of any
 * input. Every derived field below is computed ONLY from the explicit
 * inputs this module receives -- it never re-runs FSRS, never re-derives
 * a scheduler decision, and never fabricates a value for a field this
 * phase's own gap analysis found no authoritative source for (see
 * `cardsSinceLastSeen` below).
 *
 * ---------------------------------------------------------------------
 * FSRS telemetry (section 10/12 of this phase's brief)
 * ---------------------------------------------------------------------
 * `fsrsRBefore`/`fsrsRAfter` are accepted as caller-supplied, already-
 * derived numbers -- NOT recomputed here. Deriving R needs a full
 * `ts-fsrs` `Card` plus a scheduler instance (lib/learning-engine/fsrs/
 * adapter.ts's `deriveRetrievability`); requiring that FSRS-adapter-
 * specific shape here would pull FSRS domain types into a generic
 * telemetry builder for no benefit, since the orchestration layer that
 * calls this builder already has the `Card` and calls that adapter
 * directly for its own purposes. This module's job is only to CARRY the
 * already-derived value through to the telemetry row, never to invent
 * one when the caller passes `null` (section 12: "if R is not meaningful
 * for a within-day NEW/LEARNING event: store NULL rather than inventing a
 * value").
 *
 * `intervalProgress`/`daysOverdue`, by contrast, ARE derived here --
 * directly via lib/learning-engine/fsrs/due-classification.ts's
 * `computeIntervalProgress` (imported, never reimplemented), which takes
 * only two primitive numbers (no FSRS `Card`/scheduler construction
 * needed), so there is no equivalent reason to push that arithmetic back
 * out to every call site.
 *
 * ---------------------------------------------------------------------
 * `cardsSinceLastSeen`: RESOLVED (RC-C) -- closes the Runtime Cutover
 * TODO's `cards_since_last_seen` gap. Two genuinely distinct positions,
 * never conflated.
 * ---------------------------------------------------------------------
 * `cardsSinceLastSeen` means: the number of committed Learning Engine
 * questions presented strictly BETWEEN this card's previous presentation
 * and its CURRENT one. If the previous presentation was at position P and
 * this answer commits at position N (the locked pre-answer deck
 * scheduler_position + 1 -- the position THIS committed answer itself
 * occupies, matching every other "N intervening cards" rule in the spec,
 * e.g. active-priority.ts's applyCorrectCooldown): `max(0, N - P - 1)`.
 *
 * `N` here is deliberately NOT the same value as `position.schedulerPosition`
 * below (the PRE-answer SelectionTrace echo -- see ReviewEventPosition's
 * own doc comment). Collapsing the two would either (a) undercount
 * cardsSinceLastSeen by exactly one relative to every other position rule
 * in the engine (the bug this fix closes -- confirmed by direct
 * comparison against applyCorrectCooldown's own documented N+1..N+5
 * boundary), or (b) require loosening `answer_events.scheduler_position`'s
 * existing cross-check against its linked SelectionTrace, which remains
 * untouched and must stay the selection-time value. This is why
 * `cardsSinceLastSeen` draws its "current" operand from
 * `exposure.currentPresentationSchedulerPosition` (the committed
 * post-increment position, supplied by the caller -- this module has no
 * clock/DB access, so it cannot compute `N` itself) rather than from
 * `position.schedulerPosition` -- see `deriveCardsSinceLastSeen` below and
 * `ReviewEventExposureContext`'s own doc comment for the full contract.
 *
 * `previousPresentationSchedulerPosition: number | null` remains the
 * authoritative previous value (from `user_card_progress.
 * last_presented_scheduler_position`, read BEFORE this answer overwrites
 * it with `N`); `null` means no prior v1 presentation exists, and this
 * field stays `null` rather than inventing a session-local approximation
 * ("Do not derive a misleading value from session-local indexes if the
 * scheduler position is deck-global").
 */

import { computeIntervalProgress } from "@/lib/learning-engine/fsrs/due-classification";
import type { LearningEngineCardState } from "@/lib/learning-engine/state";
import type { SelectionTrace } from "@/lib/learning-engine/scheduler/next-card";

const SECONDS_PER_DAY = 24 * 60 * 60;

export interface ReviewEventIdentity {
  readonly clientEventId: string;
  readonly userId: string;
  readonly deckId: string;
  readonly cardId: string;
  readonly sessionId: string;
  readonly occurredAt: Date;
}

/**
 * Corrective migration (supabase/migrations/
 * 20261004000000_learning_engine_v1_telemetry_position_fields.sql)
 * follow-up: three genuinely distinct position concepts, never conflated
 * (section 11 of the normative spec):
 *   - `sessionPosition`: position within the current app Session --
 *     session-scoped, may restart in a later Session.
 *   - `schedulerPosition`/`schedulerRevision`: the deck-global Learning
 *     Engine scheduler_position/scheduler_revision
 *     (lib/learning-engine/scheduler/snapshot.ts's `DeckSchedulerState`)
 *     associated with the exact selection that produced this card --
 *     per-user-deck monotonic, never reset between Sessions. These two
 *     must be the PRE-answer/selection snapshot's own values (the
 *     `SelectionTrace`/`NextCardDecision` the trusted caller already has
 *     in hand), never a post-answer incremented value -- this module
 *     only ever passes them through unchanged from `position` below, it
 *     never derives or increments either.
 *
 * RUNTIME-CUTOVER ACCEPTANCE REQUIREMENT for `sessionPosition` -- CLOSED
 * (RC-C, confirmed RC-F): `schedulerPosition`/`schedulerRevision` get a
 * real cross-check today -- `insert_learning_engine_review_event`
 * (supabase/migrations/20261005000000_learning_engine_v1_telemetry_functions.sql)
 * rejects (42501) a review event whose `scheduler_position`/
 * `scheduler_revision` disagree with its linked `SelectionTrace`.
 * `sessionPosition` has no equivalent cross-check, by design: RC-C's live
 * caller (lib/learning-engine/runtime/commit-answer.ts) never accepts it
 * from the trusted caller as an independent value in the first place --
 * it sets `sessionPosition: context.session.totalAnswersBefore + 1`,
 * where `totalAnswersBefore` is `v_session.total_answers` read from the
 * locked `sessions` row inside the same trusted transaction
 * (20261013000000_learning_engine_v1_runtime_cutover_rc_c_answer_commit.sql).
 * There is nothing to cross-check because this builder's own caller never
 * passes a client-supplied `sessionPosition` through to begin with -- the
 * same server-derived-only treatment `userId` already gets in
 * lib/learning/commit-answer.ts. This module's own `position` parameter
 * type still accepts a bare number (so tests can still construct
 * arbitrary `ReviewEventPosition` values directly), but the one live
 * caller never sources that number from a client.
 *
 * `schedulerPosition` here stays the PRE-answer SelectionTrace echo even
 * after the RC-C `cardsSinceLastSeen` fix below -- see this module's
 * header. The committed (post-increment) position is instead threaded
 * through `ReviewEventExposureContext.currentPresentationSchedulerPosition`,
 * a deliberately separate field, so this one never has to mean two
 * different things depending which other field is being computed from it.
 */
export interface ReviewEventPosition {
  readonly sessionPosition: number;
  readonly schedulerPosition: number;
  readonly schedulerRevision: number;
}

export interface ReviewEventBehavior {
  readonly correct: boolean;
  readonly responseTimeMs: number;
  readonly timeToFirstActionMs: number | null;
}

export interface ReviewEventSelectionContext {
  readonly selectionTraceId: string | null;
  readonly source: SelectionTrace["source"];
  readonly selectionReason: SelectionTrace["selectionReason"];
  readonly schedulerMode: SelectionTrace["schedulerMode"];
  /** The weight the winning card was drawn with -- see SelectionTrace.cardPriorityWeight's own nullability rules. */
  readonly cardPriorityWeight: number | null;
  /** The candidate count for the selected source/path where meaningful; null where the concept does not apply (section 10 of this phase's brief). */
  readonly candidateCount: number | null;
  /** Normalized (actual sampling probability) source weights -- see this phase's approved decision in section 0 of the task brief. All null when not an ordinary weighted-draw context (e.g. repair_hard_cap). */
  readonly sourceWeightActive: number | null;
  readonly sourceWeightDue: number | null;
  readonly sourceWeightNear: number | null;
  readonly sourceWeightRandomMastered: number | null;
  /** Raw (pre-renormalization nominal policy) source weights -- same nullability as the normalized siblings above. */
  readonly sourceWeightActiveRaw: number | null;
  readonly sourceWeightDueRaw: number | null;
  readonly sourceWeightNearRaw: number | null;
  readonly sourceWeightRandomMasteredRaw: number | null;
}

export interface ReviewEventGoalContext {
  readonly dailyGoalCompleteBefore: boolean | null;
}

export interface ReviewEventExposureContext {
  readonly sameDaySeenCountBefore: number | null;
  readonly sameDayWrongCountBefore: number | null;
  /** The authoritative previous `last_presented_scheduler_position`, read BEFORE this answer overwrites it. Null means no prior v1 presentation exists -- see module header. */
  readonly previousPresentationSchedulerPosition: number | null;
  /**
   * RC-C: the position THIS committed answer itself occupies -- the
   * locked pre-answer deck `scheduler_position` + 1, i.e. the same value
   * the caller is about to persist as the new `last_presented_scheduler_
   * position` for this card. Deliberately NOT `ReviewEventPosition.
   * schedulerPosition` (the pre-answer SelectionTrace echo, which stays
   * selection-time-scoped and unrelated to this field) -- see this
   * module's header for why collapsing the two would undercount
   * `cardsSinceLastSeen` by one. This module has no clock/DB access, so
   * it cannot derive this value itself; the caller always knows it from
   * the locked scheduler state it is committing.
   */
  readonly currentPresentationSchedulerPosition: number;
  /** Authoritative `user_card_progress.last_seen_at` read BEFORE this answer's mutation. Null for a genuinely first-ever presentation. */
  readonly lastSeenAtBefore: Date | null;
}

export interface ReviewEventFsrsContext {
  readonly fsrsDBefore: number | null;
  readonly fsrsSBefore: number | null;
  /** Caller-derived via lib/learning-engine/fsrs/adapter.ts's deriveRetrievability -- see module header. */
  readonly fsrsRBefore: number | null;
  readonly fsrsDAfter: number | null;
  readonly fsrsSAfter: number | null;
  readonly fsrsRAfter: number | null;
  /**
   * Elapsed time and scheduled interval, BOTH IN DAYS (matching
   * lib/learning-engine/fsrs/due-classification.ts's own unit convention
   * for computeIntervalProgress) -- the quantities an OUTSIDE-pool card
   * genuinely has; null for an Active/within-day event where the concept
   * does not apply. Used to derive `intervalProgress`/`daysOverdue`/
   * `scheduledIntervalSec` below; never passed through unconverted.
   */
  readonly elapsedDays: number | null;
  readonly scheduledIntervalDays: number | null;
}

export interface ReviewEventMasteryContext {
  readonly fsrsReviewCorrectCountBefore: number;
  readonly fsrsReviewCorrectStreakBefore: number;
}

export interface ReviewEventPolicyContext {
  readonly policyVersion: string;
  readonly fsrsVersion: string;
  readonly parameterSetId: string | null;
  readonly experimentAssignmentId: string | null;
}

export interface BuildReviewEventInput {
  readonly identity: ReviewEventIdentity;
  readonly position: ReviewEventPosition;
  readonly behavior: ReviewEventBehavior;
  readonly selection: ReviewEventSelectionContext;
  readonly goal: ReviewEventGoalContext;
  readonly exposure: ReviewEventExposureContext;
  readonly fsrs: ReviewEventFsrsContext;
  readonly mastery: ReviewEventMasteryContext;
  readonly policy: ReviewEventPolicyContext;
  /** The authoritative card state immediately BEFORE this answer's transition was applied. */
  readonly beforeState: LearningEngineCardState;
  /** The authoritative card state immediately AFTER this answer's transition was applied. */
  readonly afterState: LearningEngineCardState;
}

/** One-to-one with the approved migration's additive `answer_events` v1 columns (camelCase mirror; lib/learning-engine/telemetry/dal.ts maps this to the RPC's snake_case parameters). */
export interface ReviewEventPersistencePayload {
  readonly clientEventId: string;
  readonly userId: string;
  readonly deckId: string;
  readonly cardId: string;
  readonly sessionId: string;
  readonly occurredAt: Date;

  readonly sessionPosition: number;
  readonly schedulerPosition: number;
  readonly schedulerRevision: number;

  readonly correct: boolean;
  readonly responseTimeMs: number;
  readonly timeToFirstActionMs: number | null;

  readonly selectionTraceId: string | null;
  readonly source: SelectionTrace["source"];
  readonly selectionReason: SelectionTrace["selectionReason"];
  readonly schedulerMode: SelectionTrace["schedulerMode"];

  readonly dailyGoalCompleteBefore: boolean | null;

  readonly cardStatusBefore: LearningEngineCardState["cardStatus"];
  readonly learningStageBefore: LearningEngineCardState["learningStage"];
  readonly cardStatusAfter: LearningEngineCardState["cardStatus"];
  readonly learningStageAfter: LearningEngineCardState["learningStage"];
  readonly hasEverBeenMastered: boolean;

  readonly sameDaySeenCountBefore: number | null;
  readonly sameDayWrongCountBefore: number | null;
  /** Null on every real caller today -- see module header's documented gap. */
  readonly cardsSinceLastSeen: number | null;
  readonly secondsSinceLastSeen: number | null;

  readonly repairPendingBefore: boolean;
  readonly isRepairRetry: boolean;
  readonly isStageAdvancingSuccess: boolean;

  readonly fsrsDBefore: number | null;
  readonly fsrsSBefore: number | null;
  readonly fsrsRBefore: number | null;
  readonly fsrsDAfter: number | null;
  readonly fsrsSAfter: number | null;
  readonly fsrsRAfter: number | null;

  readonly scheduledIntervalSec: number | null;
  readonly intervalProgress: number | null;
  readonly daysOverdue: number | null;

  readonly fsrsReviewCorrectCountBefore: number;
  readonly fsrsReviewCorrectStreakBefore: number;

  readonly sourceWeightActive: number | null;
  readonly sourceWeightDue: number | null;
  readonly sourceWeightNear: number | null;
  readonly sourceWeightRandomMastered: number | null;
  readonly sourceWeightActiveRaw: number | null;
  readonly sourceWeightDueRaw: number | null;
  readonly sourceWeightNearRaw: number | null;
  readonly sourceWeightRandomMasteredRaw: number | null;

  readonly cardPriorityWeight: number | null;
  readonly candidateCount: number | null;

  readonly policyVersion: string;
  readonly fsrsVersion: string;
  readonly parameterSetId: string | null;
  readonly experimentAssignmentId: string | null;
}

/**
 * Section 13 of this phase's brief: derive `intervalProgress`/
 * `daysOverdue`/`scheduledIntervalSec` together from the same two inputs,
 * so the null-handling (section 13: "NULL is preferable to a fake zero
 * ... for non-long-term Active events") is applied identically to all
 * three rather than risking drift between two separately-written guards.
 * `daysOverdue`'s 0 is a genuine computed fact (the card is not overdue
 * yet), not a fabricated default -- it is only ever returned when both
 * inputs are real, valid numbers.
 */
function deriveLongTermTiming(
  elapsedDays: number | null,
  scheduledIntervalDays: number | null,
): { readonly intervalProgress: number | null; readonly daysOverdue: number | null; readonly scheduledIntervalSec: number | null } {
  if (elapsedDays === null || scheduledIntervalDays === null) {
    return { intervalProgress: null, daysOverdue: null, scheduledIntervalSec: null };
  }

  const intervalProgress = computeIntervalProgress(elapsedDays, scheduledIntervalDays);
  if (intervalProgress === null) {
    return { intervalProgress: null, daysOverdue: null, scheduledIntervalSec: null };
  }

  return {
    intervalProgress,
    daysOverdue: Math.max(0, elapsedDays - scheduledIntervalDays),
    scheduledIntervalSec: Math.round(scheduledIntervalDays * SECONDS_PER_DAY),
  };
}

/** Section 14 of this phase's brief: authoritative pre-mutation `last_seen_at` only. Null for a genuinely first-ever presentation -- never a post-answer timestamp. */
function deriveSecondsSinceLastSeen(occurredAt: Date, lastSeenAtBefore: Date | null): number | null {
  if (lastSeenAtBefore === null) {
    return null;
  }
  return Math.round((occurredAt.getTime() - lastSeenAtBefore.getTime()) / 1000);
}

/**
 * RC-C: `max(0, currentPresentationSchedulerPosition -
 * previousPresentationSchedulerPosition - 1)` -- the number of committed
 * questions strictly between the two presentations. Null whenever the
 * caller has no authoritative previous position to supply (no prior v1
 * presentation). `currentPresentationSchedulerPosition` MUST be the
 * committed (post-increment) position -- see module header and
 * `ReviewEventExposureContext.currentPresentationSchedulerPosition`'s own
 * doc comment; passing the pre-answer SelectionTrace echo here instead
 * reproduces the exact off-by-one this fix closes. Exported so the
 * trusted answer-commit orchestration layer can unit-test/reuse this
 * exact formula without a second implementation.
 */
export function deriveCardsSinceLastSeen(
  currentPresentationSchedulerPosition: number,
  previousPresentationSchedulerPosition: number | null,
): number | null {
  if (previousPresentationSchedulerPosition === null) {
    return null;
  }
  return Math.max(0, currentPresentationSchedulerPosition - previousPresentationSchedulerPosition - 1);
}

/**
 * Section 17 of this phase's brief: the pure review-event builder.
 * Derives `isRepairRetry`/`isStageAdvancingSuccess` directly from the
 * before/after card-state comparison rather than from `selectionReason`
 * string-matching -- a more robust definition (correct regardless of
 * which specific reason label the scheduler used) that still matches the
 * spec's semantics exactly:
 *   - `isRepairRetry`: this Correct/Wrong resolved a repair that was
 *     already pending (either the within-day `repairPending` flag, or the
 *     long-term `relearningPhase === "REPAIR_PENDING"` state) -- true for
 *     both `repair_target`/`repair_hard_cap` (within-day) presentations
 *     and the first Correct that resolves a FORGOTTEN card's
 *     REPAIR_PENDING phase.
 *   - `isStageAdvancingSuccess`: a genuine learning_stage/card_status
 *     change caused by a Correct answer -- true for a normal stage-
 *     advancing Correct, the FRESH repair exception (which also advances
 *     stage, section 12.4), and a qualifying FSRS Correct that reaches
 *     first-time Mastery; false for a repair Correct that leaves
 *     learning_stage unchanged (section 12.3), a Near-Due/Random-Mastered
 *     Correct (card state is returned byte-for-byte unchanged, see
 *     lib/learning-engine/fsrs/lifecycle.ts), and every Wrong.
 */
export function buildReviewEvent(input: BuildReviewEventInput): ReviewEventPersistencePayload {
  const { identity, position, behavior, selection, goal, exposure, fsrs, mastery, policy, beforeState, afterState } =
    input;

  const { intervalProgress, daysOverdue, scheduledIntervalSec } = deriveLongTermTiming(
    fsrs.elapsedDays,
    fsrs.scheduledIntervalDays,
  );

  const isRepairRetry =
    behavior.correct && (beforeState.repairPending || beforeState.relearningPhase === "REPAIR_PENDING");
  const isStageAdvancingSuccess =
    behavior.correct &&
    (beforeState.learningStage !== afterState.learningStage || beforeState.cardStatus !== afterState.cardStatus);

  return {
    clientEventId: identity.clientEventId,
    userId: identity.userId,
    deckId: identity.deckId,
    cardId: identity.cardId,
    sessionId: identity.sessionId,
    occurredAt: identity.occurredAt,

    sessionPosition: position.sessionPosition,
    schedulerPosition: position.schedulerPosition,
    schedulerRevision: position.schedulerRevision,

    correct: behavior.correct,
    responseTimeMs: behavior.responseTimeMs,
    timeToFirstActionMs: behavior.timeToFirstActionMs,

    selectionTraceId: selection.selectionTraceId,
    source: selection.source,
    selectionReason: selection.selectionReason,
    schedulerMode: selection.schedulerMode,

    dailyGoalCompleteBefore: goal.dailyGoalCompleteBefore,

    cardStatusBefore: beforeState.cardStatus,
    learningStageBefore: beforeState.learningStage,
    cardStatusAfter: afterState.cardStatus,
    learningStageAfter: afterState.learningStage,
    hasEverBeenMastered: afterState.hasEverBeenMastered,

    sameDaySeenCountBefore: exposure.sameDaySeenCountBefore,
    sameDayWrongCountBefore: exposure.sameDayWrongCountBefore,
    cardsSinceLastSeen: deriveCardsSinceLastSeen(
      exposure.currentPresentationSchedulerPosition,
      exposure.previousPresentationSchedulerPosition,
    ),
    secondsSinceLastSeen: deriveSecondsSinceLastSeen(identity.occurredAt, exposure.lastSeenAtBefore),

    repairPendingBefore: beforeState.repairPending,
    isRepairRetry,
    isStageAdvancingSuccess,

    fsrsDBefore: fsrs.fsrsDBefore,
    fsrsSBefore: fsrs.fsrsSBefore,
    fsrsRBefore: fsrs.fsrsRBefore,
    fsrsDAfter: fsrs.fsrsDAfter,
    fsrsSAfter: fsrs.fsrsSAfter,
    fsrsRAfter: fsrs.fsrsRAfter,

    scheduledIntervalSec,
    intervalProgress,
    daysOverdue,

    fsrsReviewCorrectCountBefore: mastery.fsrsReviewCorrectCountBefore,
    fsrsReviewCorrectStreakBefore: mastery.fsrsReviewCorrectStreakBefore,

    sourceWeightActive: selection.sourceWeightActive,
    sourceWeightDue: selection.sourceWeightDue,
    sourceWeightNear: selection.sourceWeightNear,
    sourceWeightRandomMastered: selection.sourceWeightRandomMastered,
    sourceWeightActiveRaw: selection.sourceWeightActiveRaw,
    sourceWeightDueRaw: selection.sourceWeightDueRaw,
    sourceWeightNearRaw: selection.sourceWeightNearRaw,
    sourceWeightRandomMasteredRaw: selection.sourceWeightRandomMasteredRaw,

    cardPriorityWeight: selection.cardPriorityWeight,
    candidateCount: selection.candidateCount,

    policyVersion: policy.policyVersion,
    fsrsVersion: policy.fsrsVersion,
    parameterSetId: policy.parameterSetId,
    experimentAssignmentId: policy.experimentAssignmentId,
  };
}
