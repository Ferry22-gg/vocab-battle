import { describe, expect, it, vi } from "vitest";
import { Rating, State } from "ts-fsrs";
import type { Card } from "ts-fsrs";

/**
 * lib/learning/submit-answer.ts starts with `import "server-only"`. Same
 * test-environment-only shim as every other server-only module in this
 * project (see tests/unit/service-role.test.ts for the full explanation).
 * It does not touch the guarded module's own source.
 */
vi.mock("server-only", () => ({}));

const { runSubmitAnswer } = await import("@/lib/learning/submit-answer");
import type { SubmitAnswerDeps, SubmitAnswerInput } from "@/lib/learning/submit-answer";
import {
  CommitAnswerTransactionError,
  COMMIT_ANSWER_ERROR_CODES,
} from "@/lib/learning/commit-answer";
import type {
  CommitAnswerFreshResult,
  CommitAnswerReplayResult,
  CommittedAnswerEventRow,
  CommittedProfileSnapshot,
  CommittedSessionRow,
  CommittedUserCardProgressRow,
  CommittedXpEventRow,
} from "@/lib/learning/commit-answer";
import type { SessionRow } from "@/lib/sessions/dal";
import type { CardProgressRow } from "@/lib/learning/progress-dal";
import type { BattleCalculationResult } from "@/lib/learning/battle";
import type { UserCardProgressFsrsUpdate } from "@/lib/learning/fsrs";

const USER_ID = "trusted-user-id";
const NOW = new Date("2026-01-01T00:00:00.000Z");

const VALID_INPUT: SubmitAnswerInput = {
  clientEventId: "11111111-1111-1111-1111-111111111111",
  sessionId: "22222222-2222-2222-2222-222222222222",
  cardId: "33333333-3333-3333-3333-333333333333",
  correct: true,
  responseTimeMs: 1500,
};

const SESSION: SessionRow = {
  id: VALID_INPUT.sessionId,
  deck_id: "deck-1",
  status: "active",
  current_mode: "learning",
  current_combo: 2,
  current_enemy_type: "enemy_a",
  current_enemy_hp: 50,
  current_enemy_max_hp: 90,
  learning_draw_index: 5,
  engine_version: "legacy",
};

const PROGRESS: CardProgressRow = {
  card_status: "LEARNING",
  seen_count: 3,
  correct_streak: 2,
  wrong_streak: 0,
  fsrs_due_at: null,
  fsrs_stability: null,
  fsrs_difficulty: null,
  fsrs_elapsed_days: 0,
  fsrs_scheduled_days: 0,
  fsrs_reps: 0,
  fsrs_lapses: 0,
  fsrs_learning_steps: 0,
  fsrs_state: null,
  fsrs_last_review_at: null,
};

const RECENT_HISTORY: readonly boolean[] = [true, true, false];

const FAKE_CARD: Card = {
  due: NOW,
  stability: 0,
  difficulty: 0,
  elapsed_days: 0,
  scheduled_days: 0,
  learning_steps: 0,
  reps: 0,
  lapses: 0,
  state: State.New,
};

const FSRS_UPDATE: UserCardProgressFsrsUpdate = {
  fsrs_due_at: new Date("2026-01-10T00:00:00.000Z"),
  fsrs_stability: 2.3,
  fsrs_difficulty: 5.1,
  fsrs_elapsed_days: 0,
  fsrs_scheduled_days: 0,
  fsrs_reps: 1,
  fsrs_lapses: 0,
  fsrs_learning_steps: 1,
  fsrs_state: 1,
  fsrs_last_review_at: NOW,
};

const BATTLE_RESULT_NON_LETHAL: BattleCalculationResult = {
  baseDamage: 26,
  speedBonus: 2,
  comboBonus: 2,
  critical: false,
  comboAfter: 3,
  damage: 30,
  enemyHpAfter: 20,
  enemyDefeated: false,
  newEnemyType: null,
  newEnemyMaxHp: null,
  newEnemyHp: null,
};

