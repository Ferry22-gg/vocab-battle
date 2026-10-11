import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { startOrResumeSessionFor } from "./fixtures/provision";
import { createTesterClient } from "./tester-client";
import { STARTUP_STARVATION_TESTER } from "./fixtures/identities";
import { createAdminClient } from "./admin-client";

const { claimNextLearningEngineCard } = await import("@/lib/learning-engine/runtime/claim-next-card");
const { commitLearningEngineAnswer } = await import("@/lib/learning-engine/runtime/commit-answer");

/**
 * Real-pipeline integration proof for the Alpha startup-sensitive Active
 * starvation correction (lib/learning-engine/scheduler/active-selection.ts's
 * computeActiveStarvationThreshold = min(ACTIVE_STARVATION_MAX_DRAWS,
 * ACTIVE_STARVATION_POOL_ROTATIONS * activePoolSize)).
 *
 * Exercises the REAL local claim/commit pipeline end-to-end
 * (claimNextLearningEngineCard -> chooseNextCard -> the trusted claim
 * RPC; commitLearningEngineAnswer -> the trusted answer commit RPC),
 * against the real local Supabase stack, same pattern as
 * 19-learning-engine-v1-position-semantics.test.ts and
 * 20-learning-engine-v1-new-admission.test.ts. Uses a disposable 9xx
 * tester only (STARTUP_STARVATION_TESTER, public_user_id 931) -- never
 * tester 951, which is never queried or mutated by this file.
 *
 * ---------------------------------------------------------------------
 * Why direct pre-state construction, not dozens of scripted answers
 * ---------------------------------------------------------------------
 * Rather than rediscovering the real tester 951 shape probabilistically
 * (which earlier attempts showed is seed-sensitive and can spend its
 * whole bounded loop on unrelated admission/first-pass churn), this file
 * constructs the CAPTURED real shape directly via the admin client --
 * the same sanctioned "direct pre-state preparation where the scenario
 * needs it" pattern tests/integration/fixtures/provision.ts's own header
 * documents. The dedicated 8-card custom deck means the Active Pool size
 * is pinned at exactly 8 for the lifetime of the test (the entire deck is
 * already admitted; there is no reservoir left to admit further from),
 * which is what makes every case below deterministic rather than
 * seed-dependent.
 *
 * Reference values (the real captured tester 951 scheduler_position = 43
 * snapshot, from the earlier read-only audit -- used here only as the
 * semantic shape to replicate, never read from or written to the real
 * account):
 *   kupika: LEARNING_1, correct_cooldown_until_position = 14, active_draws_since_eligible = 30
 *   kiatu:  LEARNING_1, correct_cooldown_until_position = 24, active_draws_since_eligible = 20
 *   meza/duka/kijiji/kwenda/kuamka/kuuza: FRESH, Repair-governed, target/hard-cap
 *     positions staggered across 43-49 (kuuza's hard cap coincides with its
 *     own target at 44 -- the one case used below to prove repair_hard_cap).
 *
 * ---------------------------------------------------------------------
 * What this file does NOT claim
 * ---------------------------------------------------------------------
 * repair_hard_cap remains a GLOBAL interrupt strictly above starvation,
 * unchanged by this correction (lib/learning-engine/scheduler/
 * interrupts.ts, never touched by this fix). This file does not assert
 * that active_starvation wins every turn once a card crosses the dynamic
 * threshold -- only that it is reached sooner, correctly pending, and
 * selected at the next Active-source slot NOT preempted by a genuine
 * repair_hard_cap collision. A sufficiently dense, sustained Wrong-forever
 * configuration CAN make repair_hard_cap dominate many consecutive turns
 * (confirmed separately, by a pure deterministic SchedulerSimulation
 * replay of this exact shape, kept as a unit-level regression in
 * tests/unit/learning-engine-scheduler-simulation.test.ts) -- that is a
 * pre-existing property of repair_hard_cap's own global priority, entirely
 * unchanged by this correction, not something this file re-litigates.
 */
