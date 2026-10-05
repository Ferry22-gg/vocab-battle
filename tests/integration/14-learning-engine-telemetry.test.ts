import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, pickCards, type ProvisionedTester } from "./fixtures/provision";
import { TELEMETRY_TESTER_A, TELEMETRY_TESTER_B } from "./fixtures/identities";
import { createAdminClient } from "./admin-client";
import { getAnswerEventByClientEventIdAdmin, countAnswerEventsByClientEventId } from "./db-assertions";
import { clearRlsClient, setRlsClient } from "./rls-client-context";
import { serializeSelectionTrace } from "@/lib/learning-engine/telemetry/selection-trace";
import { buildReviewEvent } from "@/lib/learning-engine/telemetry/review-event";
import {
  LearningEngineTelemetryError,
  persistReviewEvent,
  persistSelectionTrace,
} from "@/lib/learning-engine/telemetry/dal";
import type { SelectionTracePersistencePayload } from "@/lib/learning-engine/telemetry/selection-trace";
import type { ReviewEventPersistencePayload } from "@/lib/learning-engine/telemetry/review-event";
import { INITIAL_CARD_STATE } from "@/lib/learning-engine/state";
import { applyFirstPresentation, applyNormalCorrect } from "@/lib/learning-engine/transitions";
import type { SelectionTrace } from "@/lib/learning-engine/scheduler/next-card";

const { runSubmitAnswer, defaultSubmitAnswerDeps } = await import("@/lib/learning/submit-answer");

/**
 * Integration tests for Learning Engine v1 Phase 8 telemetry persistence
 * (remaining scope after the Phase 8 schema review), against the REAL
 * local Supabase stack -- the pure serializers/builders are already
 * covered by unit tests; cross-entity rejection and idempotency are
 * already covered exhaustively by supabase/tests/
 * 017_learning_engine_v1_telemetry_test.sql's 56 pgTAP assertions. This
 * file's job is narrower: prove the TypeScript DAL (lib/learning-engine/
 * telemetry/dal.ts) composes correctly end-to-end with the pure builders
 * against a real database, and that the legacy path remains completely
 * unaffected.
 */
