/**
 * Learning Engine v1 -- selection-trace telemetry serializer (Phase 8 of
 * the implementation plan, remaining scope after the Phase 8 schema
 * review).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 29
 * ("Data model requirements") and 30 ("Behavioral event logging"), and the
 * approved migration supabase/migrations/
 * 20261003000000_learning_engine_v1_telemetry.sql's
 * `learning_engine_selection_traces` table (schema review: APPROVE AS-IS).
 *
 * ---------------------------------------------------------------------
 * Purity (spec section 41.4 / this phase's brief section 5-6)
 * ---------------------------------------------------------------------
 * This module is a PURE mapping from an already-computed
 * lib/learning-engine/scheduler/next-card.ts `SelectionTrace` (plus
 * trusted identity/session metadata the trusted caller already knows) to
 * the exact column shape `learning_engine_selection_traces` expects. It
 * performs:
 *   - no DB access;
 *   - no clock reads (`selectedAt` is supplied by the caller -- see
 *     chooseNextCard()'s own `DeckSchedulerSnapshot.now`, which the
 *     trusted caller already has);
 *   - no UUID generation (`traceId` is supplied by the caller -- section 5
 *     of the normative spec: "the trusted caller/persistence layer owns
 *     trace_id... tests should be able to supply deterministic IDs");
 *   - no mutation of its input;
 *   - no recomputation of any scheduler decision -- every value below is
 *     read directly off `trace`, never re-derived.
 *
 * ---------------------------------------------------------------------
 * trace_payload semantics (this phase's brief section 7)
 * ---------------------------------------------------------------------
 * `tracePayload` is a canonical, complete JSON mirror of this same
 * decision -- for historical/debugging round-trip fidelity ONLY. It is
 * NOT authoritative scheduler state; authoritative state remains
 * `user_card_progress` / `user_deck_learning_state` (current) and
 * whatever a future trusted claim/commit path persists (future). A reader
 * must never treat `trace_payload` as a live scheduler source of truth.
 */

import type { SelectionTrace } from "@/lib/learning-engine/scheduler/next-card";

/**
 * Trusted metadata the persistence layer supplies alongside the pure
 * `SelectionTrace` the scheduler produced -- never computed by
 * chooseNextCard() itself (section 5 of the normative spec).
 */
export interface SelectionTraceTrustedContext {
  readonly traceId: string;
  readonly userId: string;
  readonly deckId: string;
  readonly sessionId: string;
  readonly selectedAt: Date;
}

export interface SerializeSelectionTraceInput {
  readonly trace: SelectionTrace;
  readonly context: SelectionTraceTrustedContext;
}

/**
 * One-to-one with `learning_engine_selection_traces`'s typed columns
 * (camelCase mirror; lib/learning-engine/telemetry/dal.ts maps this to the
 * RPC's snake_case parameter names, the same split
 * lib/learning/commit-answer.ts's `CommitAnswerInput` / `toRpcParams`
 * already establishes for the legacy answer path).
 */
export interface SelectionTracePersistencePayload {
  readonly id: string;
  readonly userId: string;
  readonly deckId: string;
  readonly cardId: string | null;
  readonly sessionId: string;
  readonly occurredAt: Date;

  readonly schedulerPosition: number;
  readonly schedulerRevision: number;

  readonly source: SelectionTrace["source"];
  readonly selectionReason: SelectionTrace["selectionReason"];
  readonly schedulerMode: SelectionTrace["schedulerMode"];

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

  readonly admittedCardIds: readonly string[];

  readonly firstPassQueueBefore: readonly string[] | null;
  readonly firstPassQueueAfter: readonly string[] | null;
  readonly postMasteryShuffleBagBefore: readonly string[] | null;
  readonly postMasteryShuffleBagAfter: readonly string[] | null;

  readonly emergencyFallbackApplied: boolean;
  readonly randomDraws: readonly number[];

  readonly policyVersion: string;

  /** Canonical full mirror for debugging/round-trip fidelity -- see module header. JSON-safe (dates as ISO strings). */
  readonly tracePayload: Readonly<Record<string, unknown>>;
}

/**
 * Builds the canonical JSON mirror (section 4 of the Phase 8 brief: "a
 * reasonable design is queryable typed columns + a canonical JSONB
 * trace_payload"). Includes both the trusted context and the original
 * `SelectionTrace` fields verbatim (camelCase, as chooseNextCard()
 * produced them) so a reader can always reconstruct exactly what was
 * persisted without cross-referencing typed columns -- deliberately
 * redundant with them, never the only storage for a filterable field (the
 * typed columns above already serve that purpose).
 */
