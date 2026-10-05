import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the pre-RC-E enrollment-safety architecture in
 * lib/learning-engine/cutover/enroll.ts: repeated enrollment must be a
 * true no-op (never re-run normalization over already-live v1 state),
 * enrollment must refuse a user with an active legacy Session (never
 * auto-finish it), and -- the second-pass correction -- these guarantees
 * must hold under concurrency, not just in the TypeScript-side ordering.
 * No DB access -- every trusted dependency is mocked, so this file
 * exercises only enroll.ts's own orchestration: which functions it
 * calls, in what order, and how it maps each of
 * commit_learning_engine_v1_enrollment()'s three status-envelope
 * outcomes (ok / already_enrolled / active_legacy_session) back to its
 * own result/error contract. The actual atomicity guarantee (what makes
 * concurrent calls converge safely, and what makes a racing Session
 * creation produce only a valid outcome) lives in the SQL transaction
 * itself and is covered by
 * supabase/tests/023_learning_engine_v1_enrollment_active_legacy_session_guard_test.sql
 * and supabase/tests/024_learning_engine_v1_enrollment_atomic_commit_test.sql.
 */

vi.mock("server-only", () => ({}));

const prepareLearningEngineV1NormalizationForUser = vi.fn();
const LEARNING_ENGINE_V1_CUTOVER_NORMALIZATION_VERSION = "learning-engine-v1.0-cutover-rc-a.1";
vi.mock("@/lib/learning-engine/cutover/prepare-normalization", () => ({
  prepareLearningEngineV1NormalizationForUser,
  LEARNING_ENGINE_V1_CUTOVER_NORMALIZATION_VERSION,
}));

const commitLearningEngineV1Enrollment = vi.fn();
const getActiveLegacySessionForUser = vi.fn();
const getLearningEngineV1RolloutRow = vi.fn();
vi.mock("@/lib/learning-engine/cutover/dal", () => ({
  commitLearningEngineV1Enrollment,
  getActiveLegacySessionForUser,
  getLearningEngineV1RolloutRow,
}));

const { enrollUserInLearningEngineV1, ActiveLegacySessionEnrollmentError } = await import(
  "@/lib/learning-engine/cutover/enroll"
);

afterEach(() => {
  vi.clearAllMocks();
});

const USER_ID = "user-1";

const EXISTING_ROLLOUT = { user_id: USER_ID, enabled_at: "2026-01-01T00:00:00Z", first_v1_answer_at: null };

const EMPTY_PREPARED = { cardsToNormalize: [], cardsSkippedNew: 0, deckIds: [] };

describe("enrollUserInLearningEngineV1 -- repeated enrollment (fast-path)", () => {
  it("is a true no-op when a rollout row already exists: never prepares or commits", async () => {
    getLearningEngineV1RolloutRow.mockResolvedValue(EXISTING_ROLLOUT);

    const result = await enrollUserInLearningEngineV1(USER_ID);

    expect(result).toEqual({
      cardsNormalized: 0,
      cardsSkippedNew: 0,
      decksRecomputed: 0,
      rollout: EXISTING_ROLLOUT,
    });
    expect(prepareLearningEngineV1NormalizationForUser).not.toHaveBeenCalled();
    expect(commitLearningEngineV1Enrollment).not.toHaveBeenCalled();
    expect(getActiveLegacySessionForUser).not.toHaveBeenCalled();
  });
});

describe("enrollUserInLearningEngineV1 -- active legacy session guard (fast-path)", () => {
  it("refuses enrollment and never prepares/commits when an active legacy session exists", async () => {
    getLearningEngineV1RolloutRow.mockResolvedValue(null);
    getActiveLegacySessionForUser.mockResolvedValue({ id: "session-legacy-1" });

    await expect(enrollUserInLearningEngineV1(USER_ID)).rejects.toThrow(ActiveLegacySessionEnrollmentError);

    expect(prepareLearningEngineV1NormalizationForUser).not.toHaveBeenCalled();
    expect(commitLearningEngineV1Enrollment).not.toHaveBeenCalled();
  });

  it("the thrown error names the user and the blocking session", async () => {
    getLearningEngineV1RolloutRow.mockResolvedValue(null);
    getActiveLegacySessionForUser.mockResolvedValue({ id: "session-legacy-1" });

    const error = await enrollUserInLearningEngineV1(USER_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ActiveLegacySessionEnrollmentError);
    expect((error as InstanceType<typeof ActiveLegacySessionEnrollmentError>).userId).toBe(USER_ID);
    expect((error as InstanceType<typeof ActiveLegacySessionEnrollmentError>).sessionId).toBe("session-legacy-1");
  });
});