const BATTLE_RESULT_LETHAL: BattleCalculationResult = {
  baseDamage: 26,
  speedBonus: 2,
  comboBonus: 2,
  critical: false,
  comboAfter: 3,
  damage: 50,
  enemyHpAfter: 0,
  enemyDefeated: true,
  newEnemyType: "enemy_c",
  newEnemyMaxHp: 160,
  newEnemyHp: 160,
};

const XP_EVENTS = [
  { reason: "correct_answer", amount: 2 },
] as unknown as readonly CommittedXpEventRow[];

function makeAnswerEvent(overrides: Record<string, unknown>): CommittedAnswerEventRow {
  return {
    fsrs_rating: "Good",
    correct: true,
    damage: 30,
    critical: false,
    combo: 3,
    enemy_hp_after: 20,
    ...overrides,
  } as unknown as CommittedAnswerEventRow;
}

const FRESH_SESSION_NON_LETHAL = {
  current_enemy_type: null,
  current_enemy_max_hp: null,
  current_enemy_hp: 20,
} as unknown as CommittedSessionRow;

const FRESH_SESSION_LETHAL = {
  current_enemy_type: "enemy_c",
  current_enemy_max_hp: 160,
  current_enemy_hp: 160,
} as unknown as CommittedSessionRow;

const FRESH_PROFILE = {
  total_xp: 42,
  level: 2,
  current_streak: 1,
  longest_streak: 3,
  last_daily_goal_completed_on: "2026-01-01",
} as unknown as CommittedProfileSnapshot;

const FRESH_PROGRESS_ROW = {} as unknown as CommittedUserCardProgressRow;

const FRESH_COMMIT_RESULT_NON_LETHAL: CommitAnswerFreshResult = {
  is_replay: false,
  answer_event: makeAnswerEvent({ enemy_hp_after: 20 }),
  xp_events: XP_EVENTS,
  daily_goal_just_completed: false,
  user_card_progress: FRESH_PROGRESS_ROW,
  session: FRESH_SESSION_NON_LETHAL,
  profile: FRESH_PROFILE,
};

const FRESH_COMMIT_RESULT_LETHAL: CommitAnswerFreshResult = {
  is_replay: false,
  answer_event: makeAnswerEvent({ enemy_hp_after: 0, damage: 50 }),
  xp_events: XP_EVENTS,
  daily_goal_just_completed: true,
  user_card_progress: FRESH_PROGRESS_ROW,
  session: FRESH_SESSION_LETHAL,
  profile: FRESH_PROFILE,
};

const REPLAY_COMMIT_RESULT: CommitAnswerReplayResult = {
  is_replay: true,
  answer_event: makeAnswerEvent({}),
  xp_events: XP_EVENTS,
  daily_goal_just_completed: false,
  user_card_progress: null,
  session: null,
  profile: null,
};

function createDeps(overrides: Partial<SubmitAnswerDeps> = {}): SubmitAnswerDeps {
  return {
    // Default: no existing answer_event for this clientEventId -- every
    // pre-D3b test exercises the normal (non-replay) flow unless it
    // explicitly overrides this.
    getAnswerEventByClientEventId: vi.fn().mockResolvedValue(null),
    getXpEventsForAnswerEvent: vi.fn().mockResolvedValue([]),
    getActiveSessionById: vi.fn().mockResolvedValue(SESSION),
    getCardProgress: vi.fn().mockResolvedValue(PROGRESS),
    getRecentAnswerHistory: vi.fn().mockResolvedValue(RECENT_HISTORY),
    estimateRating: vi.fn().mockReturnValue(Rating.Good),
    progressToFsrsCard: vi.fn().mockReturnValue(FAKE_CARD),
    advanceFsrs: vi.fn().mockReturnValue(FSRS_UPDATE),
    calculateBattleResult: vi.fn().mockReturnValue(BATTLE_RESULT_NON_LETHAL),
    commitAnswerTransaction: vi.fn().mockResolvedValue(FRESH_COMMIT_RESULT_NON_LETHAL),
    now: vi.fn().mockReturnValue(NOW),
    random: vi.fn().mockReturnValue(0.5),
    ...overrides,
  };
}

