import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, pickCards, type ProvisionedTester } from "./fixtures/provision";
import { ENEMY_DEFEAT_TESTER } from "./fixtures/identities";
import { setRlsClient, clearRlsClient } from "./rls-client-context";
import { updateSessionAdmin, getSessionByIdAdmin, getAnswerEventByClientEventIdAdmin, getXpEventsForAnswerEventAdmin } from "./db-assertions";

const { runSubmitAnswer, defaultSubmitAnswerDeps } = await import("@/lib/learning/submit-answer");
const { ENEMY_CONFIG } = await import("@/lib/learning/config");

/** Pops values off a fixed queue, one per random() call -- same pattern as tests/unit/battle.test.ts. */
function sequenceRandom(values: readonly number[]): () => number {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error(`sequenceRandom exhausted after ${values.length} call(s)`);
    return values[i++];
  };
}

/**
 * Phase E scenario 10: a real enemy-defeat/respawn cycle. Enemy HP is
 * driven to 1 via admin access (a legitimate fixture-setup use of
 * service-role, not a substitute for the real RPC), and the battle RNG is
 * deterministically injected through runSubmitAnswer's own dependency
 * injection (not a mock of Postgres or the RPC) so the exact new enemy is
 * known ahead of time.
 */
describe("enemy defeat and respawn (real commit_answer_transaction)", () => {
  let tester: ProvisionedTester;
  let sessionId: string;
  let cardId: string;

  beforeAll(async () => {
    await resetTesterLearnerData(ENEMY_DEFEAT_TESTER);
    tester = await provisionTesterWithDeck(ENEMY_DEFEAT_TESTER);
    [cardId] = await pickCards(tester, 1);
    const session = await startOrResumeSessionFor(tester);
    sessionId = session.id;
    // Legitimate fixture-setup use of admin access: drive enemy HP down to
    // 1 so any correct answer (min base damage 24) is guaranteed lethal.
    // The defeat/respawn transition itself still goes through the real RPC.
    await updateSessionAdmin(sessionId, { current_enemy_hp: 1 });
    setRlsClient(tester.client);
  });

  afterAll(() => {
    clearRlsClient();
  });

  it("a lethal correct answer defeats the enemy and spawns exactly the deterministically-selected replacement", async () => {
    const clientEventId = crypto.randomUUID();
    // baseDamage roll -> 24 (min), critical roll -> non-critical, enemy
    // selection roll -> index 1 of ENEMY_IDS (enemy_b), matching
    // battle.ts's exact RNG call order (base damage, critical, then enemy
    // selection only when defeated).
    const deps = { ...defaultSubmitAnswerDeps, random: sequenceRandom([0, 0.9, 0.5]) };

    const result = await runSubmitAnswer(
      { clientEventId, sessionId, cardId, correct: true, responseTimeMs: 5000 },
      tester.userId,
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.data.isReplay) return;
    expect(result.data.enemyDefeated).toBe(true);
    expect(result.data.newEnemyType).toBe("enemy_b");
    expect(result.data.newEnemyMaxHp).toBe(ENEMY_CONFIG.enemy_b.initialHp);
    expect(result.data.newEnemyHp).toBe(ENEMY_CONFIG.enemy_b.initialHp);

    const answerEvent = await getAnswerEventByClientEventIdAdmin(clientEventId);
    expect(answerEvent.enemy_hp_before).toBe(1);
    expect(answerEvent.enemy_hp_after).toBe(0);

    const sessionAfter = await getSessionByIdAdmin(sessionId);
    expect(sessionAfter.current_enemy_type).toBe("enemy_b");
    expect(sessionAfter.current_enemy_max_hp).toBe(ENEMY_CONFIG.enemy_b.initialHp);
    expect(sessionAfter.current_enemy_hp).toBe(ENEMY_CONFIG.enemy_b.initialHp);
    expect(sessionAfter.enemies_defeated).toBe(1);

    const xpEvents = await getXpEventsForAnswerEventAdmin(answerEvent.id);
    const enemyDefeatedXp = xpEvents.filter((e: { reason: string }) => e.reason === "enemy_defeated");
    expect(enemyDefeatedXp).toHaveLength(1);
    expect(enemyDefeatedXp[0].amount).toBe(20);
  });
});
