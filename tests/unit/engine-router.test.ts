import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for Learning Engine v1 Runtime Cutover RC-D's live Session
 * routing seam (lib/learning/engine-router.ts). No DB access -- every
 * trusted dependency is mocked, so this file exercises only the routing
 * decision itself (which provider is called, with what arguments, and
 * how its result is adapted into the shared presentation/result shape).
 *
 * Session-creation/resume engine-assignment itself lives entirely in SQL
 * (start_or_resume_session(), RC-D migration 20261017000000) and is
 * covered by supabase/tests/021_learning_engine_v1_runtime_cutover_rc_d_test.sql
 * -- there is no TypeScript orchestration for that decision to unit-test
 * here.
 */

vi.mock("server-only", () => ({}));

const getActiveSessionById = vi.fn();
const getNextSessionCard = vi.fn();
const getSessionEngineVersion = vi.fn();

vi.mock("@/lib/sessions/dal", () => ({
  getActiveSessionById,
  getNextSessionCard,
  getSessionEngineVersion,
}));

const claimNextLearningEngineCard = vi.fn();
vi.mock("@/lib/learning-engine/runtime/claim-next-card", () => ({
  claimNextLearningEngineCard,
}));

const commitLearningEngineAnswer = vi.fn();
class CommitRetryExhaustedError extends Error {}
vi.mock("@/lib/learning-engine/runtime/commit-answer", () => ({
  commitLearningEngineAnswer,
  CommitRetryExhaustedError,
}));

const runSubmitAnswer = vi.fn();
const defaultSubmitAnswerDeps = { marker: "legacy-deps" };
function validateInput(input: { clientEventId: string }) {
  if (!input.clientEventId) {
    return { ok: false, code: "INVALID_INPUT", message: "invalid" };
  }
  return null;
}
vi.mock("@/lib/learning/submit-answer", () => ({
  runSubmitAnswer,
  defaultSubmitAnswerDeps,
  validateInput,
}));

const supabaseFrom = vi.fn();
const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient }));

const { getNextSessionCardForEngine, submitAnswerForEngine, submitAnswerAndAdvance } = await import(
  "@/lib/learning/engine-router"
);

afterEach(() => {
  vi.clearAllMocks();
});

const USER_ID = "user-1";
const SESSION_ID = "session-1";

const LEGACY_SESSION = {
  id: SESSION_ID,
  deck_id: "deck-1",
  status: "active",
  current_mode: "learning",
  current_combo: 2,
  current_enemy_type: "enemy_a",
  current_enemy_hp: 50,
  current_enemy_max_hp: 90,
  learning_draw_index: 3,
  engine_version: "legacy",
};

const V1_SESSION = { ...LEGACY_SESSION, engine_version: "v1" };

function mockCardContentRead(row: { front: string; back: string } | null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  supabaseFrom.mockReturnValue({ select });
  createClient.mockResolvedValue({ from: supabaseFrom });
}