describe("runSubmitAnswer: input validation", () => {
  it("rejects a malformed clientEventId before any read", async () => {
    const deps = createDeps();
    const result = await runSubmitAnswer({ ...VALID_INPUT, clientEventId: "not-a-uuid" }, USER_ID, deps);

    expect(result).toEqual({ ok: false, code: "INVALID_INPUT", message: expect.any(String) });
    expect(deps.getActiveSessionById).not.toHaveBeenCalled();
  });

  it("rejects a malformed sessionId before any read", async () => {
    const deps = createDeps();
    const result = await runSubmitAnswer({ ...VALID_INPUT, sessionId: "not-a-uuid" }, USER_ID, deps);

    expect(result).toEqual({ ok: false, code: "INVALID_INPUT", message: expect.any(String) });
    expect(deps.getActiveSessionById).not.toHaveBeenCalled();
  });

  it("rejects a malformed cardId before any read", async () => {
    const deps = createDeps();
    const result = await runSubmitAnswer({ ...VALID_INPUT, cardId: "not-a-uuid" }, USER_ID, deps);

    expect(result).toEqual({ ok: false, code: "INVALID_INPUT", message: expect.any(String) });
    expect(deps.getActiveSessionById).not.toHaveBeenCalled();
  });

  it("rejects a negative responseTimeMs", async () => {
    const deps = createDeps();
    const result = await runSubmitAnswer({ ...VALID_INPUT, responseTimeMs: -1 }, USER_ID, deps);

    expect(result).toEqual({ ok: false, code: "INVALID_INPUT", message: expect.any(String) });
    expect(deps.getActiveSessionById).not.toHaveBeenCalled();
  });

  it("rejects a non-integer responseTimeMs", async () => {
    const deps = createDeps();
    const result = await runSubmitAnswer({ ...VALID_INPUT, responseTimeMs: 12.5 }, USER_ID, deps);

    expect(result).toEqual({ ok: false, code: "INVALID_INPUT", message: expect.any(String) });
    expect(deps.getActiveSessionById).not.toHaveBeenCalled();
  });

  it("does not invent an upper bound on responseTimeMs (none exists in the schema)", async () => {
    const deps = createDeps();
    const result = await runSubmitAnswer({ ...VALID_INPUT, responseTimeMs: 10_000_000 }, USER_ID, deps);

    expect(result.ok).toBe(true);
  });
});

describe("runSubmitAnswer: trust boundary", () => {
  it("uses the passed-in userId (never anything from input) for the RPC identity", async () => {
    const deps = createDeps();

    await runSubmitAnswer(VALID_INPUT, "a-specific-trusted-user-id", deps);

    const commitInput = vi.mocked(deps.commitAnswerTransaction).mock.calls[0][0];
    expect(commitInput.userId).toBe("a-specific-trusted-user-id");
  });

  it("takes sessionMode from the session row, not from input", async () => {
    const deps = createDeps({
      getActiveSessionById: vi.fn().mockResolvedValue({ ...SESSION, current_mode: "review" }),
    });

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    const commitInput = vi.mocked(deps.commitAnswerTransaction).mock.calls[0][0];
    expect(commitInput.sessionMode).toBe("review");
  });

  it("takes combo/enemy values from the session row for the battle calculation", async () => {
    const deps = createDeps({
      getActiveSessionById: vi.fn().mockResolvedValue({
        ...SESSION,
        current_combo: 7,
        current_enemy_hp: 33,
      }),
    });

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    const battleInput = vi.mocked(deps.calculateBattleResult).mock.calls[0][0];
    expect(battleInput.comboBefore).toBe(7);
    expect(battleInput.enemyHpBefore).toBe(33);

    const commitInput = vi.mocked(deps.commitAnswerTransaction).mock.calls[0][0];
    expect(commitInput.expectedSessionComboBefore).toBe(7);
    expect(commitInput.expectedSessionEnemyHpBefore).toBe(33);
  });

  it("passes seenCount = progress.seen_count + 1 to estimateRating (Phase C3 post-increment contract)", async () => {
    const deps = createDeps({
      getCardProgress: vi.fn().mockResolvedValue({ ...PROGRESS, seen_count: 9 }),
    });

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    const ratingInput = vi.mocked(deps.estimateRating).mock.calls[0][0];
    expect(ratingInput.seenCount).toBe(10);
  });

  it("forwards getRecentAnswerHistory's result to estimateRating unchanged", async () => {
    const history = [false, true, true];
    const deps = createDeps({ getRecentAnswerHistory: vi.fn().mockResolvedValue(history) });

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    const ratingInput = vi.mocked(deps.estimateRating).mock.calls[0][0];
    expect(ratingInput.recentAnswerHistory).toBe(history);
  });

  it("fails safely (COMMIT_FAILED, no fabricated battle state) when the session has null enemy fields", async () => {
    const deps = createDeps({
      getActiveSessionById: vi.fn().mockResolvedValue({ ...SESSION, current_enemy_hp: null }),
    });

    const result = await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(result).toEqual({ ok: false, code: "COMMIT_FAILED", message: expect.any(String) });
    expect(deps.calculateBattleResult).not.toHaveBeenCalled();
    expect(deps.commitAnswerTransaction).not.toHaveBeenCalled();
  });
});