describe("enrollUserInLearningEngineV1 -- session-creation race (caught by the atomic transaction, not the pre-check)", () => {
  it("surfaces active_legacy_session from the commit itself with the real session id, even when the fast-path pre-check missed it", async () => {
    getLearningEngineV1RolloutRow.mockResolvedValue(null);
    // The fast-path pre-check sees nothing -- the race window.
    getActiveLegacySessionForUser.mockResolvedValue(null);
    prepareLearningEngineV1NormalizationForUser.mockResolvedValue(EMPTY_PREPARED);
    // The atomic transaction itself catches the session created in the
    // race window, under its own profile-row lock, and rejects.
    commitLearningEngineV1Enrollment.mockResolvedValue({ status: "active_legacy_session", sessionId: "session-raced-in" });

    const error = await enrollUserInLearningEngineV1(USER_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ActiveLegacySessionEnrollmentError);
    expect((error as InstanceType<typeof ActiveLegacySessionEnrollmentError>).sessionId).toBe("session-raced-in");
    // Preparation still happened (it's read-only and harmless), but
    // nothing was ever persisted -- commitLearningEngineV1Enrollment
    // itself is the only thing that could have written anything, and its
    // mocked result here represents the transaction having rejected
    // before any write.
    expect(prepareLearningEngineV1NormalizationForUser).toHaveBeenCalledWith(USER_ID);
  });
});

describe("enrollUserInLearningEngineV1 -- concurrent duplicate enrollment converges safely", () => {
  it("surfaces already_enrolled from the commit itself as the same no-op shape, when a concurrent call won the race", async () => {
    getLearningEngineV1RolloutRow.mockResolvedValue(null);
    getActiveLegacySessionForUser.mockResolvedValue(null);
    prepareLearningEngineV1NormalizationForUser.mockResolvedValue({
      cardsToNormalize: [{ cardId: "card-1", deckId: "deck-1", userId: USER_ID, expectedLegacyCardStatus: "LEARNING", target: {} }],
      cardsSkippedNew: 1,
      deckIds: ["deck-1"],
    });
    const concurrentWinnerRollout = { user_id: USER_ID, enabled_at: "2026-03-01T00:00:00Z", first_v1_answer_at: null };
    commitLearningEngineV1Enrollment.mockResolvedValue({ status: "already_enrolled", rollout: concurrentWinnerRollout });

    const result = await enrollUserInLearningEngineV1(USER_ID);

    expect(result).toEqual({
      cardsNormalized: 0,
      cardsSkippedNew: 1,
      decksRecomputed: 0,
      rollout: concurrentWinnerRollout,
    });
  });
});

describe("enrollUserInLearningEngineV1 -- normal (first-time) enrollment", () => {
  it("prepares then commits atomically when no rollout row and no active legacy session exist", async () => {
    getLearningEngineV1RolloutRow.mockResolvedValue(null);
    getActiveLegacySessionForUser.mockResolvedValue(null);
    const preparedCards = [
      { cardId: "card-1", deckId: "deck-1", userId: USER_ID, expectedLegacyCardStatus: "LEARNING", target: { cardStatus: "LEARNING" } },
    ];
    prepareLearningEngineV1NormalizationForUser.mockResolvedValue({
      cardsToNormalize: preparedCards,
      cardsSkippedNew: 3,
      deckIds: ["deck-1", "deck-2"],
    });
    const admittedRollout = { user_id: USER_ID, enabled_at: "2026-02-01T00:00:00Z", first_v1_answer_at: null };
    commitLearningEngineV1Enrollment.mockResolvedValue({
      status: "ok",
      rollout: admittedRollout,
      cardsNormalized: 1,
      decksRecomputed: 2,
    });

    const result = await enrollUserInLearningEngineV1(USER_ID);

    expect(result).toEqual({
      cardsNormalized: 1,
      cardsSkippedNew: 3,
      decksRecomputed: 2,
      rollout: admittedRollout,
    });
    expect(prepareLearningEngineV1NormalizationForUser).toHaveBeenCalledWith(USER_ID);
    expect(commitLearningEngineV1Enrollment).toHaveBeenCalledWith(USER_ID, {
      normalizationVersion: LEARNING_ENGINE_V1_CUTOVER_NORMALIZATION_VERSION,
      cards: preparedCards,
      deckIds: ["deck-1", "deck-2"],
    });
    // Preparation must complete before the atomic commit is called --
    // there is now exactly one commit call, not a normalize-then-admit
    // sequence of several.
    const prepareOrder = prepareLearningEngineV1NormalizationForUser.mock.invocationCallOrder[0];
    const commitOrder = commitLearningEngineV1Enrollment.mock.invocationCallOrder[0];
    expect(prepareOrder).toBeLessThan(commitOrder);
  });
});
