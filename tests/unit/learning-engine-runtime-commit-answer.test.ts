import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the RC-C orchestration function
 * `commitLearningEngineAnswer` (lib/learning-engine/runtime/commit-answer.ts).
 * No DB access -- the trusted DAL is mocked, so this file exercises only
 * the orchestration logic itself: the read-prepare-telemetry-commit
 * sequencing, the bounded stale-snapshot retry, and propagation of a
 * non-retryable rejection. Cross-entity/DB-level behavior is covered by
 * supabase/tests/020_learning_engine_v1_runtime_cutover_rc_c_test.sql and
 * the real-stack integration test. prepareLearningEngineAnswer's own
 * transition-matrix correctness is covered by
 * tests/unit/learning-engine-runtime-prepare-answer.test.ts.
 */

vi.mock("server-only", () => ({}));

const fetchAnswerContext = vi.fn();
const fetchExistingAnswerEvent = vi.fn();
const commitLearningEngineAnswerRpc = vi.fn();

class LearningEngineAnswerCommitError extends Error {
  readonly code: string | undefined;
  constructor(message: string, options: { code?: string; cause: unknown }) {
    super(message, { cause: options.cause });
    this.name = "LearningEngineAnswerCommitError";
    this.code = options.code;
  }
}

const STALE_ANSWER_SNAPSHOT_SQLSTATE = "40001";

vi.mock("@/lib/learning-engine/runtime/commit-answer-dal", () => ({
  fetchAnswerContext,
  fetchExistingAnswerEvent,
  commitLearningEngineAnswerRpc,
  LearningEngineAnswerCommitError,
  STALE_ANSWER_SNAPSHOT_SQLSTATE,
}));

const { commitLearningEngineAnswer, MAX_COMMIT_ATTEMPTS, CommitRetryExhaustedError } = await import(
  "@/lib/learning-engine/runtime/commit-answer"
);

afterEach(() => {
  vi.clearAllMocks();
});

const USER_ID = "user-1";
const SESSION_ID = "session-1";

const RAW_CONTEXT = {
  userId: USER_ID,
  deckId: "deck-1",
  now: "2026-03-01T00:00:00.000Z",
  session: { comboBefore: 0, enemyHpBefore: 90, totalAnswersBefore: 5 },
  claim: {
    id: "claim-1",
    cardId: "card-1",
    selectionTraceId: "trace-1",
    schedulerPosition: 10,
    schedulerRevision: 2,
    status: "OPEN",
  },
  trace: {
    source: "ACTIVE",
    selectionReason: "active_weighted_selection",
    schedulerMode: "pre_goal_balanced",
    sourceWeightActive: 0.7,
    sourceWeightDue: 0.25,
    sourceWeightNear: 0.05,
    sourceWeightRandomMastered: null,
    sourceWeightActiveRaw: 0.7,
    sourceWeightDueRaw: 0.25,
    sourceWeightNearRaw: 0.05,
    sourceWeightRandomMasteredRaw: null,
    cardPriorityWeight: 1.0,
    retrievability: null,
    intervalProgress: null,
    candidateCount: 3,
  },
  deckState: {
    schedulerPosition: 10,
    schedulerRevision: 2,
    desiredRetention: 0.9,
    policyVersion: "learning-engine-v1.0",
    lastCriticalDuePosition: null,
    masteredCount: 0,
    hasAchievedFullMastery: false,
  },
  dailyGoal: { enemiesDefeatedToday: 0, completed: false },
  card: {
    cardId: "card-1",
    cardStatus: "LEARNING",
    learningStage: "FRESH",
    poolStatus: "ACTIVE",
    relearningPhase: null,
    hasEverBeenMastered: false,
    repairPending: false,
    repairWrongPosition: null,
    repairTargetPosition: null,
    repairHardCapPosition: null,
    correctCooldownUntilPosition: null,
    fsrsReviewCorrectCount: 0,
    fsrsReviewCorrectStreak: 0,
    fsrsDueAt: null,
    fsrsStability: null,
    fsrsDifficulty: null,
    fsrsElapsedDays: 0,
    fsrsScheduledDays: 0,
    fsrsReps: 0,
    fsrsLapses: 0,
    fsrsLearningSteps: 0,
    fsrsState: null,
    fsrsLastReviewAt: null,
    lastPresentedSchedulerPosition: null,
    sameDaySeenCount: 0,
    sameDayWrongCount: 0,
    sameDayProgressDate: null,
    lastSeenAt: null,
  },
};