describe("runSubmitAnswer: orchestration sequencing/mapping", () => {
  it("feeds the rating estimator's output into advanceFsrs as the grade", async () => {
    const deps = createDeps({ estimateRating: vi.fn().mockReturnValue(Rating.Easy) });

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    const [, , grade] = vi.mocked(deps.advanceFsrs).mock.calls[0];
    expect(grade).toBe(Rating.Easy);
  });

  it("maps advanceFsrs's output into CommitAnswerInput's fsrs* fields exactly", async () => {
    const deps = createDeps();

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    const commitInput = vi.mocked(deps.commitAnswerTransaction).mock.calls[0][0];
    expect(commitInput.fsrsDueAt).toBe(FSRS_UPDATE.fsrs_due_at);
    expect(commitInput.fsrsStability).toBe(FSRS_UPDATE.fsrs_stability);
    expect(commitInput.fsrsDifficulty).toBe(FSRS_UPDATE.fsrs_difficulty);
    expect(commitInput.fsrsElapsedDays).toBe(FSRS_UPDATE.fsrs_elapsed_days);
    expect(commitInput.fsrsScheduledDays).toBe(FSRS_UPDATE.fsrs_scheduled_days);
    expect(commitInput.fsrsReps).toBe(FSRS_UPDATE.fsrs_reps);
    expect(commitInput.fsrsLapses).toBe(FSRS_UPDATE.fsrs_lapses);
    expect(commitInput.fsrsLearningSteps).toBe(FSRS_UPDATE.fsrs_learning_steps);
    expect(commitInput.fsrsState).toBe(FSRS_UPDATE.fsrs_state);
    expect(commitInput.fsrsLastReviewAt).toBe(FSRS_UPDATE.fsrs_last_review_at);
  });

  it("maps calculateBattleResult's output into CommitAnswerInput's battle fields exactly", async () => {
    const deps = createDeps({ calculateBattleResult: vi.fn().mockReturnValue(BATTLE_RESULT_LETHAL) });

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    const commitInput = vi.mocked(deps.commitAnswerTransaction).mock.calls[0][0];
    expect(commitInput.baseDamage).toBe(BATTLE_RESULT_LETHAL.baseDamage);
    expect(commitInput.speedBonus).toBe(BATTLE_RESULT_LETHAL.speedBonus);
    expect(commitInput.critical).toBe(BATTLE_RESULT_LETHAL.critical);
    expect(commitInput.comboAfter).toBe(BATTLE_RESULT_LETHAL.comboAfter);
    expect(commitInput.damage).toBe(BATTLE_RESULT_LETHAL.damage);
    expect(commitInput.enemyHpAfter).toBe(BATTLE_RESULT_LETHAL.enemyHpAfter);
    expect(commitInput.enemyDefeated).toBe(BATTLE_RESULT_LETHAL.enemyDefeated);
    expect(commitInput.newEnemyType).toBe(BATTLE_RESULT_LETHAL.newEnemyType);
    expect(commitInput.newEnemyMaxHp).toBe(BATTLE_RESULT_LETHAL.newEnemyMaxHp);
    expect(commitInput.newEnemyHp).toBe(BATTLE_RESULT_LETHAL.newEnemyHp);
  });

  it("forwards clientEventId unchanged", async () => {
    const deps = createDeps();

    await runSubmitAnswer({ ...VALID_INPUT, clientEventId: "44444444-4444-4444-4444-444444444444" }, USER_ID, deps);

    const commitInput = vi.mocked(deps.commitAnswerTransaction).mock.calls[0][0];
    expect(commitInput.clientEventId).toBe("44444444-4444-4444-4444-444444444444");
  });

  it("builds the expected-before card snapshot from the progress row", async () => {
    const deps = createDeps({
      getCardProgress: vi.fn().mockResolvedValue({
        ...PROGRESS,
        card_status: "FORGOTTEN",
        seen_count: 8,
        correct_streak: 0,
        wrong_streak: 2,
        fsrs_due_at: new Date("2025-12-01T00:00:00.000Z"),
      }),
    });

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    const commitInput = vi.mocked(deps.commitAnswerTransaction).mock.calls[0][0];
    expect(commitInput.expectedCardStatusBefore).toBe("FORGOTTEN");
    expect(commitInput.expectedSeenCountBefore).toBe(8);
    expect(commitInput.expectedCorrectStreakBefore).toBe(0);
    expect(commitInput.expectedWrongStreakBefore).toBe(2);
    expect(commitInput.expectedFsrsDueBefore).toEqual(new Date("2025-12-01T00:00:00.000Z"));
  });

  it("always supplies expectedSessionLearningDrawIndex, even in review mode", async () => {
    const deps = createDeps({
      getActiveSessionById: vi.fn().mockResolvedValue({
        ...SESSION,
        current_mode: "review",
        learning_draw_index: 12,
      }),
    });

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    const commitInput = vi.mocked(deps.commitAnswerTransaction).mock.calls[0][0];
    expect(commitInput.expectedSessionLearningDrawIndex).toBe(12);
  });

  it("calls commitAnswerTransaction exactly once", async () => {
    const deps = createDeps();

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(deps.commitAnswerTransaction).toHaveBeenCalledTimes(1);
  });

  it("uses a single `now` for both progressToFsrsCard and advanceFsrs", async () => {
    const deps = createDeps();

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    const [, nowForCard] = vi.mocked(deps.progressToFsrsCard).mock.calls[0];
    const [, nowForAdvance] = vi.mocked(deps.advanceFsrs).mock.calls[0];
    expect(nowForCard).toBe(NOW);
    expect(nowForAdvance).toBe(NOW);
  });
});

