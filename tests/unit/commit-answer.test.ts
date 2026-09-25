import { afterEach, describe, expect, it, vi } from "vitest";
import { Rating } from "ts-fsrs";

/**
 * lib/learning/commit-answer.ts starts with `import "server-only"` (the
 * module itself declares it must be server-only). That package throws
 * unconditionally under plain `vitest run` unless resolved under Next.js's
 * "react-server" build condition (verified in Phase D1) -- this mock is a
 * TEST-ENVIRONMENT-ONLY shim for that, and does not touch the guarded
 * module's own source. See tests/unit/service-role.test.ts for the fuller
 * explanation of this pattern.
 */
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service-role", () => ({ getServiceRoleClient: vi.fn() }));

const { getServiceRoleClient } = await import("@/lib/supabase/service-role");
const {
  commitAnswerTransaction,
  CommitAnswerTransactionError,
  COMMIT_ANSWER_ERROR_CODES,
} = await import("@/lib/learning/commit-answer");
import type { CommitAnswerInput } from "@/lib/learning/commit-answer";

afterEach(() => {
  vi.clearAllMocks();
});

const BASE_INPUT: CommitAnswerInput = {
  clientEventId: "client-event-1",
  userId: "user-1",
  sessionId: "session-1",
  cardId: "card-1",

  expectedCardStatusBefore: "LEARNING",
  expectedSeenCountBefore: 2,
  expectedCorrectStreakBefore: 1,
  expectedWrongStreakBefore: 0,
  expectedFsrsDueBefore: null,
  expectedSessionEnemyHpBefore: 50,
  expectedSessionComboBefore: 3,
  expectedSessionLearningDrawIndex: 7,

  correct: true,
  responseTimeMs: 1500,
  sessionMode: "learning",

  fsrsRating: Rating.Good,
  fsrsDueAt: new Date("2026-01-10T00:00:00.000Z"),
  fsrsStability: 2.3,
  fsrsDifficulty: 5.1,
  fsrsElapsedDays: 0,
  fsrsScheduledDays: 0,
  fsrsReps: 1,
  fsrsLapses: 0,
  fsrsLearningSteps: 1,
  fsrsState: 1,
  fsrsLastReviewAt: new Date("2026-01-01T00:00:00.000Z"),

  baseDamage: 26,
  speedBonus: 2,
  critical: false,
  comboAfter: 4,
  damage: 30,
  enemyHpAfter: 20,
  enemyDefeated: false,
  newEnemyType: null,
  newEnemyMaxHp: null,
  newEnemyHp: null,
};

const FRESH_RESULT = {
  is_replay: false,
  answer_event: { id: "answer-event-1" },
  xp_events: [{ id: "xp-1" }],
  daily_goal_just_completed: false,
  user_card_progress: { id: "progress-1" },
  session: { id: "session-1" },
  profile: {
    total_xp: 10,
    level: 1,
    current_streak: 0,
    longest_streak: 0,
    last_daily_goal_completed_on: null,
  },
};

const REPLAY_RESULT = {
  is_replay: true,
  answer_event: { id: "answer-event-1" },
  xp_events: [{ id: "xp-1" }],
  daily_goal_just_completed: false,
  user_card_progress: null,
  session: null,
  profile: null,
};

function mockRpc(response: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(response);
  vi.mocked(getServiceRoleClient).mockReturnValue({ rpc } as never);
  return rpc;
}