describe("getNextSessionCardForEngine", () => {
  it("returns not_found when the session does not exist/is inaccessible", async () => {
    getActiveSessionById.mockResolvedValue(null);

    const result = await getNextSessionCardForEngine(USER_ID, SESSION_ID);

    expect(result).toEqual({ status: "not_found" });
    expect(getNextSessionCard).not.toHaveBeenCalled();
    expect(claimNextLearningEngineCard).not.toHaveBeenCalled();
  });

  it("legacy session -> routes to legacy getNextSessionCard(), never claimNextLearningEngineCard()", async () => {
    getActiveSessionById.mockResolvedValue(LEGACY_SESSION);
    getNextSessionCard.mockResolvedValue({ status: "ok", sessionId: SESSION_ID, claimId: null });

    const result = await getNextSessionCardForEngine(USER_ID, SESSION_ID);

    expect(getNextSessionCard).toHaveBeenCalledWith(SESSION_ID);
    expect(claimNextLearningEngineCard).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "ok", sessionId: SESSION_ID, claimId: null });
  });

  it("v1 session -> routes to RC-B's claimNextLearningEngineCard(), never legacy getNextSessionCard()", async () => {
    getActiveSessionById.mockResolvedValue(V1_SESSION);
    claimNextLearningEngineCard.mockResolvedValue({ reused: false, cardId: "card-1", claimId: "claim-1" });
    mockCardContentRead({ front: "ubiquitous", back: "遍在する" });

    const result = await getNextSessionCardForEngine(USER_ID, SESSION_ID);

    expect(claimNextLearningEngineCard).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    expect(getNextSessionCard).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "ok",
      sessionId: SESSION_ID,
      sessionMode: "learning",
      cardId: "card-1",
      front: "ubiquitous",
      back: "遍在する",
      enemyType: "enemy_a",
      enemyHp: 50,
      enemyMaxHp: 90,
      combo: 2,
      claimId: "claim-1",
    });
  });

  it("v1 reload with an existing OPEN claim returns the SAME claim id (RC-B's own idempotent fast path, surfaced unchanged)", async () => {
    getActiveSessionById.mockResolvedValue(V1_SESSION);
    claimNextLearningEngineCard.mockResolvedValue({ reused: true, cardId: "card-1", claimId: "claim-1" });
    mockCardContentRead({ front: "ubiquitous", back: "遍在する" });

    const first = await getNextSessionCardForEngine(USER_ID, SESSION_ID);
    const second = await getNextSessionCardForEngine(USER_ID, SESSION_ID);

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status === "ok" && second.status === "ok") {
      expect(second.claimId).toBe(first.claimId);
      expect(second.cardId).toBe(first.cardId);
    }
  });

  it("v1 session with no selectable card maps to a no_card result, not an error", async () => {
    getActiveSessionById.mockResolvedValue(V1_SESSION);
    claimNextLearningEngineCard.mockResolvedValue({ reused: false, cardId: null, claimId: null });

    const result = await getNextSessionCardForEngine(USER_ID, SESSION_ID);

    expect(result).toEqual({ status: "no_card", reason: "LEARNING_ENGINE_V1_NO_CARD" });
  });

  it("v1 session missing Battle state maps to the same SESSION_MISSING_BATTLE_STATE error legacy uses", async () => {
    getActiveSessionById.mockResolvedValue({ ...V1_SESSION, current_enemy_type: null });

    const result = await getNextSessionCardForEngine(USER_ID, SESSION_ID);

    expect(result).toEqual({ status: "error", reason: "SESSION_MISSING_BATTLE_STATE" });
    expect(claimNextLearningEngineCard).not.toHaveBeenCalled();
  });

  it("the UI-facing card shape never carries scheduler/policy/source internals", async () => {
    getActiveSessionById.mockResolvedValue(V1_SESSION);
    claimNextLearningEngineCard.mockResolvedValue({
      reused: false,
      cardId: "card-1",
      claimId: "claim-1",
      selectionTraceId: "trace-1",
      schedulerPosition: 4,
      schedulerRevision: 1,
    });
    mockCardContentRead({ front: "ubiquitous", back: "遍在する" });

    const result = await getNextSessionCardForEngine(USER_ID, SESSION_ID);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/selectionTraceId|schedulerPosition|schedulerRevision|source|policy/i);
  });
});