describe("runSubmitAnswer: wrong answer", () => {
  it("still advances FSRS with Again when correct is false", async () => {
    const deps = createDeps({ estimateRating: vi.fn().mockReturnValue(Rating.Again) });

    await runSubmitAnswer({ ...VALID_INPUT, correct: false }, USER_ID, deps);

    const ratingInput = vi.mocked(deps.estimateRating).mock.calls[0][0];
    expect(ratingInput.correct).toBe(false);
    const [, , grade] = vi.mocked(deps.advanceFsrs).mock.calls[0];
    expect(grade).toBe(Rating.Again);
  });

  it("passes through battle.ts's zero/reset Wrong-answer result unmodified", async () => {
    const wrongBattleResult: BattleCalculationResult = {
      baseDamage: 0,
      speedBonus: 0,
      comboBonus: 0,
      critical: false,
      comboAfter: 0,
      damage: 0,
      enemyHpAfter: SESSION.current_enemy_hp as number,
      enemyDefeated: false,
      newEnemyType: null,
      newEnemyMaxHp: null,
      newEnemyHp: null,
    };
    const deps = createDeps({ calculateBattleResult: vi.fn().mockReturnValue(wrongBattleResult) });

    await runSubmitAnswer({ ...VALID_INPUT, correct: false }, USER_ID, deps);

    const battleInput = vi.mocked(deps.calculateBattleResult).mock.calls[0][0];
    expect(battleInput.correct).toBe(false);

    const commitInput = vi.mocked(deps.commitAnswerTransaction).mock.calls[0][0];
    expect(commitInput.baseDamage).toBe(0);
    expect(commitInput.damage).toBe(0);
    expect(commitInput.comboAfter).toBe(0);
    expect(commitInput.critical).toBe(false);
  });
});