describe("commitAnswerTransaction", () => {
  it("calls the RPC by its exact name", async () => {
    const rpc = mockRpc({ data: FRESH_RESULT, error: null });

    await commitAnswerTransaction(BASE_INPUT);

    expect(rpc).toHaveBeenCalledWith("commit_answer_transaction", expect.anything());
  });

  it("maps every TypeScript input field to its exact RPC parameter name/value", async () => {
    const rpc = mockRpc({ data: FRESH_RESULT, error: null });

    await commitAnswerTransaction(BASE_INPUT);

    const [, params] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(params).toEqual({
      p_client_event_id: "client-event-1",
      p_user_id: "user-1",
      p_session_id: "session-1",
      p_card_id: "card-1",

      p_expected_card_status_before: "LEARNING",
      p_expected_seen_count_before: 2,
      p_expected_correct_streak_before: 1,
      p_expected_wrong_streak_before: 0,
      p_expected_fsrs_due_before: null,
      p_expected_session_enemy_hp_before: 50,
      p_expected_session_combo_before: 3,
      p_expected_session_learning_draw_index: 7,

      p_correct: true,
      p_response_time_ms: 1500,
      p_session_mode: "learning",

      p_fsrs_rating: "Good",
      p_fsrs_due_at: BASE_INPUT.fsrsDueAt,
      p_fsrs_stability: 2.3,
      p_fsrs_difficulty: 5.1,
      p_fsrs_elapsed_days: 0,
      p_fsrs_scheduled_days: 0,
      p_fsrs_reps: 1,
      p_fsrs_lapses: 0,
      p_fsrs_learning_steps: 1,
      p_fsrs_state: 1,
      p_fsrs_last_review_at: BASE_INPUT.fsrsLastReviewAt,

      p_base_damage: 26,
      p_speed_bonus: 2,
      p_critical: false,
      p_combo_after: 4,
      p_damage: 30,
      p_enemy_hp_after: 20,
      p_enemy_defeated: false,
      p_new_enemy_type: null,
      p_new_enemy_max_hp: null,
      p_new_enemy_hp: null,
    });
  });

  it.each([
    ["Again", Rating.Again],
    ["Hard", Rating.Hard],
    ["Good", Rating.Good],
    ["Easy", Rating.Easy],
  ] as const)("converts fsrsRating Grade %s to its RPC string name", async (name, grade) => {
    const rpc = mockRpc({ data: FRESH_RESULT, error: null });

    await commitAnswerTransaction({ ...BASE_INPUT, fsrsRating: grade });

    const [, params] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.p_fsrs_rating).toBe(name);
  });

  it("rejects Rating.Manual as fsrsRating even if the type boundary is bypassed", async () => {
    mockRpc({ data: FRESH_RESULT, error: null });

    await expect(
      commitAnswerTransaction({
        ...BASE_INPUT,
        fsrsRating: Rating.Manual as never,
      }),
    ).rejects.toThrow(/Manual/);
  });

  it("forwards nullable expected-before fields as null, not undefined or a fabricated value", async () => {
    const rpc = mockRpc({ data: FRESH_RESULT, error: null });

    await commitAnswerTransaction({
      ...BASE_INPUT,
      expectedFsrsDueBefore: null,
      expectedSessionEnemyHpBefore: null,
    });

    const [, params] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.p_expected_fsrs_due_before).toBeNull();
    expect(params.p_expected_session_enemy_hp_before).toBeNull();
  });

  it("forwards clientEventId unchanged (no generation)", async () => {
    const rpc = mockRpc({ data: FRESH_RESULT, error: null });

    await commitAnswerTransaction({ ...BASE_INPUT, clientEventId: "retry-of-original-event" });

    const [, params] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.p_client_event_id).toBe("retry-of-original-event");
  });

  it("parses a fresh (non-replay) result correctly", async () => {
    mockRpc({ data: FRESH_RESULT, error: null });

    const result = await commitAnswerTransaction(BASE_INPUT);

    expect(result.is_replay).toBe(false);
    if (!result.is_replay) {
      expect(result.answer_event).toEqual(FRESH_RESULT.answer_event);
      expect(result.xp_events).toEqual(FRESH_RESULT.xp_events);
      expect(result.user_card_progress).toEqual(FRESH_RESULT.user_card_progress);
      expect(result.session).toEqual(FRESH_RESULT.session);
      expect(result.profile).toEqual(FRESH_RESULT.profile);
    }
  });

  it("parses a replay result correctly, with null user_card_progress/session/profile", async () => {
    mockRpc({ data: REPLAY_RESULT, error: null });

    const result = await commitAnswerTransaction(BASE_INPUT);

    expect(result.is_replay).toBe(true);
    if (result.is_replay) {
      expect(result.answer_event).toEqual(REPLAY_RESULT.answer_event);
      expect(result.xp_events).toEqual(REPLAY_RESULT.xp_events);
      expect(result.user_card_progress).toBeNull();
      expect(result.session).toBeNull();
      expect(result.profile).toBeNull();
    }
  });

  it.each([
    ["a non-object result", "not an object"],
    ["a null result", null],
    ["a result missing is_replay", { answer_event: {}, xp_events: [] }],
    ["a result missing answer_event", { is_replay: false, xp_events: [] }],
    ["a result with a non-array xp_events", { is_replay: false, answer_event: {}, xp_events: "oops" }],
    [
      "a result missing daily_goal_just_completed",
      { is_replay: false, answer_event: {}, xp_events: [] },
    ],
    [
      "a fresh result with a null session",
      {
        is_replay: false,
        answer_event: {},
        xp_events: [],
        daily_goal_just_completed: false,
        user_card_progress: {},
        session: null,
        profile: {},
      },
    ],
    [
      "a replay result with a non-null session",
      {
        is_replay: true,
        answer_event: {},
        xp_events: [],
        daily_goal_just_completed: false,
        user_card_progress: null,
        session: { id: "leaked" },
        profile: null,
      },
    ],
  ])("throws on a malformed result shape: %s", async (_name, malformed) => {
    mockRpc({ data: malformed, error: null });

    await expect(commitAnswerTransaction(BASE_INPUT)).rejects.toThrow();
  });

  it("preserves the Postgres SQLSTATE via CommitAnswerTransactionError.code", async () => {
    mockRpc({
      data: null,
      error: { message: "stale pre-answer snapshot", code: COMMIT_ANSWER_ERROR_CODES.STALE_SNAPSHOT },
    });

    await expect(commitAnswerTransaction(BASE_INPUT)).rejects.toMatchObject({
      code: COMMIT_ANSWER_ERROR_CODES.STALE_SNAPSHOT,
    });
  });

  it("throws a CommitAnswerTransactionError instance on RPC failure, with a server-safe message and the raw error only in cause", async () => {
    const dbError = { message: "session is not an active session owned by user", code: "42501" };
    mockRpc({ data: null, error: dbError });

    try {
      await commitAnswerTransaction(BASE_INPUT);
      expect.unreachable("expected commitAnswerTransaction to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CommitAnswerTransactionError);
      const err = error as InstanceType<typeof CommitAnswerTransactionError>;
      expect(err.message).not.toContain("session is not an active session");
      expect(err.cause).toBe(dbError);
      expect(err.code).toBe("42501");
    }
  });

  it("performs no calculation/transformation on pass-through numeric/boolean fields", async () => {
    const rpc = mockRpc({ data: FRESH_RESULT, error: null });
    const input: CommitAnswerInput = {
      ...BASE_INPUT,
      baseDamage: 999,
      speedBonus: -1, // deliberately out-of-spec value -- must pass through unchanged, not be clamped
      comboAfter: 123,
      damage: 4567,
      enemyHpAfter: -50,
    };

    await commitAnswerTransaction(input);

    const [, params] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.p_base_damage).toBe(999);
    expect(params.p_speed_bonus).toBe(-1);
    expect(params.p_combo_after).toBe(123);
    expect(params.p_damage).toBe(4567);
    expect(params.p_enemy_hp_after).toBe(-50);
  });
});
