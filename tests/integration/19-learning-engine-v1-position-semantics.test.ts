import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, type ProvisionedTester } from "./fixtures/provision";
import { POSITION_SEMANTICS_TESTER } from "./fixtures/identities";
import { createAdminClient } from "./admin-client";

const { claimNextLearningEngineCard } = await import("@/lib/learning-engine/runtime/claim-next-card");
const { commitLearningEngineAnswer } = await import("@/lib/learning-engine/runtime/commit-answer");

/**
 * Real-pipeline / database proof of the Stage 0 audit's position-semantics
 * fix, against the REAL local Supabase stack -- never only the pure
 * scheduler helpers (those are covered by tests/unit/
 * learning-engine-scheduler-simulation.test.ts and the new
 * tests/unit/learning-engine-position-semantics-e2e.test.ts). This file
 * proves the ACTUAL claim -> commit -> claim loop, through the real
 * trusted RPCs, produces the intended 3/6/5-intervening-card boundaries
 * -- not merely that the pure functions agree with each other in
 * isolation (which is exactly what the pre-existing unit tests already
 * did, and exactly what let the original off-by-one through).
 *
 * Uses a disposable-in-spirit but persistent-by-convention fixture
 * identity (POSITION_SEMANTICS_TESTER, public_user_id 927) -- never
 * tester 951 ("Dev Tester (Local)", the real Stage 0 manual-play evidence
 * this whole audit is about preserving untouched). Reset before and after
 * via the same resetTesterLearnerData() every other Learning Engine v1
 * integration test in this directory already uses.
 */