const ANSWER_INPUT = { clientEventId: "11111111-1111-1111-1111-111111111111", correct: true, responseTimeMs: 1200, timeToFirstActionMs: null };

const RPC_SUCCESS_RESULT = {
  is_replay: false,
  answer_event: { id: "event-1" },
  xp_events: [],
  daily_goal_just_completed: false,
  card_mastered_just_now: false,
  full_mastery_just_achieved: false,
  user_card_progress: { card_status: "LEARNING" },
  session: { id: SESSION_ID },
  profile: { total_xp: 2 },
  deck_state: { schedulerPosition: 11, schedulerRevision: 3 },
};

const CLAIM_ID = "claim-1";

describe("commitLearningEngineAnswer", () => {
  it("a successful commit calls the RPC exactly once, with the claim's own scheduler_position (never the deck-wide revision) as the optimistic lock", async () => {
    fetchExistingAnswerEvent.mockResolvedValue(null);
    fetchAnswerContext.mockResolvedValue(RAW_CONTEXT);
    commitLearningEngineAnswerRpc.mockResolvedValue(RPC_SUCCESS_RESULT);

    const result = await commitLearningEngineAnswer(USER_ID, SESSION_ID, CLAIM_ID, ANSWER_INPUT, () => 0.5);

    expect(fetchAnswerContext).toHaveBeenCalledWith(USER_ID, SESSION_ID, CLAIM_ID);
    expect(commitLearningEngineAnswerRpc).toHaveBeenCalledTimes(1);
    const callInput = commitLearningEngineAnswerRpc.mock.calls[0][0];
    expect(callInput.claimId).toBe("claim-1");
    expect(callInput.cardId).toBe("card-1");
    expect(callInput.expectedSchedulerPosition).toBe(10);
    expect(callInput.cardAfter.learningStage).toBe("LEARNING_1"); // FRESH + Correct -> LEARNING_1
    expect(callInput.cardAfter.fsrsTouched).toBe(false);
    expect(callInput.repairObligationAfter).toBeNull();
    expect(result).toEqual({
      isReplay: false,
      cardMasteredJustNow: false,
      fullMasteryJustAchieved: false,
      dailyGoalJustCompleted: false,
      xpEvents: [],
      answerEvent: { id: "event-1" },
      userCardProgress: { card_status: "LEARNING" },
      session: { id: SESSION_ID },
      profile: { total_xp: 2 },
      deckState: { schedulerPosition: 11, schedulerRevision: 3 },
      battle: {
        damage: callInput.damage,
        critical: callInput.critical,
        comboAfter: callInput.comboAfter,
        enemyHpAfter: callInput.enemyHpAfter,
        enemyDefeated: callInput.enemyDefeated,
        newEnemyType: callInput.newEnemyType,
        newEnemyMaxHp: callInput.newEnemyMaxHp,
        newEnemyHp: callInput.newEnemyHp,
      },
      // RAW_CONTEXT.card has fsrsState: null / poolStatus "ACTIVE" -- prepareLearningEngineAnswer never touches FSRS for this answer, so fsrsGrade (and therefore rating) is null.
      rating: null,
    });
  });

  it("forwards the review-event telemetry bundle built from the context's selection-time fields", async () => {
    fetchExistingAnswerEvent.mockResolvedValue(null);
    fetchAnswerContext.mockResolvedValue(RAW_CONTEXT);
    commitLearningEngineAnswerRpc.mockResolvedValue(RPC_SUCCESS_RESULT);

    await commitLearningEngineAnswer(USER_ID, SESSION_ID, CLAIM_ID, ANSWER_INPUT, () => 0.5);

    const callInput = commitLearningEngineAnswerRpc.mock.calls[0][0];
    expect(callInput.reviewEvent.policyVersion).toBe("learning-engine-v1.0");
    expect(callInput.reviewEvent.fsrsVersion).toBe("ts-fsrs@5.4.2");
    expect(callInput.reviewEvent.isStageAdvancingSuccess).toBe(true);
    expect(callInput.reviewEvent.isRepairRetry).toBe(false);
  });

  it("a stale-snapshot rejection triggers a fresh read + re-preparation + retry, converging on success", async () => {
    fetchExistingAnswerEvent.mockResolvedValue(null);
    fetchAnswerContext.mockResolvedValue(RAW_CONTEXT);
    commitLearningEngineAnswerRpc
      .mockRejectedValueOnce(new LearningEngineAnswerCommitError("stale", { code: STALE_ANSWER_SNAPSHOT_SQLSTATE, cause: new Error("stale") }))
      .mockResolvedValueOnce(RPC_SUCCESS_RESULT);

    const result = await commitLearningEngineAnswer(USER_ID, SESSION_ID, CLAIM_ID, ANSWER_INPUT, () => 0.5);

    expect(fetchAnswerContext).toHaveBeenCalledTimes(2);
    expect(commitLearningEngineAnswerRpc).toHaveBeenCalledTimes(2);
    expect(result.isReplay).toBe(false);
  });

  it("the retry bound is enforced -- persistent stale-snapshot conflicts throw CommitRetryExhaustedError after exactly MAX_COMMIT_ATTEMPTS attempts", async () => {
    fetchExistingAnswerEvent.mockResolvedValue(null);
    fetchAnswerContext.mockResolvedValue(RAW_CONTEXT);
    commitLearningEngineAnswerRpc.mockRejectedValue(
      new LearningEngineAnswerCommitError("stale", { code: STALE_ANSWER_SNAPSHOT_SQLSTATE, cause: new Error("stale") }),
    );

    await expect(commitLearningEngineAnswer(USER_ID, SESSION_ID, CLAIM_ID, ANSWER_INPUT, () => 0.5)).rejects.toBeInstanceOf(
      CommitRetryExhaustedError,
    );
    expect(commitLearningEngineAnswerRpc).toHaveBeenCalledTimes(MAX_COMMIT_ATTEMPTS);
    expect(fetchAnswerContext).toHaveBeenCalledTimes(MAX_COMMIT_ATTEMPTS);
  });

  it("a non-retryable rejection (e.g. a non-OPEN claim, or a deleted card) propagates immediately, unretried", async () => {
    fetchExistingAnswerEvent.mockResolvedValue(null);
    fetchAnswerContext.mockResolvedValue(RAW_CONTEXT);
    commitLearningEngineAnswerRpc.mockRejectedValue(new LearningEngineAnswerCommitError("not open", { code: "42501", cause: new Error("not open") }));

    await expect(commitLearningEngineAnswer(USER_ID, SESSION_ID, CLAIM_ID, ANSWER_INPUT, () => 0.5)).rejects.toThrow("not open");
    expect(commitLearningEngineAnswerRpc).toHaveBeenCalledTimes(1);
    expect(fetchAnswerContext).toHaveBeenCalledTimes(1);
  });

  it("a Wrong answer on a repair-pending card creates a fresh repair obligation and sends no FSRS update", async () => {
    fetchExistingAnswerEvent.mockResolvedValue(null);
    fetchAnswerContext.mockResolvedValue({
      ...RAW_CONTEXT,
      trace: { ...RAW_CONTEXT.trace, selectionReason: "repair_target" },
      card: { ...RAW_CONTEXT.card, repairPending: true, repairWrongPosition: 2, repairTargetPosition: 6, repairHardCapPosition: 9 },
    });
    commitLearningEngineAnswerRpc.mockResolvedValue(RPC_SUCCESS_RESULT);

    await commitLearningEngineAnswer(USER_ID, SESSION_ID, CLAIM_ID, { ...ANSWER_INPUT, correct: false }, () => 0);

    const callInput = commitLearningEngineAnswerRpc.mock.calls[0][0];
    expect(callInput.repairObligationAfter).not.toBeNull();
    expect(callInput.repairObligationAfter.wrongPosition).toBe(11); // claim.schedulerPosition (10) + 1
    expect(callInput.cardAfter.fsrsTouched).toBe(false);
  });

  it("a client_event_id replay short-circuits via the orchestration layer's own pre-check -- never reaches fetchAnswerContext/the commit RPC at all, and returns the HISTORICAL persisted Battle result, never a placeholder", async () => {
    fetchExistingAnswerEvent.mockResolvedValue({
      answerEvent: {
        id: "event-1", user_id: USER_ID, session_id: SESSION_ID, card_id: "card-1",
        // Runtime Cutover RC-D battle-replay-fidelity correction: these
        // four columns are what supabase/migrations/
        // 20261018000000_learning_engine_v1_battle_replay_fidelity.sql
        // now persists onto every fresh v1 answer_events row -- a
        // genuine historical row always has them.
        damage: 7, critical: true, combo: 4, enemy_hp_after: 13,
      },
      xpEvents: [
        { id: "xp-1", user_id: USER_ID, session_id: SESSION_ID, card_id: "card-1", source_answer_event_id: "event-1", amount: 2, reason: "correct_answer", created_at: "2026-03-01T00:00:00.000Z" },
        { id: "xp-2", user_id: USER_ID, session_id: SESSION_ID, card_id: "card-1", source_answer_event_id: "event-1", amount: 15, reason: "card_learned", created_at: "2026-03-01T00:00:00.000Z" },
      ],
    });

    const result = await commitLearningEngineAnswer(USER_ID, SESSION_ID, CLAIM_ID, ANSWER_INPUT, () => 0.5);

    expect(result.isReplay).toBe(true);
    expect(result.cardMasteredJustNow).toBe(true);
    expect(result.dailyGoalJustCompleted).toBe(false);
    expect(result.userCardProgress).toBeNull();
    // Faithful, not a placeholder: read straight from the historical row,
    // never recomputed and never zeroed.
    expect(result.battle).toEqual({
      damage: 7,
      critical: true,
      comboAfter: 4,
      enemyHpAfter: 13,
      enemyDefeated: false,
      newEnemyType: null,
      newEnemyMaxHp: null,
      newEnemyHp: null,
    });
    expect(result.rating).toBeNull();
    expect(fetchAnswerContext).not.toHaveBeenCalled();
    expect(commitLearningEngineAnswerRpc).not.toHaveBeenCalled();
  });

  it("a replay never recomputes from current context, even when fetchAnswerContext is mocked to return a wildly different (diverged) state than the original answer", async () => {
    fetchExistingAnswerEvent.mockResolvedValue({
      answerEvent: { id: "event-1", user_id: USER_ID, session_id: SESSION_ID, card_id: "card-1", damage: 7, critical: true, combo: 4, enemy_hp_after: 13 },
      xpEvents: [],
    });
    // If this were ever read, the result would be wrong -- proving the
    // replay path genuinely never reaches fetchAnswerContext at all,
    // not merely that it happens to return the same thing.
    fetchAnswerContext.mockResolvedValue(RAW_CONTEXT);
    commitLearningEngineAnswerRpc.mockResolvedValue(RPC_SUCCESS_RESULT);

    const result = await commitLearningEngineAnswer(USER_ID, SESSION_ID, CLAIM_ID, ANSWER_INPUT, () => 0.5);

    expect(result.battle).toEqual({
      damage: 7,
      critical: true,
      comboAfter: 4,
      enemyHpAfter: 13,
      enemyDefeated: false,
      newEnemyType: null,
      newEnemyMaxHp: null,
      newEnemyHp: null,
    });
    expect(fetchAnswerContext).not.toHaveBeenCalled();
    expect(commitLearningEngineAnswerRpc).not.toHaveBeenCalled();
  });

  it("a replay of a row that predates the Battle-replay-fidelity migration (missing persisted columns) fails loudly rather than silently returning a fabricated value", async () => {
    fetchExistingAnswerEvent.mockResolvedValue({
      answerEvent: { id: "event-1", user_id: USER_ID, session_id: SESSION_ID, card_id: "card-1" },
      xpEvents: [],
    });

    await expect(commitLearningEngineAnswer(USER_ID, SESSION_ID, CLAIM_ID, ANSWER_INPUT, () => 0.5)).rejects.toThrow(
      /missing a persisted Battle column/,
    );
  });

  it("a replayed client_event_id belonging to a different user/session is rejected, not treated as this caller's replay", async () => {
    fetchExistingAnswerEvent.mockResolvedValue({
      answerEvent: { id: "event-1", user_id: "someone-else", session_id: SESSION_ID, card_id: "card-1" },
      xpEvents: [],
    });

    await expect(commitLearningEngineAnswer(USER_ID, SESSION_ID, CLAIM_ID, ANSWER_INPUT, () => 0.5)).rejects.toThrow(/already recorded/);
    expect(fetchAnswerContext).not.toHaveBeenCalled();
  });
});