describe("runSubmitAnswer: fresh success", () => {
  it("shapes a browser-safe result with no raw DB rows leaked", async () => {
    const deps = createDeps({
      commitAnswerTransaction: vi.fn().mockResolvedValue(FRESH_COMMIT_RESULT_NON_LETHAL),
    });

    const result = await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isReplay).toBe(false);
    expect(result.data).toEqual({
      isReplay: false,
      rating: "Good",
      correct: true,
      damage: 30,
      critical: false,
      comboAfter: 3,
      enemyHpAfter: 20,
      enemyDefeated: false,
      dailyGoalJustCompleted: false,
      xpEvents: [{ reason: "correct_answer", amount: 2 }],
      totalXpAwarded: 2,
      cardMasteredJustNow: false,
      fullMasteryJustAchieved: null,
      newEnemyType: null,
      newEnemyMaxHp: null,
      newEnemyHp: null,
      totalXp: 42,
      level: 2,
      currentStreak: 1,
      longestStreak: 3,
      lastDailyGoalCompletedOn: "2026-01-01",
    });

    // No internal/DB-only identifiers anywhere in the result.
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toMatch(/user_id|session_id|card_id|client_event_id/);
  });

  it("reports the newly spawned enemy only when the enemy was defeated", async () => {
    const deps = createDeps({
      commitAnswerTransaction: vi.fn().mockResolvedValue(FRESH_COMMIT_RESULT_LETHAL),
    });

    const result = await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(result.ok).toBe(true);
    if (!result.ok || result.data.isReplay) return;
    expect(result.data.enemyDefeated).toBe(true);
    expect(result.data.newEnemyType).toBe("enemy_c");
    expect(result.data.newEnemyMaxHp).toBe(160);
    expect(result.data.newEnemyHp).toBe(160);
  });
});

describe("runSubmitAnswer: replay", () => {
  it("is treated as a successful result without a second calculation/write", async () => {
    const deps = createDeps({ commitAnswerTransaction: vi.fn().mockResolvedValue(REPLAY_COMMIT_RESULT) });

    const result = await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(result.ok).toBe(true);
    expect(deps.commitAnswerTransaction).toHaveBeenCalledTimes(1);
  });

  it("never dereferences the fresh-only null session/profile fields", async () => {
    const deps = createDeps({ commitAnswerTransaction: vi.fn().mockResolvedValue(REPLAY_COMMIT_RESULT) });

    await expect(runSubmitAnswer(VALID_INPUT, USER_ID, deps)).resolves.not.toThrow();
  });

  it("shapes historical answer_event/xp_events data, with isReplay true and no fresh-only fields", async () => {
    const deps = createDeps({ commitAnswerTransaction: vi.fn().mockResolvedValue(REPLAY_COMMIT_RESULT) });

    const result = await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      isReplay: true,
      rating: "Good",
      correct: true,
      damage: 30,
      critical: false,
      comboAfter: 3,
      enemyHpAfter: 20,
      enemyDefeated: false,
      dailyGoalJustCompleted: false,
      xpEvents: [{ reason: "correct_answer", amount: 2 }],
      totalXpAwarded: 2,
      cardMasteredJustNow: false,
      fullMasteryJustAchieved: null,
    });
    expect(result.data).not.toHaveProperty("newEnemyType");
    expect(result.data).not.toHaveProperty("totalXp");
    expect(result.data).not.toHaveProperty("level");
  });
});