describe("submitAnswerForEngine", () => {
  const BASE_INPUT = {
    clientEventId: "11111111-1111-1111-1111-111111111111",
    sessionId: SESSION_ID,
    cardId: "card-1",
    correct: true,
    responseTimeMs: 1200,
  };

  it("legacy session -> routes to runSubmitAnswer(), never commitLearningEngineAnswer()", async () => {
    getSessionEngineVersion.mockResolvedValue("legacy");
    runSubmitAnswer.mockResolvedValue({ ok: true, data: { isReplay: false } });

    const result = await submitAnswerForEngine(BASE_INPUT, USER_ID);

    expect(runSubmitAnswer).toHaveBeenCalledWith(BASE_INPUT, USER_ID, defaultSubmitAnswerDeps);
    expect(commitLearningEngineAnswer).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: { isReplay: false } });
  });

  it("an unknown/inaccessible session falls through to the legacy path (its own existing NOT_FOUND_OR_INACCESSIBLE handling)", async () => {
    getSessionEngineVersion.mockResolvedValue(null);
    runSubmitAnswer.mockResolvedValue({ ok: false, code: "NOT_FOUND_OR_INACCESSIBLE", message: "not found" });

    const result = await submitAnswerForEngine(BASE_INPUT, USER_ID);

    expect(runSubmitAnswer).toHaveBeenCalled();
    expect(commitLearningEngineAnswer).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, code: "NOT_FOUND_OR_INACCESSIBLE", message: "not found" });
  });

  it("v1 session -> routes to RC-C's commitLearningEngineAnswer() with the exact claim id supplied, never runSubmitAnswer()", async () => {
    getSessionEngineVersion.mockResolvedValue("v1");
    commitLearningEngineAnswer.mockResolvedValue({
      isReplay: false,
      cardMasteredJustNow: false,
      fullMasteryJustAchieved: false,
      dailyGoalJustCompleted: false,
      xpEvents: [],
      rating: "Good",
      battle: {
        damage: 30,
        critical: false,
        comboAfter: 3,
        enemyHpAfter: 20,
        enemyDefeated: false,
        newEnemyType: null,
        newEnemyMaxHp: null,
        newEnemyHp: null,
      },
      session: { current_enemy_type: "enemy_a", current_enemy_max_hp: 90, current_enemy_hp: 20 },
      profile: { total_xp: 10, level: 1, current_streak: 0, longest_streak: 0, last_daily_goal_completed_on: null },
    });

    const result = await submitAnswerForEngine({ ...BASE_INPUT, claimId: "claim-1" }, USER_ID);

    expect(commitLearningEngineAnswer).toHaveBeenCalledWith(
      USER_ID,
      SESSION_ID,
      "claim-1",
      { clientEventId: BASE_INPUT.clientEventId, correct: true, responseTimeMs: 1200, timeToFirstActionMs: null },
    );
    expect(runSubmitAnswer).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.isReplay).toBe(false);
      expect(result.data.damage).toBe(30);
      expect(result.data.comboAfter).toBe(3);
      expect(result.data.rating).toBe("Good");
    }
  });

  it("v1 session with no claimId is rejected as INVALID_INPUT -- never silently guesses a claim", async () => {
    getSessionEngineVersion.mockResolvedValue("v1");

    const result = await submitAnswerForEngine({ ...BASE_INPUT, claimId: null }, USER_ID);

    expect(result).toEqual({ ok: false, code: "INVALID_INPUT", message: "claimId is required for this session." });
    expect(commitLearningEngineAnswer).not.toHaveBeenCalled();
  });

  it("v1 commit retry exhaustion under persistent staleness maps to STALE_STATE, mirroring the legacy mapping", async () => {
    getSessionEngineVersion.mockResolvedValue("v1");
    commitLearningEngineAnswer.mockRejectedValue(new CommitRetryExhaustedError("exhausted"));

    const result = await submitAnswerForEngine({ ...BASE_INPUT, claimId: "claim-1" }, USER_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("STALE_STATE");
    }
  });

  it("any other v1 commit rejection maps to a generic COMMIT_FAILED -- never leaks the raw error", async () => {
    getSessionEngineVersion.mockResolvedValue("v1");
    commitLearningEngineAnswer.mockRejectedValue(new Error("claim is not OPEN"));

    const result = await submitAnswerForEngine({ ...BASE_INPUT, claimId: "claim-1" }, USER_ID);

    expect(result).toEqual({
      ok: false,
      code: "COMMIT_FAILED",
      message: "Something went wrong submitting your answer. Please try again.",
    });
  });

  it("a v1 replay returns the FAITHFUL historical Battle result, never a placeholder -- same damage/critical/comboAfter/enemyHpAfter the original answer actually produced", async () => {
    getSessionEngineVersion.mockResolvedValue("v1");
    commitLearningEngineAnswer.mockResolvedValue({
      isReplay: true,
      cardMasteredJustNow: false,
      fullMasteryJustAchieved: null,
      dailyGoalJustCompleted: true,
      xpEvents: [{ reason: "enemy_defeated", amount: 20 }],
      rating: null,
      // Runtime Cutover RC-D battle-replay-fidelity correction:
      // commit-answer.ts now always reconstructs this from the
      // historical persisted row -- never null, never zeroed.
      battle: {
        damage: 42,
        critical: true,
        comboAfter: 7,
        enemyHpAfter: 0,
        enemyDefeated: true,
        newEnemyType: null,
        newEnemyMaxHp: null,
        newEnemyHp: null,
      },
      session: null,
      profile: null,
    });

    const result = await submitAnswerForEngine({ ...BASE_INPUT, claimId: "claim-1" }, USER_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.isReplay).toBe(true);
      expect(result.data.damage).toBe(42);
      expect(result.data.critical).toBe(true);
      expect(result.data.comboAfter).toBe(7);
      expect(result.data.enemyHpAfter).toBe(0);
      expect(result.data.enemyDefeated).toBe(true);
      expect(result.data.dailyGoalJustCompleted).toBe(true);
      expect(result.data).not.toHaveProperty("newEnemyType");
    }
  });

  it("never trusts a client-supplied engine_version -- there is no such field on the input type at all", () => {
    const input: Record<string, unknown> = { ...BASE_INPUT };
    expect(Object.keys(input)).not.toContain("engineVersion");
    expect(Object.keys(input)).not.toContain("engine_version");
  });
});

/**
 * Alpha performance optimization #2: submitAnswerAndAdvance() collapses the
 * Session UI's two separate browser round trips (submitAnswer, then a
 * separate next-card fetch) into one server-side call. These tests prove
 * only the OUTER orchestration this adds -- that the next-card fetch is
 * attempted if and only if the commit succeeded, that a thrown next-card
 * error never loses the already-committed answer result, and that neither
 * underlying trusted call (submitAnswerForEngine / getNextSessionCardForEngine,
 * exercised in full above) is called more than once or with different
 * arguments than before. No new DB access, no new RPC, no new Session card
 * shape -- this is pure composition of the two functions already covered
 * above.
 */
