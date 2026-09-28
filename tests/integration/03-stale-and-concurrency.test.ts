import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, pickCards, type ProvisionedTester } from "./fixtures/provision";
import { STALE_TESTER } from "./fixtures/identities";
import { setRlsClient, clearRlsClient } from "./rls-client-context";
import { countAnswerEventsByClientEventId, getUserCardProgressAdmin } from "./db-assertions";

const { runSubmitAnswer, defaultSubmitAnswerDeps } = await import("@/lib/learning/submit-answer");
const {
  commitAnswerTransaction,
  CommitAnswerTransactionError,
  COMMIT_ANSWER_ERROR_CODES,
} = await import("@/lib/learning/commit-answer");
const { getActiveSessionById } = await import("@/lib/sessions/dal");
const { getCardProgress, getRecentAnswerHistory } = await import("@/lib/learning/progress-dal");
const { estimateRating } = await import("@/lib/learning/rating");
const { progressToFsrsCard, advanceFsrs } = await import("@/lib/learning/fsrs");
const { calculateBattleResult } = await import("@/lib/learning/battle");

/**
 * Manually replicates runSubmitAnswer's read+compute steps using the same
 * real production functions, so the *resulting* CommitAnswerInput can be
 * captured and deliberately resubmitted after the state it was computed
 * from has changed -- reproducing the "read once, then commit against a
 * changed state" stale-snapshot condition on demand, without modifying
 * runSubmitAnswer itself just to expose its intermediate value.
 */
async function buildCommitInputFromCurrentState(
  tester: ProvisionedTester,
  sessionId: string,
  cardId: string,
  clientEventId: string,
  correct: boolean,
) {
  const session = await getActiveSessionById(sessionId);
  const progress = await getCardProgress(cardId);
  const recentAnswerHistory = await getRecentAnswerHistory(cardId);
  if (!session || !progress) throw new Error("fixture state missing");

  const now = new Date();
  const grade = estimateRating({
    correct,
    responseTimeMs: 1200,
    seenCount: progress.seen_count + 1,
    recentAnswerHistory,
  });
  const card = progressToFsrsCard(progress, now);
  const fsrsUpdate = advanceFsrs(card, now, grade);
  const battleResult = calculateBattleResult({
    correct,
    responseTimeMs: 1200,
    comboBefore: session.current_combo,
    enemyHpBefore: session.current_enemy_hp as number,
    random: Math.random,
  });

  return {
    clientEventId,
    userId: tester.userId,
    sessionId,
    cardId,
    expectedCardStatusBefore: progress.card_status,
    expectedSeenCountBefore: progress.seen_count,
    expectedCorrectStreakBefore: progress.correct_streak,
    expectedWrongStreakBefore: progress.wrong_streak,
    expectedFsrsDueBefore: progress.fsrs_due_at,
    expectedSessionEnemyHpBefore: session.current_enemy_hp as number,
    expectedSessionComboBefore: session.current_combo,
    expectedSessionLearningDrawIndex: session.learning_draw_index,
    correct,
    responseTimeMs: 1200,
    sessionMode: session.current_mode,
    fsrsRating: grade,
    fsrsDueAt: fsrsUpdate.fsrs_due_at,
    fsrsStability: fsrsUpdate.fsrs_stability,
    fsrsDifficulty: fsrsUpdate.fsrs_difficulty,
    fsrsElapsedDays: fsrsUpdate.fsrs_elapsed_days,
    fsrsScheduledDays: fsrsUpdate.fsrs_scheduled_days,
    fsrsReps: fsrsUpdate.fsrs_reps,
    fsrsLapses: fsrsUpdate.fsrs_lapses,
    fsrsLearningSteps: fsrsUpdate.fsrs_learning_steps,
    fsrsState: fsrsUpdate.fsrs_state,
    fsrsLastReviewAt: fsrsUpdate.fsrs_last_review_at,
    baseDamage: battleResult.baseDamage,
    speedBonus: battleResult.speedBonus,
    critical: battleResult.critical,
    comboAfter: battleResult.comboAfter,
    damage: battleResult.damage,
    enemyHpAfter: battleResult.enemyHpAfter,
    enemyDefeated: battleResult.enemyDefeated,
    newEnemyType: battleResult.newEnemyType,
    newEnemyMaxHp: battleResult.newEnemyMaxHp,
    newEnemyHp: battleResult.newEnemyHp,
  };
}