function buildTracePayload(
  trace: SelectionTrace,
  context: SelectionTraceTrustedContext,
): Readonly<Record<string, unknown>> {
  return {
    traceId: context.traceId,
    userId: context.userId,
    deckId: context.deckId,
    sessionId: context.sessionId,
    selectedAt: context.selectedAt.toISOString(),
    cardId: trace.cardId,
    source: trace.source,
    selectionReason: trace.selectionReason,
    schedulerMode: trace.schedulerMode,
    schedulerPosition: trace.schedulerPosition,
    schedulerRevision: trace.schedulerRevision,
    dueCount: trace.dueCount,
    dailyGoalCompleteBefore: trace.dailyGoalCompleteBefore,
    sourceWeightsRaw: trace.sourceWeightsRaw,
    sourceWeightsNormalized: trace.sourceWeightsNormalized,
    candidateCounts: trace.candidateCounts,
    cardPriorityWeight: trace.cardPriorityWeight,
    retrievability: trace.retrievability,
    intervalProgress: trace.intervalProgress,
    admittedCardIds: trace.admittedCardIds,
    policyVersion: trace.policyVersion,
    emergencyFallbackApplied: trace.emergencyFallbackApplied,
    firstPassQueueBefore: trace.firstPassQueueBefore,
    firstPassQueueAfter: trace.firstPassQueueAfter,
    postMasteryShuffleBagBefore: trace.postMasteryShuffleBagBefore,
    postMasteryShuffleBagAfter: trace.postMasteryShuffleBagAfter,
    randomDraws: trace.randomDraws,
  };
}

/**
 * The pure serializer itself. See module header for the full purity
 * contract and the no-invention rule (this phase's brief section 6: "Do
 * not invent telemetry values not present in the trusted trace").
 */
export function serializeSelectionTrace(
  input: SerializeSelectionTraceInput,
): SelectionTracePersistencePayload {
  const { trace, context } = input;

  return {
    id: context.traceId,
    userId: context.userId,
    deckId: context.deckId,
    cardId: trace.cardId,
    sessionId: context.sessionId,
    occurredAt: context.selectedAt,

    schedulerPosition: trace.schedulerPosition,
    schedulerRevision: trace.schedulerRevision,

    source: trace.source,
    selectionReason: trace.selectionReason,
    schedulerMode: trace.schedulerMode,

    dueCount: trace.dueCount,
    dailyGoalCompleteBefore: trace.dailyGoalCompleteBefore,

    candidateCountActive: trace.candidateCounts.active,
    candidateCountDue: trace.candidateCounts.due,
    candidateCountNear: trace.candidateCounts.near,
    candidateCountRandomMastered: trace.candidateCounts.randomMastered,

    sourceWeightActiveRaw: trace.sourceWeightsRaw.active,
    sourceWeightDueRaw: trace.sourceWeightsRaw.due,
    sourceWeightNearRaw: trace.sourceWeightsRaw.near,
    sourceWeightRandomMasteredRaw: trace.sourceWeightsRaw.randomMastered,
    sourceWeightActiveNormalized: trace.sourceWeightsNormalized.active,
    sourceWeightDueNormalized: trace.sourceWeightsNormalized.due,
    sourceWeightNearNormalized: trace.sourceWeightsNormalized.near,
    sourceWeightRandomMasteredNormalized: trace.sourceWeightsNormalized.randomMastered,

    cardPriorityWeight: trace.cardPriorityWeight,
    retrievability: trace.retrievability,
    intervalProgress: trace.intervalProgress,

    admittedCardIds: trace.admittedCardIds,

    firstPassQueueBefore: trace.firstPassQueueBefore,
    firstPassQueueAfter: trace.firstPassQueueAfter,
    postMasteryShuffleBagBefore: trace.postMasteryShuffleBagBefore,
    postMasteryShuffleBagAfter: trace.postMasteryShuffleBagAfter,

    emergencyFallbackApplied: trace.emergencyFallbackApplied,
    randomDraws: trace.randomDraws,

    policyVersion: trace.policyVersion,

    tracePayload: buildTracePayload(trace, context),
  };
}
