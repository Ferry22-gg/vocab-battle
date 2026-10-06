import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, type ProvisionedTester } from "./fixtures/provision";
import { RC_F_CROSS_SESSION_POSITION_TESTER } from "./fixtures/identities";
import { setRlsClient, clearRlsClient } from "./rls-client-context";
import { createAdminClient } from "./admin-client";
import { getSessionByIdAdmin, getAnswerEventByClientEventIdAdmin } from "./db-assertions";

const { getNextSessionCardForEngine, submitAnswerForEngine } = await import("@/lib/learning/engine-router");
const { finishSession } = await import("@/lib/sessions/dal");
const { enrollUserInLearningEngineV1 } = await import("@/lib/learning-engine/cutover/enroll");

/**
 * Runtime Cutover RC-F acceptance test (final-report item: "literal
 * cross-session scheduler_position acceptance test").
 *
 * Spec section 2.1 / Approved Clarification 10 requires `scheduler_position`
 * (deck-global, per user+deck, monotonic, never reset between Sessions) and
 * `session_position` (Session-local, restarts in a later Session) to be
 * kept genuinely distinct. RC-D's existing scenario 6
 * (17-learning-engine-v1-rc-d-routing.test.ts) already proves a
 * finish-then-resume Session stays pinned to `v1` (one-way); this file adds
 * the one check that scenario does not: that the deck-global counter
 * actually CONTINUES across that same boundary rather than resetting, while
 * the Session-local counter genuinely DOES restart -- both observed on the
 * same `answer_events` row shape, which is what a future telemetry
 * consumer actually reads.
 *
 * Uses its own dedicated, test-owned identity (never a real tester) so
 * this scenario's Session lifecycle can never interleave with
 * 17-learning-engine-v1-rc-d-routing.test.ts's own shared v1Tester.
 */
describe("Runtime Cutover RC-F acceptance: scheduler_position (deck-global) vs session_position (Session-local) across a real Session boundary", () => {
  let tester: ProvisionedTester;

  beforeAll(async () => {
    await resetTesterLearnerData(RC_F_CROSS_SESSION_POSITION_TESTER);
    tester = await provisionTesterWithDeck(RC_F_CROSS_SESSION_POSITION_TESTER);
    const result = await enrollUserInLearningEngineV1(tester.userId);
    expect(result.rollout.user_id).toBe(tester.userId);
  });

  afterAll(async () => {
    clearRlsClient();
    await resetTesterLearnerData(RC_F_CROSS_SESSION_POSITION_TESTER);
  });

  it("scheduler_position continues from Session A into Session B; session_position restarts; telemetry preserves the distinction", async () => {
    setRlsClient(tester.client);
    const admin = createAdminClient();

    // -- Session A: claim + commit one answer --
    const sessionA = await startOrResumeSessionFor(tester);
    const sessionARow = await getSessionByIdAdmin(sessionA.id);
    expect(sessionARow?.engine_version).toBe("v1");

    const cardA = await getNextSessionCardForEngine(tester.userId, sessionA.id);
    expect(cardA.status).toBe("ok");
    if (cardA.status !== "ok") return;

    const clientEventIdA = crypto.randomUUID();
    const resultA = await submitAnswerForEngine(
      { clientEventId: clientEventIdA, sessionId: sessionA.id, cardId: cardA.cardId, correct: true, responseTimeMs: 900, claimId: cardA.claimId },
      tester.userId,
    );
    expect(resultA.ok).toBe(true);
    if (!resultA.ok) return;
    expect(resultA.data.isReplay).toBe(false);

    const deckStateAfterA = (
      await admin.from("user_deck_learning_state").select("scheduler_position, scheduler_revision").eq("user_id", tester.userId).eq("deck_id", tester.deckId).maybeSingle()
    ).data as { scheduler_position: number; scheduler_revision: number } | null;
    // First-ever answer for this (user, deck) -- the deck-global counter
    // advances from its 0 default to exactly 1.
    expect(deckStateAfterA?.scheduler_position).toBe(1);

    const eventA = await getAnswerEventByClientEventIdAdmin(clientEventIdA);
    expect(eventA).not.toBeNull();
    // Session-local position: first answer in Session A.
    expect(eventA?.session_position).toBe(1);

    // -- Authoritatively finish Session A --
    await finishSession(sessionA.id);
    const sessionARowAfterFinish = await getSessionByIdAdmin(sessionA.id);
    expect(sessionARowAfterFinish?.status).toBe("completed");

    // -- Session B: a genuinely NEW session on the SAME deck --
    const sessionB = await startOrResumeSessionFor(tester);
    expect(sessionB.id).not.toBe(sessionA.id);
    const sessionBRow = await getSessionByIdAdmin(sessionB.id);
    // One-way: still v1, never silently falls back to legacy.
    expect(sessionBRow?.engine_version).toBe("v1");

    const cardB = await getNextSessionCardForEngine(tester.userId, sessionB.id);
    expect(cardB.status).toBe("ok");
    if (cardB.status !== "ok") return;

    const clientEventIdB = crypto.randomUUID();
    const resultB = await submitAnswerForEngine(
      { clientEventId: clientEventIdB, sessionId: sessionB.id, cardId: cardB.cardId, correct: true, responseTimeMs: 900, claimId: cardB.claimId },
      tester.userId,
    );
    expect(resultB.ok).toBe(true);
    if (!resultB.ok) return;
    expect(resultB.data.isReplay).toBe(false);

    const deckStateAfterB = (
      await admin.from("user_deck_learning_state").select("scheduler_position, scheduler_revision").eq("user_id", tester.userId).eq("deck_id", tester.deckId).maybeSingle()
    ).data as { scheduler_position: number; scheduler_revision: number } | null;
    const eventB = await getAnswerEventByClientEventIdAdmin(clientEventIdB);
    expect(eventB).not.toBeNull();

    // -- The deck-global counter CONTINUED from Session A -- it did NOT
    // reset to 1 for the new Session. --
    expect(deckStateAfterB?.scheduler_position).toBe((deckStateAfterA?.scheduler_position ?? 0) + 1);
    expect(deckStateAfterB?.scheduler_position).toBe(2);

    // -- The Session-local counter DID restart: Session B's first answer
    // is session_position 1 again, identical to Session A's first answer,
    // even though the deck-global counter has already moved on. --
    expect(eventB?.session_position).toBe(1);
    expect(eventB?.session_position).toBe(eventA?.session_position);

    // -- Telemetry preserves the distinction on the SAME row shape: the
    // deck-global scheduler_position trace echo is strictly monotonic
    // across the Session boundary, while session_position is not. --
    expect((eventB?.scheduler_position ?? -1)).toBeGreaterThan(eventA?.scheduler_position ?? -1);
    expect(eventB?.session_id).not.toBe(eventA?.session_id);
  });
});