describe("Learning Engine v1 Phase 8 telemetry persistence (real local Supabase)", () => {
  let testerA: ProvisionedTester;
  let testerB: ProvisionedTester;
  let sessionAId: string;
  let sessionBId: string;

  beforeAll(async () => {
    await resetTesterLearnerData(TELEMETRY_TESTER_A);
    await resetTesterLearnerData(TELEMETRY_TESTER_B);
    testerA = await provisionTesterWithDeck(TELEMETRY_TESTER_A);
    testerB = await provisionTesterWithDeck(TELEMETRY_TESTER_B);
    sessionAId = (await startOrResumeSessionFor(testerA)).id;
    sessionBId = (await startOrResumeSessionFor(testerB)).id;
  });

  afterAll(async () => {
    // Scoped cleanup only -- never a DB reset. deleteOwnedLearnerData
    // (via resetTesterLearnerData) already handles
    // learning_engine_selection_traces/answer_events/sessions/cards/decks
    // for these two testers; teardownIntegrationFixtures (global teardown)
    // removes the auth users/profiles themselves at the end of the whole
    // suite.
    await resetTesterLearnerData(TELEMETRY_TESTER_A);
    await resetTesterLearnerData(TELEMETRY_TESTER_B);
  });

  const BASE_WEIGHTS = { active: 0, due: 0, near: 0, randomMastered: 0 };
  const BASE_CANDIDATES = { active: 0, due: 0, near: 0, randomMastered: 0 };

  function makeTrace(overrides: Partial<SelectionTrace>): SelectionTrace {
    return {
      cardId: null,
      source: "ACTIVE",
      selectionReason: "active_weighted_selection",
      schedulerMode: "pre_goal_balanced",
      schedulerPosition: 1,
      schedulerRevision: 0,
      dueCount: 0,
      dailyGoalCompleteBefore: false,
      sourceWeightsRaw: BASE_WEIGHTS,
      sourceWeightsNormalized: BASE_WEIGHTS,
      candidateCounts: BASE_CANDIDATES,
      cardPriorityWeight: null,
      retrievability: null,
      intervalProgress: null,
      admittedCardIds: [],
      policyVersion: "learning-engine-v1.0",
      emergencyFallbackApplied: false,
      firstPassQueueBefore: null,
      firstPassQueueAfter: null,
      postMasteryShuffleBagBefore: null,
      postMasteryShuffleBagAfter: null,
      randomDraws: [],
      ...overrides,
    };
  }

  async function persistTestTrace(
    tester: ProvisionedTester,
    sessionId: string,
    overrides: Partial<SelectionTrace>,
  ): Promise<{ traceId: string; payload: SelectionTracePersistencePayload }> {
    const traceId = crypto.randomUUID();
    const trace = makeTrace(overrides);
    const payload = serializeSelectionTrace({
      trace,
      context: {
        traceId,
        userId: tester.userId,
        deckId: tester.deckId,
        sessionId,
        selectedAt: new Date(),
      },
    });
    await persistSelectionTrace(payload);
    return { traceId, payload };
  }

  it("persists a selection trace through the trusted DAL and reads it back with no information loss", async () => {
    const [cardId] = await pickCards(testerA, 1);
    const { payload } = await persistTestTrace(testerA, sessionAId, {
      cardId,
      schedulerPosition: 100,
      schedulerRevision: 1,
      randomDraws: [0.11, 0.42, 0.93],
      admittedCardIds: [cardId],
      sourceWeightsRaw: { active: 0.7, due: 0.25, near: 0.05, randomMastered: 0 },
      sourceWeightsNormalized: { active: 0.7, due: 0.25, near: 0.05, randomMastered: 0 },
      cardPriorityWeight: 1.3,
    });

    const admin = createAdminClient();
    const { data, error } = await admin
      .from("learning_engine_selection_traces")
      .select("*")
      .eq("id", payload.id)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.card_id).toBe(cardId);
    expect(data!.scheduler_position).toBe(100);
    expect(data!.random_draws).toEqual([0.11, 0.42, 0.93]);
    expect(data!.admitted_card_ids).toEqual([cardId]);
    expect(data!.source_weight_active_raw).toBeCloseTo(0.7, 5);
    expect(data!.source_weight_active_normalized).toBeCloseTo(0.7, 5);
    expect(data!.card_priority_weight).toBeCloseTo(1.3, 5);
    expect(data!.trace_payload.traceId).toBe(payload.id);
  });

  it("persists a linked review event, and the trace<->event linkage round-trips", async () => {
    const [cardId] = await pickCards(testerA, 1);
    const { traceId } = await persistTestTrace(testerA, sessionAId, {
      cardId,
      schedulerPosition: 200,
      schedulerRevision: 1,
    });

    const before = INITIAL_CARD_STATE;
    const after = applyFirstPresentation(before);

    const clientEventId = crypto.randomUUID();
    const reviewPayload: ReviewEventPersistencePayload = buildReviewEvent({
      identity: {
        clientEventId,
        userId: testerA.userId,
        deckId: testerA.deckId,
        cardId,
        sessionId: sessionAId,
        occurredAt: new Date(),
      },
      position: { sessionPosition: 1, schedulerPosition: 200, schedulerRevision: 1 },
      behavior: { correct: false, responseTimeMs: 1200, timeToFirstActionMs: null },
      selection: {
        selectionTraceId: traceId,
        source: "ACTIVE",
        selectionReason: "active_weighted_selection",
        schedulerMode: "pre_goal_balanced",
        cardPriorityWeight: null,
        candidateCount: 1,
        sourceWeightActive: null,
        sourceWeightDue: null,
        sourceWeightNear: null,
        sourceWeightRandomMastered: null,
        sourceWeightActiveRaw: null,
        sourceWeightDueRaw: null,
        sourceWeightNearRaw: null,
        sourceWeightRandomMasteredRaw: null,
      },
      goal: { dailyGoalCompleteBefore: false },
      exposure: {
        sameDaySeenCountBefore: 0,
        sameDayWrongCountBefore: 0,
        previousPresentationSchedulerPosition: null,
        currentPresentationSchedulerPosition: 201,
        lastSeenAtBefore: null,
      },
      fsrs: {
        fsrsDBefore: null,
        fsrsSBefore: null,
        fsrsRBefore: null,
        fsrsDAfter: null,
        fsrsSAfter: null,
        fsrsRAfter: null,
        elapsedDays: null,
        scheduledIntervalDays: null,
      },
      mastery: { fsrsReviewCorrectCountBefore: 0, fsrsReviewCorrectStreakBefore: 0 },
      policy: {
        policyVersion: "learning-engine-v1.0",
        fsrsVersion: "ts-fsrs@5.4.2",
        parameterSetId: null,
        experimentAssignmentId: null,
      },
      beforeState: before,
      afterState: after,
    });

    const persisted = await persistReviewEvent(reviewPayload);
    expect(persisted.client_event_id).toBe(clientEventId);
    expect(persisted.selection_trace_id).toBe(traceId);
    expect(persisted.scheduler_position).toBe(200);
    expect(persisted.scheduler_revision).toBe(1);
    expect(persisted.session_mode).toBe("v1");
    expect(persisted.card_status_before).toBe("NEW");
    expect(persisted.card_status_after).toBe("LEARNING");

    const admin = createAdminClient();
    const { data: traceRow } = await admin
      .from("learning_engine_selection_traces")
      .select("id")
      .eq("id", traceId)
      .maybeSingle();
    expect(traceRow?.id).toBe(traceId);
  });

  it("idempotent retry returns the original row and never creates a duplicate", async () => {
    const [cardId] = await pickCards(testerA, 1);
    const clientEventId = crypto.randomUUID();
    const before: ReturnType<typeof applyFirstPresentation> = { ...INITIAL_CARD_STATE, cardStatus: "LEARNING", learningStage: "FRESH" };
    const after = applyNormalCorrect(before);

    function buildPayload(correct: boolean): ReviewEventPersistencePayload {
      return buildReviewEvent({
        identity: { clientEventId, userId: testerA.userId, deckId: testerA.deckId, cardId, sessionId: sessionAId, occurredAt: new Date() },
        position: { sessionPosition: 2, schedulerPosition: 300, schedulerRevision: 0 },
        behavior: { correct, responseTimeMs: 1000, timeToFirstActionMs: null },
        selection: {
          selectionTraceId: null,
          source: "ACTIVE",
          selectionReason: "active_weighted_selection",
          schedulerMode: "pre_goal_balanced",
          cardPriorityWeight: null,
          candidateCount: null,
          sourceWeightActive: null,
          sourceWeightDue: null,
          sourceWeightNear: null,
          sourceWeightRandomMastered: null,
          sourceWeightActiveRaw: null,
          sourceWeightDueRaw: null,
          sourceWeightNearRaw: null,
          sourceWeightRandomMasteredRaw: null,
        },
        goal: { dailyGoalCompleteBefore: false },
        exposure: { sameDaySeenCountBefore: 1, sameDayWrongCountBefore: 0, previousPresentationSchedulerPosition: null, currentPresentationSchedulerPosition: 301, lastSeenAtBefore: null },
        fsrs: { fsrsDBefore: null, fsrsSBefore: null, fsrsRBefore: null, fsrsDAfter: null, fsrsSAfter: null, fsrsRAfter: null, elapsedDays: null, scheduledIntervalDays: null },
        mastery: { fsrsReviewCorrectCountBefore: 0, fsrsReviewCorrectStreakBefore: 0 },
        policy: { policyVersion: "learning-engine-v1.0", fsrsVersion: "ts-fsrs@5.4.2", parameterSetId: null, experimentAssignmentId: null },
        beforeState: before,
        afterState: after,
      });
    }

    const first = await persistReviewEvent(buildPayload(true));
    expect(first.correct).toBe(true);

    // Retry with a DIFFERENT `correct` value for the same clientEventId --
    // the replay must return the ORIGINAL row, never the retry's input.
    const retried = await persistReviewEvent(buildPayload(false));
    expect(retried.correct).toBe(true);
    expect(retried.id).toBe(first.id);

    expect(await countAnswerEventsByClientEventId(clientEventId)).toBe(1);
  });

  it("rejects a selection trace whose session does not belong to the given user", async () => {
    const [cardId] = await pickCards(testerA, 1);
    const trace = makeTrace({ cardId });
    const payload = serializeSelectionTrace({
      trace,
      context: {
        traceId: crypto.randomUUID(),
        userId: testerB.userId, // mismatched: sessionAId belongs to testerA
        deckId: testerA.deckId,
        sessionId: sessionAId,
        selectedAt: new Date(),
      },
    });

    await expect(persistSelectionTrace(payload)).rejects.toSatisfy(
      (err: unknown) => err instanceof LearningEngineTelemetryError && err.code === "42501",
    );
  });

  it("rejects a review event claiming a selection trace that belongs to a different user", async () => {
    const [cardA] = await pickCards(testerA, 1);
    const [cardB] = await pickCards(testerB, 1);
    const { traceId: traceForB } = await persistTestTrace(testerB, sessionBId, { cardId: cardB });

    const before = INITIAL_CARD_STATE;
    const after = applyFirstPresentation(before);
    const payload = buildReviewEvent({
      identity: { clientEventId: crypto.randomUUID(), userId: testerA.userId, deckId: testerA.deckId, cardId: cardA, sessionId: sessionAId, occurredAt: new Date() },
      position: { sessionPosition: 1, schedulerPosition: 1, schedulerRevision: 0 },
      behavior: { correct: true, responseTimeMs: 1000, timeToFirstActionMs: null },
      selection: {
        selectionTraceId: traceForB,
        source: "ACTIVE",
        selectionReason: "active_weighted_selection",
        schedulerMode: "pre_goal_balanced",
        cardPriorityWeight: null,
        candidateCount: null,
        sourceWeightActive: null,
        sourceWeightDue: null,
        sourceWeightNear: null,
        sourceWeightRandomMastered: null,
        sourceWeightActiveRaw: null,
        sourceWeightDueRaw: null,
        sourceWeightNearRaw: null,
        sourceWeightRandomMasteredRaw: null,
      },
      goal: { dailyGoalCompleteBefore: false },
      exposure: { sameDaySeenCountBefore: 0, sameDayWrongCountBefore: 0, previousPresentationSchedulerPosition: null, currentPresentationSchedulerPosition: 2, lastSeenAtBefore: null },
      fsrs: { fsrsDBefore: null, fsrsSBefore: null, fsrsRBefore: null, fsrsDAfter: null, fsrsSAfter: null, fsrsRAfter: null, elapsedDays: null, scheduledIntervalDays: null },
      mastery: { fsrsReviewCorrectCountBefore: 0, fsrsReviewCorrectStreakBefore: 0 },
      policy: { policyVersion: "learning-engine-v1.0", fsrsVersion: "ts-fsrs@5.4.2", parameterSetId: null, experimentAssignmentId: null },
      beforeState: before,
      afterState: after,
    });

    await expect(persistReviewEvent(payload)).rejects.toSatisfy(
      (err: unknown) => err instanceof LearningEngineTelemetryError && err.code === "42501",
    );
  });

  it("persists a no-card trace (no_card_all_unavailable: card_id and source both null)", async () => {
    const trace = makeTrace({ cardId: null, source: null, selectionReason: "no_card_all_unavailable", emergencyFallbackApplied: true });
    const payload = serializeSelectionTrace({
      trace,
      context: { traceId: crypto.randomUUID(), userId: testerA.userId, deckId: testerA.deckId, sessionId: sessionAId, selectedAt: new Date() },
    });

    const persisted = await persistSelectionTrace(payload);
    expect(persisted.card_id).toBeNull();
    expect(persisted.source).toBeNull();
    expect(persisted.selection_reason).toBe("no_card_all_unavailable");
  });

  it("legacy commit_answer_transaction() path still succeeds, and the resulting row has every v1 telemetry field null", async () => {
    const [cardId] = await pickCards(testerA, 1);
    const clientEventId = crypto.randomUUID();

    setRlsClient(testerA.client);
    let result: Awaited<ReturnType<typeof runSubmitAnswer>>;
    try {
      result = await runSubmitAnswer(
        { clientEventId, sessionId: sessionAId, cardId, correct: true, responseTimeMs: 1400 },
        testerA.userId,
        defaultSubmitAnswerDeps,
      );
    } finally {
      clearRlsClient();
    }
    expect(result.ok).toBe(true);

    const row = await getAnswerEventByClientEventIdAdmin(clientEventId);
    expect(row).not.toBeNull();
    expect(row!.session_mode).not.toBe("v1");
    expect(row!.selection_trace_id).toBeNull();
    expect(row!.source).toBeNull();
    expect(row!.selection_reason).toBeNull();
    expect(row!.scheduler_mode).toBeNull();
    expect(row!.session_position).toBeNull();
    expect(row!.scheduler_position).toBeNull();
    expect(row!.scheduler_revision).toBeNull();
    expect(row!.policy_version).toBeNull();
  });

  it("existing legacy session behavior is untouched by Phase 8 (session row still has only its pre-existing shape of fields populated)", async () => {
    const admin = createAdminClient();
    const { data: session, error } = await admin.from("sessions").select("*").eq("id", sessionAId).maybeSingle();
    expect(error).toBeNull();
    expect(session).not.toBeNull();
    expect(session!.policy_version).toBeNull();
    expect(session!.repair_events).toBe(0);
    expect(session!.critical_due_interrupts).toBe(0);
    expect(session!.active_starvation_guarantees).toBe(0);
    expect(session!.questions_after_goal).toBe(0);
    expect(session!.daily_goal_completed_at).toBeNull();
  });
});