describe("stale snapshot and concurrency (real commit_answer_transaction)", () => {
  let tester: ProvisionedTester;
  let sessionId: string;
  let cardX: string;
  let cardY1: string;
  let cardY2: string;
  let cardZ: string;

  beforeAll(async () => {
    await resetTesterLearnerData(STALE_TESTER);
    tester = await provisionTesterWithDeck(STALE_TESTER);
    // Pre-selected once, up front -- pickCards always returns the same
    // sort_order-ascending cards, so calling it again from a later test
    // would silently re-select cards an earlier test already mutated.
    [cardX, cardY1, cardY2, cardZ] = await pickCards(tester, 4);
    const session = await startOrResumeSessionFor(tester);
    sessionId = session.id;
    setRlsClient(tester.client);
  });

  afterAll(() => {
    clearRlsClient();
  });

  it("deterministic case: committing with a manually-staled snapshot surfaces real SQLSTATE 40001", async () => {
    // Two DIFFERENT cards, not one resubmitted twice: as of the Learning
    // Wrong reappearance floor (20260927000000_learning_wrong_reappearance_
    // floor.sql), BOTH Correct and Wrong now set next_eligible_draw_index
    // on the answered card, so resubmitting the SAME card a second time
    // would fail on that unrelated Learning-cooldown ground (22023) before
    // ever reaching the stale-snapshot comparison this test is about.
    //
    // Instead: build a commit input for cardZ from CURRENT (soon-to-be-
    // stale) state first, then commit a real, unrelated Wrong answer for a
    // different card (cardX) -- which advances session-level state
    // (learning_draw_index, the field this comparison is keyed on for
    // Learning mode) without touching cardZ's own cooldown/progress at
    // all. Submitting the cardZ input afterward is a genuinely new
    // logical answer (cardZ was never touched, so it passes the
    // eligibility check) whose captured expectedSessionLearningDrawIndex
    // no longer matches reality -- reaching the stale-snapshot comparison
    // cleanly, with no cooldown interference on either card.
    const staleInput = await buildCommitInputFromCurrentState(tester, sessionId, cardZ, crypto.randomUUID(), false);

    const firstInput = await buildCommitInputFromCurrentState(tester, sessionId, cardX, crypto.randomUUID(), false);
    const firstResult = await commitAnswerTransaction(firstInput);
    expect(firstResult.is_replay).toBe(false);

    await expect(commitAnswerTransaction(staleInput)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CommitAnswerTransactionError);
      expect((error as InstanceType<typeof CommitAnswerTransactionError>).code).toBe(
        COMMIT_ANSWER_ERROR_CODES.STALE_SNAPSHOT,
      );
      return true;
    });

    // The rejected attempt performed no writes at all.
    expect(await countAnswerEventsByClientEventId(staleInput.clientEventId)).toBe(0);
    const progressZAfter = await getUserCardProgressAdmin(tester.userId, cardZ);
    expect(progressZAfter.seen_count).toBe(0); // cardZ itself was never actually answered
    const progressXAfter = await getUserCardProgressAdmin(tester.userId, cardX);
    expect(progressXAfter.seen_count).toBe(1); // only the real cardX commit took effect
  });

  // Best-effort real-concurrency proof, per the task's "prefer an actual
  // concurrent call if practical" guidance. This genuinely races two
  // Promise.all-dispatched runSubmitAnswer() calls against real Postgres
  // row locks -- true concurrency, not a simulation -- and has been
  // observed to pass consistently across many repeated runs. Because it
  // depends on real scheduling/timing (both reads must complete before
  // either write locks the row), it is not mathematically guaranteed
  // deterministic the way the case above is; the deterministic case is
  // the authoritative proof of the SQLSTATE 40001 -> STALE_STATE mapping,
  // and this test is a corroborating one, not a replacement for it.
  it("concurrency case: two real concurrent submissions in the same session -- one commits, the other maps to STALE_STATE", async () => {
    // Deliberately two DIFFERENT (fresh) cards, not the same one: both
    // submissions still race on the same *session*-level snapshot fields
    // (current_combo, learning_draw_index), which is what this test is
    // actually about, without also racing on either card's own
    // Learning-cooldown eligibility (which would reject the second
    // submission for an unrelated reason and mask the intended proof --
    // see the deterministic case above for why that matters).
    const inputA = { clientEventId: crypto.randomUUID(), sessionId, cardId: cardY1, correct: true, responseTimeMs: 1200 };
    const inputB = { clientEventId: crypto.randomUUID(), sessionId, cardId: cardY2, correct: true, responseTimeMs: 1400 };

    const [resultA, resultB] = await Promise.all([
      runSubmitAnswer(inputA, tester.userId, defaultSubmitAnswerDeps),
      runSubmitAnswer(inputB, tester.userId, defaultSubmitAnswerDeps),
    ]);

    const results = [resultA, resultB];
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);

    // Exactly one of the two logical submissions committed...
    expect(successes).toHaveLength(1);
    // ...and the other was rejected specifically as a stale snapshot, not
    // some other failure -- proving the real race was actually exercised
    // (not, say, both failing for an unrelated reason).
    expect(failures).toHaveLength(1);
    expect(failures[0].ok).toBe(false);
    if (failures[0].ok) return;
    expect(failures[0].code).toBe("STALE_STATE");

    // No duplicate/partial mutation: only the winning card's progress
    // advanced; the loser's card was never touched (its whole transaction
    // rolled back).
    const progressY1 = await getUserCardProgressAdmin(tester.userId, cardY1);
    const progressY2 = await getUserCardProgressAdmin(tester.userId, cardY2);
    expect(progressY1.seen_count + progressY2.seen_count).toBe(1);
    expect(await countAnswerEventsByClientEventId(inputA.clientEventId)).toBe(resultA.ok ? 1 : 0);
    expect(await countAnswerEventsByClientEventId(inputB.clientEventId)).toBe(resultB.ok ? 1 : 0);
  });
});
