import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the Runtime Cutover RC-B orchestration function
 * `claimNextLearningEngineCard` (lib/learning-engine/runtime/
 * claim-next-card.ts). No DB access -- the trusted DAL, the pure scheduler,
 * and the pure snapshot mapper are all mocked, so this file exercises only
 * the orchestration logic itself: the OPEN-claim fast path, the
 * read-decide-claim sequencing, the bounded stale-revision retry, and
 * propagation of a non-retryable rejection. Cross-entity/DB-level
 * behavior is covered by supabase/tests/
 * 019_learning_engine_v1_runtime_cutover_rc_b_test.sql and the real-stack
 * integration test.
 */

vi.mock("server-only", () => ({}));

const fetchSchedulerSnapshot = vi.fn();
const claimNextLearningEngineCardRpc = vi.fn();

class LearningEngineClaimError extends Error {
  readonly code: string | undefined;
  constructor(message: string, options: { code?: string; cause: unknown }) {
    super(message, { cause: options.cause });
    this.name = "LearningEngineClaimError";
    this.code = options.code;
  }
}

const STALE_SNAPSHOT_SQLSTATE = "40001";

vi.mock("@/lib/learning-engine/runtime/claim-dal", () => ({
  fetchSchedulerSnapshot,
  claimNextLearningEngineCardRpc,
  LearningEngineClaimError,
  STALE_SNAPSHOT_SQLSTATE,
}));

const chooseNextCard = vi.fn();
vi.mock("@/lib/learning-engine/scheduler/next-card", () => ({ chooseNextCard }));

const mapRawSchedulerSnapshot = vi.fn();
vi.mock("@/lib/learning-engine/runtime/snapshot-mapper", () => ({ mapRawSchedulerSnapshot }));

const {
  claimNextLearningEngineCard,
  MAX_CLAIM_ATTEMPTS,
  ClaimRetryExhaustedError,
} = await import("@/lib/learning-engine/runtime/claim-next-card");

afterEach(() => {
  vi.clearAllMocks();
});

const USER_ID = "user-1";
const SESSION_ID = "session-1";

const RAW_SNAPSHOT_NO_OPEN_CLAIM = {
  userId: USER_ID,
  deckId: "deck-1",
  now: "2026-03-01T00:00:00.000Z",
  deckState: {
    desiredRetention: 0.9,
    policyVersion: "learning-engine-v1.0",
    hasAchievedFullMastery: false,
    masteredCount: 0,
    schedulerPosition: 5,
    lastCriticalDuePosition: null,
    schedulerRevision: 2,
    firstPassQueue: null,
    postMasteryShuffleBag: null,
  },
  dailyGoal: { enemiesDefeatedToday: 0, completed: false },
  cards: [],
  openClaim: null,
};

const MAPPED_SNAPSHOT = {
  userId: USER_ID,
  deckId: "deck-1",
  now: new Date("2026-03-01T00:00:00.000Z"),
  deckState: {
    desiredRetention: 0.9,
    policyVersion: "learning-engine-v1.0",
    hasAchievedFullMastery: false,
    masteredCount: 0,
    schedulerPosition: 5,
    lastCriticalDuePosition: null,
    schedulerRevision: 2,
    firstPassQueue: null,
    postMasteryShuffleBag: null,
  },
  dailyGoal: { enemiesDefeatedToday: 0, completed: false },
  cards: [],
};

const BASE_WEIGHTS = { active: 0, due: 0, near: 0, randomMastered: 0 };
const BASE_CANDIDATES = { active: 0, due: 0, near: 0, randomMastered: 0 };

function makeDecision(overrides: Partial<Record<string, unknown>> = {}) {
  const trace = {
    cardId: "card-1",
    source: "ACTIVE",
    selectionReason: "active_weighted_selection",
    schedulerMode: "pre_goal_balanced",
    schedulerPosition: 5,
    schedulerRevision: 2,
    dueCount: 0,
    dailyGoalCompleteBefore: false,
    sourceWeightsRaw: BASE_WEIGHTS,
    sourceWeightsNormalized: BASE_WEIGHTS,
    candidateCounts: BASE_CANDIDATES,
    cardPriorityWeight: 1.0,
    retrievability: null,
    intervalProgress: null,
    admittedCardIds: [],
    policyVersion: "learning-engine-v1.0",
    emergencyFallbackApplied: false,
    firstPassQueueBefore: null,
    firstPassQueueAfter: null,
    postMasteryShuffleBagBefore: null,
    postMasteryShuffleBagAfter: null,
    randomDraws: [0.5],
  };
  return {
    cardId: "card-1",
    source: "ACTIVE",
    selectionReason: "active_weighted_selection",
    admittedCardIds: [],
    firstPassQueueAfter: null,
    postMasteryShuffleBagAfter: null,
    schedulerPosition: 5,
    schedulerRevision: 2,
    trace,
    ...overrides,
  };
}