describe("submitAnswerAndAdvance", () => {
  const BASE_INPUT = {
    clientEventId: "22222222-2222-2222-2222-222222222222",
    sessionId: SESSION_ID,
    cardId: "card-1",
    correct: true,
    responseTimeMs: 900,
    claimId: "claim-1",
  };

  const FRESH_SUCCESS_DATA = {
    isReplay: false,
    cardMasteredJustNow: false,
    fullMasteryJustAchieved: false,
    dailyGoalJustCompleted: false,
    xpEvents: [],
    rating: "Good",
    battle: {
      damage: 10,
      critical: false,
      comboAfter: 1,
      enemyHpAfter: 80,
      enemyDefeated: false,
      newEnemyType: null,
      newEnemyMaxHp: null,
      newEnemyHp: null,
    },
    session: { current_enemy_type: "enemy_a", current_enemy_max_hp: 90, current_enemy_hp: 80 },
    profile: { total_xp: 5, level: 1, current_streak: 0, longest_streak: 0, last_daily_goal_completed_on: null },
  };

  it("commit succeeds, next card fetched successfully -> both returned in one call, nextCardFailed is false", async () => {
    getSessionEngineVersion.mockResolvedValue("v1");
    commitLearningEngineAnswer.mockResolvedValue(FRESH_SUCCESS_DATA);
    getActiveSessionById.mockResolvedValue(V1_SESSION);
    claimNextLearningEngineCard.mockResolvedValue({ reused: false, cardId: "card-2", claimId: "claim-2" });
    mockCardContentRead({ front: "sedulous", back: "勤勉な" });

    const result = await submitAnswerAndAdvance(BASE_INPUT, USER_ID);

    expect(commitLearningEngineAnswer).toHaveBeenCalledTimes(1);
    expect(claimNextLearningEngineCard).toHaveBeenCalledTimes(1);
    expect(claimNextLearningEngineCard).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    expect(result.answerResult.ok).toBe(true);
    expect(result.nextCardFailed).toBe(false);
    expect(result.nextCard).toEqual({
      status: "ok",
      sessionId: SESSION_ID,
      sessionMode: "learning",
      cardId: "card-2",
      front: "sedulous",
      back: "勤勉な",
      enemyType: "enemy_a",
      enemyHp: 50,
      enemyMaxHp: 90,
      combo: 2,
      claimId: "claim-2",
    });
  });

  it("commit fails -> next-card claim/fetch is never attempted", async () => {
    getSessionEngineVersion.mockResolvedValue("v1");
    commitLearningEngineAnswer.mockRejectedValue(new Error("claim is not OPEN"));

    const result = await submitAnswerAndAdvance(BASE_INPUT, USER_ID);

    expect(result.answerResult).toEqual({
      ok: false,
      code: "COMMIT_FAILED",
      message: "Something went wrong submitting your answer. Please try again.",
    });
    expect(result.nextCard).toBeNull();
    expect(result.nextCardFailed).toBe(false);
    expect(getActiveSessionById).not.toHaveBeenCalled();
    expect(claimNextLearningEngineCard).not.toHaveBeenCalled();
  });

  it("commit succeeds but next-card fetch throws -> the committed answer is preserved, nextCardFailed is true, nextCard is null", async () => {
    getSessionEngineVersion.mockResolvedValue("v1");
    commitLearningEngineAnswer.mockResolvedValue(FRESH_SUCCESS_DATA);
    getActiveSessionById.mockRejectedValue(new Error("connection reset"));

    const result = await submitAnswerAndAdvance(BASE_INPUT, USER_ID);

    expect(result.answerResult.ok).toBe(true);
    if (result.answerResult.ok) {
      expect(result.answerResult.data.damage).toBe(10);
    }
    expect(result.nextCard).toBeNull();
    expect(result.nextCardFailed).toBe(true);
  });

  it("an idempotent replay commit still only fetches next-card once, never resubmits/re-commits", async () => {
    getSessionEngineVersion.mockResolvedValue("v1");
    commitLearningEngineAnswer.mockResolvedValue({
      ...FRESH_SUCCESS_DATA,
      isReplay: true,
      session: null,
      profile: null,
    });
    getActiveSessionById.mockResolvedValue(V1_SESSION);
    claimNextLearningEngineCard.mockResolvedValue({ reused: true, cardId: "card-2", claimId: "claim-2" });
    mockCardContentRead({ front: "sedulous", back: "勤勉な" });

    const result = await submitAnswerAndAdvance(BASE_INPUT, USER_ID);

    expect(commitLearningEngineAnswer).toHaveBeenCalledTimes(1);
    expect(result.answerResult.ok).toBe(true);
    if (result.answerResult.ok) {
      expect(result.answerResult.data.isReplay).toBe(true);
    }
    expect(result.nextCard?.status).toBe("ok");
    expect(result.nextCardFailed).toBe(false);
  });
});