describe("Learning Engine v1 position-semantics fix (real local Supabase)", () => {
  let tester: ProvisionedTester;
  let sessionId: string;

  const random = () => 0; // deterministic: sampleRepairGap's index 0 -> gap 3 whenever a repair is freshly created. Irrelevant to the hard-cap/cooldown boundaries below (both fixed constants, independent of the sampled gap).

  beforeAll(async () => {
    await resetTesterLearnerData(POSITION_SEMANTICS_TESTER);
    tester = await provisionTesterWithDeck(POSITION_SEMANTICS_TESTER);
    sessionId = (await startOrResumeSessionFor(tester)).id;

    const admin = createAdminClient();
    const { error: sessionError } = await admin.from("sessions").update({ engine_version: "v1" }).eq("id", sessionId);
    if (sessionError) throw sessionError;
    const { error: rolloutError } = await admin
      .from("learning_engine_v1_rollout")
      .upsert([{ user_id: tester.userId }], { onConflict: "user_id", ignoreDuplicates: true });
    if (rolloutError) throw rolloutError;
  });

  afterAll(async () => {
    await resetTesterLearnerData(POSITION_SEMANTICS_TESTER);
  });

  async function claim() {
    return claimNextLearningEngineCard(tester.userId, sessionId, random);
  }

  async function commit(claimId: string, correct: boolean) {
    return commitLearningEngineAnswer(
      tester.userId,
      sessionId,
      claimId,
      { clientEventId: crypto.randomUUID(), correct, responseTimeMs: 1000, timeToFirstActionMs: null },
      random,
    );
  }

  async function userCardProgressRow(cardId: string) {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("user_card_progress")
      .select("repair_target_position, repair_hard_cap_position, correct_cooldown_until_position, repair_pending")
      .eq("user_id", tester.userId)
      .eq("card_id", cardId)
      .maybeSingle();
    if (error) throw error;
    return data as {
      repair_target_position: number | null;
      repair_hard_cap_position: number | null;
      correct_cooldown_until_position: number | null;
      repair_pending: boolean;
    };
  }

  async function schedulerPosition() {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("user_deck_learning_state")
      .select("scheduler_position")
      .eq("user_id", tester.userId)
      .eq("deck_id", tester.deckId)
      .maybeSingle();
    if (error) throw error;
    return (data as { scheduler_position: number }).scheduler_position;
  }

  /** Answers `count` real claims Correct, asserting none of them is `excludedCardId` (the card under repair/cooldown observation, which must stay excluded from ordinary selection the entire time). */
  async function answerIntervening(count: number, excludedCardId: string): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const c = await claim();
      expect(c.cardId).not.toBeNull();
      expect(c.cardId).not.toBe(excludedCardId);
      await commit(c.claimId!, true);
    }
  }

  it("Wrong at claim position N: Repair is NOT eligible after 2 intervening answers, but IS after exactly 3", async () => {
    const wrongClaim = await claim();
    expect(wrongClaim.cardId).not.toBeNull();
    const cardId = wrongClaim.cardId!;
    const N = wrongClaim.schedulerPosition; // the claim's own PRE-answer position -- canonical presentation position

    await commit(wrongClaim.claimId!, false);

    await answerIntervening(2, cardId);
    const afterTwo = await userCardProgressRow(cardId);
    expect(afterTwo.repair_pending).toBe(true);
    // Sampled gap 3 (forced via random=0) -> targetPosition = N + 3 + 1 = N + 4.
    expect(afterTwo.repair_target_position).toBe(N + 4);
    const positionAfterTwo = await schedulerPosition();
    expect(positionAfterTwo).toBeLessThan(afterTwo.repair_target_position!); // NOT yet eligible

    await answerIntervening(1, cardId); // the 3rd intervening answer
    const positionAfterThree = await schedulerPosition();
    expect(positionAfterThree).toBe(N + 4);
    expect(positionAfterThree).toBeGreaterThanOrEqual(afterTwo.repair_target_position!); // eligible now, exactly at the 3rd intervening answer
  });

  it("Wrong at claim position N: Repair is NOT mandatory after 5 intervening answers, but IS -- and is actually selected -- after exactly 6", async () => {
    const wrongClaim = await claim();
    expect(wrongClaim.cardId).not.toBeNull();
    const cardId = wrongClaim.cardId!;
    const N = wrongClaim.schedulerPosition;

    await commit(wrongClaim.claimId!, false);

    await answerIntervening(5, cardId);
    const afterFive = await userCardProgressRow(cardId);
    expect(afterFive.repair_hard_cap_position).toBe(N + 7); // fixed +7, independent of the sampled gap
    const positionAfterFive = await schedulerPosition();
    expect(positionAfterFive).toBeLessThan(afterFive.repair_hard_cap_position!); // NOT yet mandatory

    await answerIntervening(1, cardId); // the 6th intervening answer
    const positionAfterSix = await schedulerPosition();
    expect(positionAfterSix).toBe(N + 7);
    expect(positionAfterSix).toBeGreaterThanOrEqual(afterFive.repair_hard_cap_position!);

    // Mandatory means GUARANTEED selection on the very next claim -- Gate 1
    // global interrupt, unlike mere target-eligibility above (section 4 of
    // the Phase 4 brief: "Repair hard cap... Phase 6 is expected to call
    // this before evaluating Critical Due or anything else").
    const nextClaim = await claim();
    expect(nextClaim.cardId).toBe(cardId);
    const admin = createAdminClient();
    const { data: trace } = await admin
      .from("learning_engine_selection_traces")
      .select("selection_reason")
      .eq("id", nextClaim.selectionTraceId!)
      .maybeSingle();
    expect(trace?.selection_reason).toBe("repair_hard_cap");

    // Clean up: resolve the mandatory repair (Correct) so it doesn't leak
    // into any other test in this file.
    await commit(nextClaim.claimId!, true);
  });

  it("Correct at claim position N: normal reselection is blocked for 4 intervening answers, eligible again after exactly 5", async () => {
    const correctClaim = await claim();
    expect(correctClaim.cardId).not.toBeNull();
    const cardId = correctClaim.cardId!;
    const N = correctClaim.schedulerPosition;

    await commit(correctClaim.claimId!, true);

    const afterCommit = await userCardProgressRow(cardId);
    // CORRECT_MIN_GAP (5) + 1, per applyCorrectCooldown's own formula --
    // unchanged by this fix; only the INPUT position (N, not N+1) changed.
    expect(afterCommit.correct_cooldown_until_position).toBe(N + 6);

    await answerIntervening(4, cardId);
    const positionAfterFour = await schedulerPosition();
    expect(positionAfterFour).toBeLessThan(afterCommit.correct_cooldown_until_position!); // still blocked

    await answerIntervening(1, cardId); // the 5th intervening answer
    const positionAfterFive = await schedulerPosition();
    expect(positionAfterFive).toBe(N + 6);
    expect(positionAfterFive).toBeGreaterThanOrEqual(afterCommit.correct_cooldown_until_position!); // eligible now, exactly at the 5th intervening answer
  });
});