describe("claimNextLearningEngineCard", () => {
  it("fast path: an existing OPEN claim bypasses chooseNextCard entirely", async () => {
    fetchSchedulerSnapshot.mockResolvedValue({
      ...RAW_SNAPSHOT_NO_OPEN_CLAIM,
      openClaim: {
        id: "claim-1",
        cardId: "card-9",
        selectionTraceId: "trace-9",
        schedulerPosition: 5,
        schedulerRevision: 2,
      },
    });

    const result = await claimNextLearningEngineCard(USER_ID, SESSION_ID, () => 0.5);

    expect(result).toEqual({
      reused: true,
      cardId: "card-9",
      claimId: "claim-1",
      selectionTraceId: "trace-9",
      schedulerPosition: 5,
      schedulerRevision: 2,
    });
    expect(chooseNextCard).not.toHaveBeenCalled();
    expect(claimNextLearningEngineCardRpc).not.toHaveBeenCalled();
  });

  it("successful decision calls the claim RPC exactly once", async () => {
    fetchSchedulerSnapshot.mockResolvedValue(RAW_SNAPSHOT_NO_OPEN_CLAIM);
    mapRawSchedulerSnapshot.mockReturnValue(MAPPED_SNAPSHOT);
    chooseNextCard.mockReturnValue(makeDecision());
    claimNextLearningEngineCardRpc.mockResolvedValue({
      reused: false,
      claim: { id: "claim-2", card_id: "card-1", selection_trace_id: "trace-2", scheduler_position: 5, scheduler_revision: 3 },
      trace: { id: "trace-2", card_id: "card-1", scheduler_position: 5, scheduler_revision: 2 },
      schedulerRevision: 3,
    });

    const result = await claimNextLearningEngineCard(USER_ID, SESSION_ID, () => 0.5);

    expect(claimNextLearningEngineCardRpc).toHaveBeenCalledTimes(1);
    expect(chooseNextCard).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      reused: false,
      cardId: "card-1",
      claimId: "claim-2",
      selectionTraceId: "trace-2",
      schedulerPosition: 5,
      schedulerRevision: 3,
    });
  });

  it("RC-B corrective: an ACTIVE-source decision forwards claim-time active_draws_since_eligible deltas to the claim RPC", async () => {
    fetchSchedulerSnapshot.mockResolvedValue({
      ...RAW_SNAPSHOT_NO_OPEN_CLAIM,
      cards: [{ cardId: "card-1" }, { cardId: "card-2" }],
    });
    mapRawSchedulerSnapshot.mockReturnValue({
      ...MAPPED_SNAPSHOT,
      cards: [
        {
          cardId: "card-1",
          cardStatus: "LEARNING",
          learningStage: "FRESH",
          poolStatus: "ACTIVE",
          relearningPhase: null,
          hasEverBeenMastered: false,
          repairPending: false,
          fsrsReviewCorrectCount: 0,
          fsrsReviewCorrectStreak: 0,
          correctCooldownUntilPosition: null,
          activeDrawsSinceEligible: 5,
          repairObligation: null,
        },
        {
          cardId: "card-2",
          cardStatus: "LEARNING",
          learningStage: "LEARNING_1",
          poolStatus: "ACTIVE",
          relearningPhase: null,
          hasEverBeenMastered: false,
          repairPending: false,
          fsrsReviewCorrectCount: 0,
          fsrsReviewCorrectStreak: 0,
          correctCooldownUntilPosition: null,
          activeDrawsSinceEligible: 10,
          repairObligation: null,
        },
      ],
    });
    chooseNextCard.mockReturnValue(makeDecision({ cardId: "card-1", source: "ACTIVE" }));
    claimNextLearningEngineCardRpc.mockResolvedValue({
      reused: false,
      claim: { id: "claim-2", card_id: "card-1", selection_trace_id: "trace-2", scheduler_position: 5, scheduler_revision: 3 },
      trace: { id: "trace-2", card_id: "card-1", scheduler_position: 5, scheduler_revision: 2 },
      schedulerRevision: 3,
    });

    await claimNextLearningEngineCard(USER_ID, SESSION_ID, () => 0.5);

    expect(claimNextLearningEngineCardRpc).toHaveBeenCalledTimes(1);
    const callInput = claimNextLearningEngineCardRpc.mock.calls[0][0];
    expect(callInput.activeDrawCounterUpdates).toEqual(
      expect.arrayContaining([
        { cardId: "card-1", before: 5, after: 0 },
        { cardId: "card-2", before: 10, after: 11 },
      ]),
    );
    expect(callInput.activeDrawCounterUpdates).toHaveLength(2);
  });

  it("RC-B corrective: a non-ACTIVE-source decision forwards an empty active_draws_since_eligible delta list", async () => {
    fetchSchedulerSnapshot.mockResolvedValue(RAW_SNAPSHOT_NO_OPEN_CLAIM);
    mapRawSchedulerSnapshot.mockReturnValue(MAPPED_SNAPSHOT);
    chooseNextCard.mockReturnValue(makeDecision({ cardId: "card-7", source: "FSRS_DUE", selectionReason: "due_weighted_selection" }));
    claimNextLearningEngineCardRpc.mockResolvedValue({
      reused: false,
      claim: { id: "claim-8", card_id: "card-7", selection_trace_id: "trace-8", scheduler_position: 5, scheduler_revision: 3 },
      trace: { id: "trace-8", card_id: "card-7", scheduler_position: 5, scheduler_revision: 2 },
      schedulerRevision: 3,
    });

    await claimNextLearningEngineCard(USER_ID, SESSION_ID, () => 0.5);

    const callInput = claimNextLearningEngineCardRpc.mock.calls[0][0];
    expect(callInput.activeDrawCounterUpdates).toEqual([]);
  });

  it("a stale-revision rejection triggers a fresh read + re-decision + retry, converging on success", async () => {
    fetchSchedulerSnapshot.mockResolvedValue(RAW_SNAPSHOT_NO_OPEN_CLAIM);
    mapRawSchedulerSnapshot.mockReturnValue(MAPPED_SNAPSHOT);
    chooseNextCard.mockReturnValue(makeDecision());

    claimNextLearningEngineCardRpc
      .mockRejectedValueOnce(new LearningEngineClaimError("stale", { code: STALE_SNAPSHOT_SQLSTATE, cause: new Error("stale") }))
      .mockResolvedValueOnce({
        reused: false,
        claim: { id: "claim-3", card_id: "card-1", selection_trace_id: "trace-3", scheduler_position: 5, scheduler_revision: 4 },
        trace: { id: "trace-3", card_id: "card-1", scheduler_position: 5, scheduler_revision: 3 },
        schedulerRevision: 4,
      });

    const result = await claimNextLearningEngineCard(USER_ID, SESSION_ID, () => 0.5);

    expect(fetchSchedulerSnapshot).toHaveBeenCalledTimes(2);
    expect(chooseNextCard).toHaveBeenCalledTimes(2);
    expect(claimNextLearningEngineCardRpc).toHaveBeenCalledTimes(2);
    expect(result.claimId).toBe("claim-3");
    expect(result.schedulerRevision).toBe(4);
  });

  it("a stale-revision retry caused by a changed schedulable card set re-reads the FRESH card set and the re-decision reflects it (review correction)", async () => {
    // First read: the snapshot the stale decision was computed from had
    // only one schedulable card. A second tab then adds/restores a card
    // (bumping scheduler_revision via the new cards triggers -- see
    // supabase/migrations/20261010000000_learning_engine_v1_runtime_cutover_rc_b_card_set_revision_bump.sql),
    // so the SECOND read must see a genuinely different card set and
    // chooseNextCard() must be re-invoked against it, not merely retried
    // with the same stale input.
    const staleRaw = { ...RAW_SNAPSHOT_NO_OPEN_CLAIM, cards: [{ cardId: "card-old" }] };
    const freshRaw = { ...RAW_SNAPSHOT_NO_OPEN_CLAIM, cards: [{ cardId: "card-old" }, { cardId: "card-new" }] };
    const staleMappedSnapshot = { ...MAPPED_SNAPSHOT, cards: [{ cardId: "card-old" }] };
    const freshMappedSnapshot = { ...MAPPED_SNAPSHOT, cards: [{ cardId: "card-old" }, { cardId: "card-new" }] };

    fetchSchedulerSnapshot.mockResolvedValueOnce(staleRaw).mockResolvedValueOnce(freshRaw);
    mapRawSchedulerSnapshot.mockReturnValueOnce(staleMappedSnapshot).mockReturnValueOnce(freshMappedSnapshot);
    // The first (stale) decision selects the pre-existing card; the
    // second (fresh) decision -- computed against the newly-widened card
    // set -- selects the NEW card instead, modeling e.g. the new card
    // winning first-pass/admission priority.
    chooseNextCard
      .mockReturnValueOnce(makeDecision({ cardId: "card-old" }))
      .mockReturnValueOnce(makeDecision({ cardId: "card-new" }));

    claimNextLearningEngineCardRpc
      .mockRejectedValueOnce(new LearningEngineClaimError("stale", { code: STALE_SNAPSHOT_SQLSTATE, cause: new Error("stale") }))
      .mockResolvedValueOnce({
        reused: false,
        claim: { id: "claim-5", card_id: "card-new", selection_trace_id: "trace-5", scheduler_position: 5, scheduler_revision: 6 },
        trace: { id: "trace-5", card_id: "card-new", scheduler_position: 5, scheduler_revision: 5 },
        schedulerRevision: 6,
      });

    const result = await claimNextLearningEngineCard(USER_ID, SESSION_ID, () => 0.5);

    expect(chooseNextCard).toHaveBeenCalledTimes(2);
    // The re-decision was computed from the FRESH (widened) snapshot, not
    // the stale one.
    expect(chooseNextCard.mock.calls[0][0]).toBe(staleMappedSnapshot);
    expect(chooseNextCard.mock.calls[1][0]).toBe(freshMappedSnapshot);
    // The final claim reflects the SECOND decision's card, proving the
    // orchestrator used the re-decision rather than the stale one.
    expect(result.cardId).toBe("card-new");
    expect(result.claimId).toBe("claim-5");
  });

  it("the retry bound is enforced -- persistent stale-revision conflicts throw ClaimRetryExhaustedError after exactly MAX_CLAIM_ATTEMPTS attempts", async () => {
    fetchSchedulerSnapshot.mockResolvedValue(RAW_SNAPSHOT_NO_OPEN_CLAIM);
    mapRawSchedulerSnapshot.mockReturnValue(MAPPED_SNAPSHOT);
    chooseNextCard.mockReturnValue(makeDecision());
    claimNextLearningEngineCardRpc.mockRejectedValue(
      new LearningEngineClaimError("stale", { code: STALE_SNAPSHOT_SQLSTATE, cause: new Error("stale") }),
    );

    await expect(claimNextLearningEngineCard(USER_ID, SESSION_ID, () => 0.5)).rejects.toBeInstanceOf(ClaimRetryExhaustedError);
    expect(claimNextLearningEngineCardRpc).toHaveBeenCalledTimes(MAX_CLAIM_ATTEMPTS);
    expect(fetchSchedulerSnapshot).toHaveBeenCalledTimes(MAX_CLAIM_ATTEMPTS);
  });

  it("a non-retryable rejection (e.g. a non-v1/foreign session, or a deleted referenced card) propagates immediately, unretried", async () => {
    fetchSchedulerSnapshot.mockResolvedValue(RAW_SNAPSHOT_NO_OPEN_CLAIM);
    mapRawSchedulerSnapshot.mockReturnValue(MAPPED_SNAPSHOT);
    chooseNextCard.mockReturnValue(makeDecision());
    claimNextLearningEngineCardRpc.mockRejectedValue(
      new LearningEngineClaimError("not found", { code: "42501", cause: new Error("not found") }),
    );

    await expect(claimNextLearningEngineCard(USER_ID, SESSION_ID, () => 0.5)).rejects.toThrow("not found");
    expect(claimNextLearningEngineCardRpc).toHaveBeenCalledTimes(1);
    expect(fetchSchedulerSnapshot).toHaveBeenCalledTimes(1);
  });

  it("a no_card_all_unavailable decision returns cardId=null and claimId=null without ever reporting reused", async () => {
    fetchSchedulerSnapshot.mockResolvedValue(RAW_SNAPSHOT_NO_OPEN_CLAIM);
    mapRawSchedulerSnapshot.mockReturnValue(MAPPED_SNAPSHOT);
    chooseNextCard.mockReturnValue(
      makeDecision({
        cardId: null,
        source: null,
        selectionReason: "no_card_all_unavailable",
        trace: { ...makeDecision().trace, cardId: null, source: null, selectionReason: "no_card_all_unavailable", cardPriorityWeight: null },
      }),
    );
    claimNextLearningEngineCardRpc.mockResolvedValue({
      reused: false,
      claim: null,
      trace: { id: "trace-4", card_id: null, scheduler_position: 5, scheduler_revision: 2 },
      schedulerRevision: 2,
    });

    const result = await claimNextLearningEngineCard(USER_ID, SESSION_ID, () => 0.5);

    expect(result.reused).toBe(false);
    expect(result.cardId).toBeNull();
    expect(result.claimId).toBeNull();
    expect(result.selectionTraceId).toBe("trace-4");
    expect(result.schedulerRevision).toBe(2);
  });
});
