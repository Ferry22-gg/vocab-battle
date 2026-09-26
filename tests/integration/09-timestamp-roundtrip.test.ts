import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, startOrResumeSessionFor, pickCards, type ProvisionedTester } from "./fixtures/provision";
import { TIMESTAMP_TESTER } from "./fixtures/identities";
import { setRlsClient, clearRlsClient } from "./rls-client-context";
import { getUserCardProgressAdmin } from "./db-assertions";

const { runSubmitAnswer, defaultSubmitAnswerDeps } = await import("@/lib/learning/submit-answer");
const { getCardProgress } = await import("@/lib/learning/progress-dal");
const { progressToFsrsCard } = await import("@/lib/learning/fsrs");

/**
 * Phase E scenario 15: proves the full D3b timestamp chain against real
 * Postgres data -- PostgREST timestamptz string -> progress-dal.ts's Date
 * normalization -> the FSRS adapter -> commit_answer_transaction() ->
 * back into Postgres as a real timestamptz -- with no Invalid Date and no
 * string-vs-Date mismatch anywhere in the chain.
 */
describe("timestamp round-trip (real Postgres timestamptz <-> Date)", () => {
  let tester: ProvisionedTester;
  let sessionId: string;
  let cardId: string;
  let secondCardId: string;

  beforeAll(async () => {
    await resetTesterLearnerData(TIMESTAMP_TESTER);
    tester = await provisionTesterWithDeck(TIMESTAMP_TESTER);
    // Two distinct cards: the first test answers cardId Correct, which
    // sets a real 10-draw Learning cooldown on it (DATABASE_SCHEMA.md
    // 11.3) -- the second test needs its own fresh card, not a second
    // real submission to the same one.
    [cardId, secondCardId] = await pickCards(tester, 2);
    const session = await startOrResumeSessionFor(tester);
    sessionId = session.id;
    setRlsClient(tester.client);
  });

  afterAll(() => {
    clearRlsClient();
  });

  it("a committed fsrs_due_at/fsrs_last_review_at round-trips through the real DAL as genuine Dates", async () => {
    const beforeSubmit = Date.now();

    const result = await runSubmitAnswer(
      { clientEventId: crypto.randomUUID(), sessionId, cardId, correct: true, responseTimeMs: 1500 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );
    expect(result.ok).toBe(true);

    // 1. Raw admin read: confirms Postgres actually persisted real
    // timestamptz values (PostgREST serializes these as ISO strings).
    const rawProgress = await getUserCardProgressAdmin(tester.userId, cardId);
    expect(typeof rawProgress.fsrs_due_at).toBe("string");
    expect(typeof rawProgress.fsrs_last_review_at).toBe("string");
    expect(Number.isNaN(new Date(rawProgress.fsrs_due_at).getTime())).toBe(false);
    expect(Number.isNaN(new Date(rawProgress.fsrs_last_review_at).getTime())).toBe(false);

    // 2. Real production DAL read (RLS-scoped, as the tester): D3b's fix
    // must have normalized the same two fields into genuine Date objects.
    const progress = await getCardProgress(cardId);
    expect(progress).not.toBeNull();
    expect(progress!.fsrs_due_at).toBeInstanceOf(Date);
    expect(progress!.fsrs_last_review_at).toBeInstanceOf(Date);
    // Same absolute instant as the raw Postgres value -- not merely "a Date".
    expect(progress!.fsrs_due_at!.getTime()).toBe(new Date(rawProgress.fsrs_due_at).getTime());
    expect(progress!.fsrs_last_review_at!.getTime()).toBe(new Date(rawProgress.fsrs_last_review_at).getTime());
    // fsrs_last_review_at is set to the answer's own timestamp, so it must
    // fall within this test's own execution window -- not fabricated, not
    // an unrelated stored value.
    expect(progress!.fsrs_last_review_at!.getTime()).toBeGreaterThanOrEqual(beforeSubmit - 1000);
    expect(progress!.fsrs_last_review_at!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // 3. The real FSRS adapter, fed the real DAL's output, produces a
    // valid Card with genuine Date fields -- the exact link the D3b fix
    // was about (a string here would previously have silently propagated).
    const card = progressToFsrsCard(progress!, new Date());
    expect(card.due).toBeInstanceOf(Date);
    expect(card.last_review).toBeInstanceOf(Date);
    expect(Number.isNaN(card.due.getTime())).toBe(false);
    expect(Number.isNaN(card.last_review!.getTime())).toBe(false);
  });

  it("a second real answer advances FSRS again and the newly committed timestamps still round-trip cleanly", async () => {
    const beforeSecond = Date.now();

    const result = await runSubmitAnswer(
      { clientEventId: crypto.randomUUID(), sessionId, cardId: secondCardId, correct: false, responseTimeMs: 900 },
      tester.userId,
      defaultSubmitAnswerDeps,
    );
    expect(result.ok).toBe(true);

    const progress = await getCardProgress(secondCardId);
    expect(progress).not.toBeNull();
    expect(progress!.fsrs_last_review_at).toBeInstanceOf(Date);
    expect(progress!.fsrs_last_review_at!.getTime()).toBeGreaterThanOrEqual(beforeSecond - 1000);
    expect(progress!.fsrs_last_review_at!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(progress!.fsrs_due_at).toBeInstanceOf(Date);
    expect(Number.isNaN(progress!.fsrs_due_at!.getTime())).toBe(false);
  });
});