describe("runSubmitAnswer: early replay lookup (D3b)", () => {
  const EXISTING_ANSWER_EVENT = makeAnswerEvent({
    id: "existing-answer-event-1",
    session_id: VALID_INPUT.sessionId,
    card_id: VALID_INPUT.cardId,
    fsrs_rating: "Hard",
    damage: 40,
    critical: true,
    combo: 5,
    enemy_hp_after: 10,
  });
  const EXISTING_XP_EVENTS = [
    { reason: "correct_answer", amount: 2 },
    { reason: "daily_goal_completed", amount: 30 },
  ] as unknown as readonly CommittedXpEventRow[];

  it("short-circuits before any session/progress/history read", async () => {
    const deps = createDeps({
      getAnswerEventByClientEventId: vi.fn().mockResolvedValue(EXISTING_ANSWER_EVENT),
      getXpEventsForAnswerEvent: vi.fn().mockResolvedValue(EXISTING_XP_EVENTS),
    });

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(deps.getActiveSessionById).not.toHaveBeenCalled();
    expect(deps.getCardProgress).not.toHaveBeenCalled();
    expect(deps.getRecentAnswerHistory).not.toHaveBeenCalled();
  });

  it("does not recalculate the rating", async () => {
    const deps = createDeps({
      getAnswerEventByClientEventId: vi.fn().mockResolvedValue(EXISTING_ANSWER_EVENT),
      getXpEventsForAnswerEvent: vi.fn().mockResolvedValue(EXISTING_XP_EVENTS),
    });

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(deps.estimateRating).not.toHaveBeenCalled();
  });

  it("does not advance FSRS", async () => {
    const deps = createDeps({
      getAnswerEventByClientEventId: vi.fn().mockResolvedValue(EXISTING_ANSWER_EVENT),
      getXpEventsForAnswerEvent: vi.fn().mockResolvedValue(EXISTING_XP_EVENTS),
    });

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(deps.progressToFsrsCard).not.toHaveBeenCalled();
    expect(deps.advanceFsrs).not.toHaveBeenCalled();
  });

  it("does not consume battle RNG (calculateBattleResult never called)", async () => {
    const deps = createDeps({
      getAnswerEventByClientEventId: vi.fn().mockResolvedValue(EXISTING_ANSWER_EVENT),
      getXpEventsForAnswerEvent: vi.fn().mockResolvedValue(EXISTING_XP_EVENTS),
    });

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(deps.calculateBattleResult).not.toHaveBeenCalled();
    expect(deps.random).not.toHaveBeenCalled();
  });

  it("does not call commitAnswerTransaction when the early lookup fully resolves the retry", async () => {
    const deps = createDeps({
      getAnswerEventByClientEventId: vi.fn().mockResolvedValue(EXISTING_ANSWER_EVENT),
      getXpEventsForAnswerEvent: vi.fn().mockResolvedValue(EXISTING_XP_EVENTS),
    });

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(deps.commitAnswerTransaction).not.toHaveBeenCalled();
  });

  it("shapes the replay result from the historical answer_event/xp_events data", async () => {
    const deps = createDeps({
      getAnswerEventByClientEventId: vi.fn().mockResolvedValue(EXISTING_ANSWER_EVENT),
      getXpEventsForAnswerEvent: vi.fn().mockResolvedValue(EXISTING_XP_EVENTS),
    });

    const result = await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      isReplay: true,
      rating: "Hard",
      correct: true,
      damage: 40,
      critical: true,
      comboAfter: 5,
      enemyHpAfter: 10,
      enemyDefeated: false,
      dailyGoalJustCompleted: true,
      xpEvents: [
        { reason: "correct_answer", amount: 2 },
        { reason: "daily_goal_completed", amount: 30 },
      ],
      totalXpAwarded: 32,
      cardMasteredJustNow: false,
      fullMasteryJustAchieved: null,
    });
  });

  it("looks up the answer event scoped only by clientEventId (no explicit userId argument -- relies on RLS)", async () => {
    const deps = createDeps({
      getAnswerEventByClientEventId: vi.fn().mockResolvedValue(EXISTING_ANSWER_EVENT),
      getXpEventsForAnswerEvent: vi.fn().mockResolvedValue(EXISTING_XP_EVENTS),
    });

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(deps.getAnswerEventByClientEventId).toHaveBeenCalledWith(VALID_INPUT.clientEventId);
    expect(vi.mocked(deps.getAnswerEventByClientEventId).mock.calls[0]).toHaveLength(1);
  });

  it("falls through to the normal flow when the found event's session/card do not match this input", async () => {
    const deps = createDeps({
      getAnswerEventByClientEventId: vi.fn().mockResolvedValue(
        makeAnswerEvent({ session_id: "a-different-session", card_id: VALID_INPUT.cardId }),
      ),
    });

    await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(deps.getActiveSessionById).toHaveBeenCalledTimes(1);
    expect(deps.commitAnswerTransaction).toHaveBeenCalledTimes(1);
  });

  it("proceeds normally when no existing answer event is found", async () => {
    const deps = createDeps({ getAnswerEventByClientEventId: vi.fn().mockResolvedValue(null) });

    const result = await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(result.ok).toBe(true);
    expect(deps.getActiveSessionById).toHaveBeenCalledTimes(1);
    expect(deps.commitAnswerTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("runSubmitAnswer: errors", () => {
  it("maps a stale-snapshot SQLSTATE to STALE_STATE", async () => {
    const deps = createDeps({
      commitAnswerTransaction: vi.fn().mockRejectedValue(
        new CommitAnswerTransactionError("commit_answer_transaction RPC call failed", {
          code: COMMIT_ANSWER_ERROR_CODES.STALE_SNAPSHOT,
          cause: { message: "stale pre-answer snapshot for card X in session Y" },
        }),
      ),
    });

    const result = await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(result).toEqual({ ok: false, code: "STALE_STATE", message: expect.any(String) });
  });

  it("maps an inaccessible/missing session to NOT_FOUND_OR_INACCESSIBLE without a DB read error", async () => {
    const deps = createDeps({ getActiveSessionById: vi.fn().mockResolvedValue(null) });

    const result = await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(result).toEqual({ ok: false, code: "NOT_FOUND_OR_INACCESSIBLE", message: expect.any(String) });
    expect(deps.commitAnswerTransaction).not.toHaveBeenCalled();
  });

  it("maps an inaccessible/missing card progress to NOT_FOUND_OR_INACCESSIBLE", async () => {
    const deps = createDeps({ getCardProgress: vi.fn().mockResolvedValue(null) });

    const result = await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(result).toEqual({ ok: false, code: "NOT_FOUND_OR_INACCESSIBLE", message: expect.any(String) });
    expect(deps.commitAnswerTransaction).not.toHaveBeenCalled();
  });

  it("maps any other RPC failure to COMMIT_FAILED without leaking raw DB error details", async () => {
    const sensitiveDbMessage = "duplicate key value violates unique constraint answer_events_pkey";
    const deps = createDeps({
      commitAnswerTransaction: vi.fn().mockRejectedValue(
        new CommitAnswerTransactionError("commit_answer_transaction RPC call failed", {
          code: "23505",
          cause: { message: sensitiveDbMessage },
        }),
      ),
    });

    const result = await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("COMMIT_FAILED");
    expect(result.message).not.toContain(sensitiveDbMessage);
    expect(JSON.stringify(result)).not.toContain(sensitiveDbMessage);
  });

  it("maps a non-CommitAnswerTransactionError thrown by the RPC boundary to COMMIT_FAILED", async () => {
    const deps = createDeps({
      commitAnswerTransaction: vi.fn().mockRejectedValue(new Error("unexpected network failure")),
    });

    const result = await runSubmitAnswer(VALID_INPUT, USER_ID, deps);

    expect(result).toEqual({ ok: false, code: "COMMIT_FAILED", message: expect.any(String) });
  });
});