let seedCounter = 100;
function nextRandom(): () => number {
  seedCounter += 1;
  let state = seedCounter;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const FRESH_SPECS: readonly { front: string; targetPosition: number; hardCapPosition: number }[] = [
  { front: "meza", targetPosition: 43, hardCapPosition: 45 },
  { front: "duka", targetPosition: 44, hardCapPosition: 47 },
  { front: "kijiji", targetPosition: 43, hardCapPosition: 46 },
  { front: "kwenda", targetPosition: 46, hardCapPosition: 48 },
  { front: "kuamka", targetPosition: 47, hardCapPosition: 49 },
  { front: "kuuza", targetPosition: 44, hardCapPosition: 44 },
];

describe("Alpha startup-sensitive Active starvation: real claim/commit pipeline proof (real local Supabase)", () => {
  const admin = createAdminClient();
  let userId: string;
  let deckId: string;
  let sessionId: string;
  let kupikaCardId: string;
  let kiatuCardId: string;
  let freshCardIds: Record<string, string>; // front -> card_id

  beforeAll(async () => {
    await resetTesterLearnerData(STARTUP_STARVATION_TESTER);
    const client = await createTesterClient(STARTUP_STARVATION_TESTER.email, STARTUP_STARVATION_TESTER.password);
    const { data: userData, error: userError } = await client.auth.getUser();
    if (userError || !userData.user) throw new Error("failed to resolve authenticated user", { cause: userError });
    userId = userData.user.id;

    // -- An 8-card custom deck: the entire deck, so the Active Pool can
    // never exceed 8, no matter how many further Corrects are scripted
    // (direct pre-state preparation, provision.ts's own sanctioned
    // pattern). --
    const { data: deck, error: deckError } = await admin
      .from("decks")
      .insert({
        name: "Startup Starvation Fixture Deck",
        description: "8-card disposable fixture deck for the Alpha startup-sensitive Active starvation integration test.",
        front_language: "en",
        back_language: "en",
        owner_user_id: userId,
        is_template: false,
        is_official: false,
        visibility: "private",
      })
      .select("id")
      .single();
    if (deckError) throw deckError;
    deckId = deck.id as string;

    const allFronts = ["kupika", "kiatu", ...FRESH_SPECS.map((f) => f.front)];
    const cardRows = allFronts.map((front, i) => ({
      deck_id: deckId,
      front,
      back: `${front}-back`,
      extra_content: {},
      created_by_user_id: userId,
      sort_order: i,
    }));
    const { data: cards, error: cardsError } = await admin.from("cards").insert(cardRows).select("id, front");
    if (cardsError) throw cardsError;

    const cardIdByFront = new Map((cards ?? []).map((c: { id: string; front: string }) => [c.front, c.id]));
    kupikaCardId = cardIdByFront.get("kupika")!;
    kiatuCardId = cardIdByFront.get("kiatu")!;
    freshCardIds = Object.fromEntries(FRESH_SPECS.map((f) => [f.front, cardIdByFront.get(f.front)!]));

    const { error: profileError } = await admin.from("profiles").update({ selected_deck_id: deckId, onboarding_completed: true }).eq("id", userId);
    if (profileError) throw profileError;

    // -- user_card_progress: one row per card, starting NEW (overwritten
    // to each test's exact target shape via seedShape() below). --
    const progressRows = allFronts.map((front) => ({
      user_id: userId,
      card_id: cardIdByFront.get(front)!,
      card_status: "NEW",
      seen_count: 0,
      correct_streak: 0,
      wrong_streak: 0,
    }));
    const { error: progressError } = await admin.from("user_card_progress").insert(progressRows);
    if (progressError) throw progressError;

    // -- Direct rollout + deck-learning-state construction: a
    // learning_engine_v1_rollout row's mere EXISTENCE is what
    // start_or_resume_session() checks to assign engine_version = 'v1' to
    // a brand-new session (20261017000000_learning_engine_v1_runtime_cutover_rc_d.sql) --
    // inserting it directly here (rather than via
    // enrollUserInLearningEngineV1(), which assumes and normalizes LEGACY
    // pre-cutover data) is correct for a fixture whose rows are already
    // v1-shaped from the start. --
    const { error: rolloutError } = await admin.from("learning_engine_v1_rollout").insert({ user_id: userId });
    if (rolloutError) throw rolloutError;

    const { error: deckStateError } = await admin.from("user_deck_learning_state").insert({ user_id: userId, deck_id: deckId });
    if (deckStateError) throw deckStateError;

    const session = await startOrResumeSessionFor({ client, deckId });
    sessionId = session.id;

    const sessionRow = await admin.from("sessions").select("engine_version").eq("id", sessionId).single();
    expect(sessionRow.data?.engine_version).toBe("v1");
  });

  afterAll(async () => {
    await resetTesterLearnerData(STARTUP_STARVATION_TESTER);
  });

  beforeEach(async () => {
    // An open claim from a previous case would make the next claim call
    // return it unchanged (claimNextLearningEngineCard's documented
    // "reuse the open claim" fast path) instead of computing a fresh
    // decision against this case's freshly-seeded state.
    const { error } = await admin.from("selection_claims").delete().eq("user_id", userId);
    if (error) throw error;
  });

  /** Overwrites every one of the 8 fixture cards' user_card_progress row to the exact target shape, and the deck's scheduler_position/revision, directly via the admin client. */
  async function seedShape(params: {
    schedulerPosition: number;
    kupikaDraws: number;
    kiatuDraws: number;
    freshOverrides?: Partial<Record<string, { targetPosition: number; hardCapPosition: number }>>;
  }): Promise<void> {
    const { error: deckStateError } = await admin
      .from("user_deck_learning_state")
      .update({ scheduler_position: params.schedulerPosition, scheduler_revision: 87 })
      .eq("user_id", userId)
      .eq("deck_id", deckId);
    if (deckStateError) throw deckStateError;

    const l1Rows = [
      { cardId: kupikaCardId, draws: params.kupikaDraws, cooldown: 14 },
      { cardId: kiatuCardId, draws: params.kiatuDraws, cooldown: 24 },
    ];
    for (const row of l1Rows) {
      const { error } = await admin
        .from("user_card_progress")
        .update({
          card_status: "LEARNING",
          learning_stage: "LEARNING_1",
          pool_status: "ACTIVE",
          repair_pending: false,
          repair_wrong_position: null,
          repair_target_position: null,
          repair_hard_cap_position: null,
          correct_cooldown_until_position: row.cooldown,
          active_draws_since_eligible: row.draws,
          same_day_seen_count: 3,
          same_day_wrong_count: 2,
          first_presented_at: new Date(0).toISOString(),
        })
        .eq("user_id", userId)
        .eq("card_id", row.cardId);
      if (error) throw error;
    }

    for (const spec of FRESH_SPECS) {
      const override = params.freshOverrides?.[spec.front];
      const targetPosition = override?.targetPosition ?? spec.targetPosition;
      const hardCapPosition = override?.hardCapPosition ?? spec.hardCapPosition;
      const { error } = await admin
        .from("user_card_progress")
        .update({
          card_status: "LEARNING",
          learning_stage: "FRESH",
          pool_status: "ACTIVE",
          repair_pending: true,
          repair_wrong_position: targetPosition - 4,
          repair_target_position: targetPosition,
          repair_hard_cap_position: hardCapPosition,
          correct_cooldown_until_position: null,
          active_draws_since_eligible: 0,
          same_day_seen_count: 6,
          same_day_wrong_count: 6,
          first_presented_at: new Date(0).toISOString(),
        })
        .eq("user_id", userId)
        .eq("card_id", freshCardIds[spec.front]);
      if (error) throw error;
    }
  }

  async function claimAndGetReason(): Promise<{ cardId: string | null; reason: string | null }> {
    const claim = await claimNextLearningEngineCard(userId, sessionId, nextRandom());
    if (claim.selectionTraceId === null) return { cardId: claim.cardId, reason: null };
    const trace = await admin.from("learning_engine_selection_traces").select("selection_reason").eq("id", claim.selectionTraceId).single();
    return { cardId: claim.cardId, reason: trace.data?.selection_reason ?? null };
  }

  it("A/B/C: at the real tester 951 shape (8-card Active Pool, 2 eligible LEARNING_1 cards, 6 Fresh cards under Repair pressure), an L1 card above the NEW threshold (16) is selected via active_starvation -- even while repair_target candidates are simultaneously available, and even though it would NOT yet qualify under the old fixed threshold (40)", async () => {
    // kupika: 30 draws. 30 >= 16 (new, pool-size-8 threshold) but 30 < 40
    // (old fixed threshold) -- this is the exact real-world gap this
    // correction closes.
    expect(30).toBeGreaterThanOrEqual(16);
    expect(30).toBeLessThan(40);

    await seedShape({ schedulerPosition: 43, kupikaDraws: 30, kiatuDraws: 20 });

    // C: at position 43, meza and kijiji both have a target-reached (not
    // yet hard-capped) repair available -- genuine repair_target pressure
    // exists at this exact decision, confirmed by the fixture's own
    // targetPosition (43) <= schedulerPosition (43) for both, with neither
    // hardCapPosition (45, 46) yet reached.
    const result = await claimAndGetReason();

    expect(result.cardId).toBe(kupikaCardId);
    expect(result.reason).toBe("active_starvation");
  });

  it("D: repair_hard_cap (a GLOBAL interrupt) still beats active_starvation on a true hard-cap collision, even though an L1 card is simultaneously above the dynamic threshold", async () => {
    // One position later than case A: kuuza's own hard cap (44) is now
    // reached (its target and hard cap coincide in the real captured
    // data), while kupika remains starved (still 30 draws, untouched).
    await seedShape({ schedulerPosition: 44, kupikaDraws: 30, kiatuDraws: 20 });

    const result = await claimAndGetReason();

    expect(result.cardId).toBe(freshCardIds.kuuza);
    expect(result.reason).toBe("repair_hard_cap");
  });

  it("Wrong-forever stress: both long-waiting LEARNING_1 cards are eventually rescued by active_starvation at a non-hard-cap Active slot, within a bounded number of real decisions, with no deadlock -- without ever answering the six Repair-governed Fresh cards Correct", async () => {
    await seedShape({ schedulerPosition: 43, kupikaDraws: 30, kiatuDraws: 20 });

    const MAX_DECISIONS = 20;
    const firstReasonSeen: Record<string, string> = {};
    let sawRepairHardCap = false;
    let lastSchedulerPosition = 43;

    for (let i = 0; i < MAX_DECISIONS; i += 1) {
      const claim = await claimNextLearningEngineCard(userId, sessionId, nextRandom());
      expect(claim.cardId).not.toBeNull(); // liveness: a decision is always produced, never a deadlock
      if (claim.cardId === null || claim.claimId === null) break;

      const trace = await admin.from("learning_engine_selection_traces").select("selection_reason").eq("id", claim.selectionTraceId!).single();
      const reason = trace.data?.selection_reason ?? null;
      if (reason === "repair_hard_cap") sawRepairHardCap = true;

      const isL1Card = claim.cardId === kupikaCardId || claim.cardId === kiatuCardId;
      if (isL1Card && !(claim.cardId in firstReasonSeen)) {
        firstReasonSeen[claim.cardId] = reason ?? "unknown";
      }

      // The six Fresh cards are answered Wrong forever -- the essential
      // stress condition that caused the real problem. The two
      // LEARNING_1 cards are answered Correct, but ONLY when actually
      // selected (never forced).
      await commitLearningEngineAnswer(userId, sessionId, claim.claimId, {
        clientEventId: crypto.randomUUID(),
        correct: isL1Card,
        responseTimeMs: 500,
        timeToFirstActionMs: null,
      });

      lastSchedulerPosition = claim.schedulerPosition + 1;
      if (kupikaCardId in firstReasonSeen && kiatuCardId in firstReasonSeen) break;
    }

    expect(firstReasonSeen[kupikaCardId]).toBe("active_starvation");
    expect(firstReasonSeen[kiatuCardId]).toBe("active_starvation");
    // Expected and acceptable, not asserted away: repair_hard_cap did win
    // at least one real turn along the way (this is not a bug -- see this
    // file's own header).
    expect(sawRepairHardCap).toBe(true);
    // Liveness: scheduler_position kept advancing throughout: no stuck
    // decision, no thrown error, across the whole bounded run.
    expect(lastSchedulerPosition).toBeGreaterThan(43);
  });
});
