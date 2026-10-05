import { test, expect, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loginAs, expectPath } from "../helpers";
import { RC_E_MASTERY_SINGLE_TESTER, RC_E_MASTERY_SIMULTANEOUS_TESTER } from "../fixtures/identities";
import { getProfileByPublicUserId } from "../db-assertions";
import { createAdminClient } from "../admin-client";

/**
 * Learning Engine v1 Runtime Cutover RC-E: authenticated browser
 * acceptance test for the live mastery-notification path (spec sections
 * 15/25.1) -- the first live exercise of the real ACQUIRED -> LEARNED
 * FSRS_DUE transition (lib/learning-engine/fsrs/lifecycle.ts's
 * resolveQualifyingFsrsCorrect, dispatched from
 * lib/learning-engine/runtime/prepare-answer.ts's "due_weighted_selection"
 * branch) through the actual UI, not a direct call to the toast
 * components or the pure predicates (those are already unit-tested; see
 * this module's own section-3 citations below).
 *
 * ---------------------------------------------------------------------
 * Why a dedicated custom deck, not an official starter template
 * ---------------------------------------------------------------------
 * Reaching ACQUIRED -> LEARNED for real requires a card whose
 * fsrsReviewCorrectCount/fsrsReviewCorrectStreak are one qualifying
 * FSRS_DUE Correct away from MASTERY_CORRECT_COUNT_REQUIRED (3) /
 * MASTERY_CORRECT_STREAK_REQUIRED (2) (lib/learning-engine/config.ts) --
 * seeded directly via the admin client rather than played through
 * (playing through would require actually waiting out real FSRS
 * intervals). Every other card in the deck must NOT be an eligible
 * ACTIVE or NEAR_DUE/FSRS_DUE candidate, or the real weighted-random
 * top-level source draw (lib/learning-engine/scheduler/next-card.ts) could
 * nondeterministically pick a different source/card than the one this
 * test seeded -- see renormalizeSourceWeights (scheduler/renormalize.ts):
 * an EMPTY source's weight is masked to 0 before the draw, so if ACTIVE
 * and NEAR_DUE both have zero eligible candidates, FSRS_DUE deterministically
 * gets the full 1.0 weight, and with exactly one FSRS_DUE candidate,
 * chooseDueCard's own weighted pick is trivially deterministic too. The
 * official starter templates have many cards that would all start NEW
 * (pool_status = null) -- a NEW card is a valid, zero-write "virtual"
 * ACTIVE candidate via computeActiveAdmissions
 * (lib/learning-engine/active-pool.ts), so leaving ANY card NEW would
 * reintroduce exactly this nondeterminism. A tiny custom deck lets every
 * single card be seeded to a definite, non-NEW, non-competing state.
 *
 * Every seeded row is a genuine, fully-structurally-valid v1 card state
 * (verified against lib/learning-engine/runtime/snapshot-mapper.ts's
 * validateCardInvariants and lib/learning/fsrs.ts's progressToFsrsCard --
 * the same validation a live claim/commit goes through) -- never a
 * shortcut that skips RC-C's real commit_learning_engine_v1_answer()
 * transaction. The ACQUIRED -> LEARNED transition itself, the
 * cardMasteredJustNow/fullMasteryJustAchieved flags, and the
 * has_achieved_full_mastery flip are all produced live, by the real RPC,
 * when the browser submits the Correct answer -- nothing about the
 * mastery outcome itself is seeded or faked.
 */
test.use({ viewport: { width: 390, height: 844 } });

const FRONT_LANGUAGE = "English";
const BACK_LANGUAGE = "Japanese";

async function completeOnboarding(page: Page, nickname: string): Promise<void> {
  await expectPath(page, "/onboarding/nickname");
  await page.getByLabel("Nickname").fill(nickname);
  await page.getByRole("button", { name: /continue/i }).click();

  await expectPath(page, "/onboarding/deck");
  await page.getByText("Advanced English Vocabulary I", { exact: true }).click();
  await page.getByRole("button", { name: /continue/i }).click();

  await expectPath(page, "/");
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
}

/** Next.js dev-mode HMR WebSocket noise -- see learning-engine-v1-rc-e-deck-progress.spec.ts's own identical helper for why this sandbox needs it; never a real app console error. */
function isRealConsoleError(text: string): boolean {
  return !text.includes("_next/hmr");
}

/** A dedicated, tiny deck owned by `userId` -- never one of the official starter templates, so every card's progress can be fully controlled (see module header). */
async function createCustomDeck(admin: SupabaseClient, userId: string, name: string): Promise<string> {
  const { data, error } = await admin
    .from("decks")
    .insert({
      name,
      front_language: FRONT_LANGUAGE,
      back_language: BACK_LANGUAGE,
      owner_user_id: userId,
      is_template: false,
      is_official: false,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function createCard(admin: SupabaseClient, deckId: string, front: string, back: string): Promise<string> {
  const { data, error } = await admin.from("cards").insert({ deck_id: deckId, front, back }).select("id").single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/**
 * The ONE qualifying-FSRS-Due-away-from-first-time-Mastery state (spec
 * section 15.1/34.3): ACQUIRED, poolStatus OUTSIDE, fsrsReviewCorrectCount
 * = MASTERY_CORRECT_COUNT_REQUIRED - 1 (2), fsrsReviewCorrectStreak =
 * MASTERY_CORRECT_STREAK_REQUIRED - 1 (1) -- so the next qualifying
 * Correct crosses both thresholds
 * (lib/learning-engine/transitions.ts's applyQualifyingFsrsCorrect) and
 * promotes to LEARNED. `fsrs_last_review_at` 2 days ago against a
 * 1-day `fsrs_scheduled_days` gives intervalProgress = 2.0 >= 1.0 --
 * unambiguously FSRS_DUE, never NEAR_DUE
 * (lib/learning-engine/fsrs/due-classification.ts's NEAR_DUE_END_PROGRESS
 * = 1.0).
 */
async function seedQualifyingAcquiredCard(admin: SupabaseClient, userId: string, cardId: string, now: Date): Promise<void> {
  const lastReview = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const dueAt = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
  const { error } = await admin.from("user_card_progress").insert({
    user_id: userId,
    card_id: cardId,
    card_status: "ACQUIRED",
    learning_stage: null,
    pool_status: "OUTSIDE",
    relearning_phase: null,
    has_ever_been_mastered: false,
    repair_pending: false,
    fsrs_review_correct_count: 2,
    fsrs_review_correct_streak: 1,
    fsrs_state: 2, // ts-fsrs State.Review
    fsrs_stability: 5,
    fsrs_difficulty: 5,
    fsrs_elapsed_days: 2,
    fsrs_scheduled_days: 1,
    fsrs_reps: 3,
    fsrs_lapses: 0,
    fsrs_learning_steps: 0,
    fsrs_last_review_at: lastReview.toISOString(),
    fsrs_due_at: dueAt.toISOString(),
  });
  if (error) throw error;
}

/**
 * An ACQUIRED, OUTSIDE-pool card that is deliberately NOT due (scheduled
 * 30 days out from a review that just happened -- intervalProgress ~ 0,
 * far below NEAR_DUE_START_PROGRESS = 0.75) -- inert for every ordinary
 * source (ACTIVE requires pool_status = ACTIVE or a never-presented NEW
 * card, neither of which this is; NEAR_DUE/FSRS_DUE both require
 * intervalProgress >= 0.75). Satisfies "at least one other card not
 * Mastered" (ACQUIRED is not user-facing MASTERED) without ever competing
 * for selection.
 */
async function seedInertAcquiredCard(admin: SupabaseClient, userId: string, cardId: string, now: Date): Promise<void> {
  const { error } = await admin.from("user_card_progress").insert({
    user_id: userId,
    card_id: cardId,
    card_status: "ACQUIRED",
    learning_stage: null,
    pool_status: "OUTSIDE",
    relearning_phase: null,
    has_ever_been_mastered: false,
    repair_pending: false,
    fsrs_review_correct_count: 0,
    fsrs_review_correct_streak: 0,
    fsrs_state: 2,
    fsrs_stability: 5,
    fsrs_difficulty: 5,
    fsrs_elapsed_days: 0,
    fsrs_scheduled_days: 30,
    fsrs_reps: 1,
    fsrs_lapses: 0,
    fsrs_learning_steps: 0,
    fsrs_last_review_at: now.toISOString(),
    fsrs_due_at: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (error) throw error;
}

/**
 * Already LEARNED (first-time-mastered in the past) AND not currently
 * due -- same inertness argument as seedInertAcquiredCard. Used as the
 * "every other live card already LEARNED" fixture for the simultaneous
 * Full Mastery scenario, so this card contributes to mastered_count/
 * has_achieved_full_mastery without ever becoming a competing selection
 * candidate itself.
 */
async function seedInertLearnedCard(admin: SupabaseClient, userId: string, cardId: string, now: Date): Promise<void> {
  const { error } = await admin.from("user_card_progress").insert({
    user_id: userId,
    card_id: cardId,
    card_status: "LEARNED",
    learning_stage: null,
    pool_status: "OUTSIDE",
    relearning_phase: null,
    has_ever_been_mastered: true,
    repair_pending: false,
    fsrs_review_correct_count: 3,
    fsrs_review_correct_streak: 2,
    fsrs_state: 2,
    fsrs_stability: 8,
    fsrs_difficulty: 4,
    fsrs_elapsed_days: 0,
    fsrs_scheduled_days: 30,
    fsrs_reps: 4,
    fsrs_lapses: 0,
    fsrs_learning_steps: 0,
    fsrs_last_review_at: now.toISOString(),
    fsrs_due_at: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    first_mastered_at: now.toISOString(),
    last_mastered_at: now.toISOString(),
  });
  if (error) throw error;
}

test("first-time Card Mastered through the real v1 FSRS_DUE path -- Full Mastery does not fire", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && isRealConsoleError(msg.text())) consoleErrors.push(msg.text());
  });

  await loginAs(page, RC_E_MASTERY_SINGLE_TESTER.publicUserId, RC_E_MASTERY_SINGLE_TESTER.password);
  await completeOnboarding(page, "RcEMasterySingle");

  const profile = await getProfileByPublicUserId(RC_E_MASTERY_SINGLE_TESTER.publicUserId);
  expect(profile).not.toBeNull();
  const admin = createAdminClient();

  const { error: admitError } = await admin.rpc("admit_user_to_learning_engine_v1", { p_user_id: profile!.id });
  expect(admitError).toBeNull();

  const now = new Date();
  const deckId = await createCustomDeck(admin, profile!.id, "RC-E Mastery Single Deck");
  const targetCardId = await createCard(admin, deckId, "Mastery Target Front", "Mastery Target Back");
  const otherCardId = await createCard(admin, deckId, "Inert Other Front", "Inert Other Back");

  await seedQualifyingAcquiredCard(admin, profile!.id, targetCardId, now);
  await seedInertAcquiredCard(admin, profile!.id, otherCardId, now);

  // Establishes a true baseline the same way as the simultaneous-mastery
  // test below (see that test's own comment) -- 0/2 mastered here, since
  // neither seeded card is LEARNED yet.
  const { error: recomputeError } = await admin.rpc("recompute_user_deck_learning_state_for_v1", {
    p_user_id: profile!.id,
    p_deck_id: deckId,
  });
  expect(recomputeError).toBeNull();

  const { error: selectDeckError } = await admin.from("profiles").update({ selected_deck_id: deckId }).eq("id", profile!.id);
  expect(selectDeckError).toBeNull();

  await page.goto("/session");
  await expectPath(page, "/session");

  // The real scheduler selected our seeded target card, via the real
  // FSRS_DUE source -- never asserted indirectly.
  await expect(page.getByText("Mastery Target Front", { exact: true })).toBeVisible();
  await assertNoHorizontalOverflow(page);

  await page.getByLabel("Reveal the meaning").click();
  await expect(page.getByLabel("Correct -- I recalled this correctly")).toBeVisible();
  await page.getByLabel("Correct -- I recalled this correctly").click();

  // Card Mastered fires; Full Mastery does not (otherCardId is still only
  // ACQUIRED, so mastered_count 1/2 never reaches the deck's total).
  await expect(page.getByText("⭐ Card mastered", { exact: true })).toBeVisible();
  await expect(page.getByText("🏆 Deck fully mastered!", { exact: true })).toHaveCount(0);

  // Next-card interaction remains immediately usable -- either a fresh
  // card (Reveal) or the graceful "nothing to study" empty state, never
  // the error/unavailable state.
  await expect(page.getByLabel("Reveal the meaning").or(page.getByText("Nothing to study right now"))).toBeVisible();
  await expect(page.getByText("Couldn't load your next card")).toHaveCount(0);
  await assertNoHorizontalOverflow(page);

  const { data: progressAfter } = await admin
    .from("user_card_progress")
    .select("card_status")
    .eq("user_id", profile!.id)
    .eq("card_id", targetCardId)
    .maybeSingle();
  expect(progressAfter?.card_status).toBe("LEARNED");

  const { data: deckStateAfter } = await admin
    .from("user_deck_learning_state")
    .select("mastered_count, has_achieved_full_mastery")
    .eq("user_id", profile!.id)
    .eq("deck_id", deckId)
    .maybeSingle();
  expect(deckStateAfter?.mastered_count).toBe(1);
  expect(deckStateAfter?.has_achieved_full_mastery).toBe(false);

  expect(consoleErrors).toEqual([]);
});

test("simultaneous final-card Card Mastered + Full Mastery through the real v1 FSRS_DUE path -- neither suppresses the other", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && isRealConsoleError(msg.text())) consoleErrors.push(msg.text());
  });

  await loginAs(page, RC_E_MASTERY_SIMULTANEOUS_TESTER.publicUserId, RC_E_MASTERY_SIMULTANEOUS_TESTER.password);
  await completeOnboarding(page, "RcEMasterySimul");

  const profile = await getProfileByPublicUserId(RC_E_MASTERY_SIMULTANEOUS_TESTER.publicUserId);
  expect(profile).not.toBeNull();
  const admin = createAdminClient();

  const { error: admitError } = await admin.rpc("admit_user_to_learning_engine_v1", { p_user_id: profile!.id });
  expect(admitError).toBeNull();

  const now = new Date();
  const deckId = await createCustomDeck(admin, profile!.id, "RC-E Mastery Simultaneous Deck");
  const targetCardId = await createCard(admin, deckId, "Final Mastery Target Front", "Final Mastery Target Back");
  const alreadyLearnedCardId = await createCard(admin, deckId, "Already Learned Front", "Already Learned Back");

  await seedQualifyingAcquiredCard(admin, profile!.id, targetCardId, now);
  await seedInertLearnedCard(admin, profile!.id, alreadyLearnedCardId, now);

  // user_deck_learning_state.mastered_count/has_achieved_full_mastery are
  // maintained INCREMENTALLY by the live commit RPC, never recomputed
  // from a plain read -- a directly-seeded (not live-answered) LEARNED
  // row is invisible to it otherwise (confirmed: the scheduler snapshot's
  // own lazy upsert only guarantees the row EXISTS, at its all-zero
  // defaults, never recomputes it). recompute_user_deck_learning_state_for_v1
  // is the same trusted RC-A primitive the one-time cutover path uses for
  // exactly this -- establishing a true starting baseline here, not
  // bypassing any live commit logic the test itself still exercises.
  const { error: recomputeError } = await admin.rpc("recompute_user_deck_learning_state_for_v1", {
    p_user_id: profile!.id,
    p_deck_id: deckId,
  });
  expect(recomputeError).toBeNull();

  const { error: selectDeckError } = await admin.from("profiles").update({ selected_deck_id: deckId }).eq("id", profile!.id);
  expect(selectDeckError).toBeNull();

  // mastered_count consistent with current live state BEFORE the final
  // answer -- 1 of 2, not yet full mastery.
  await page.goto("/session");
  await expectPath(page, "/session");

  const { data: deckStateBefore } = await admin
    .from("user_deck_learning_state")
    .select("mastered_count, has_achieved_full_mastery")
    .eq("user_id", profile!.id)
    .eq("deck_id", deckId)
    .maybeSingle();
  expect(deckStateBefore?.mastered_count).toBe(1);
  expect(deckStateBefore?.has_achieved_full_mastery).toBe(false);

  await expect(page.getByText("Final Mastery Target Front", { exact: true })).toBeVisible();
  await assertNoHorizontalOverflow(page);

  await page.getByLabel("Reveal the meaning").click();
  await expect(page.getByLabel("Correct -- I recalled this correctly")).toBeVisible();
  await page.getByLabel("Correct -- I recalled this correctly").click();

  // Both notifications fire for the SAME answer -- neither suppresses the
  // other, no modal/Continue/Dismiss step, both at a fixed non-overlapping
  // position (app/session/battle-scene.tsx's CARD_MASTERED_TOP/
  // FULL_MASTERY_TOP) so they are both usable at 390x844.
  await expect(page.getByText("⭐ Card mastered", { exact: true })).toBeVisible();
  await expect(page.getByText("🏆 Deck fully mastered!", { exact: true })).toBeVisible();
  await assertNoHorizontalOverflow(page);

  // Next-card interaction is not blocked by either toast.
  await expect(page.getByLabel("Reveal the meaning").or(page.getByText("Nothing to study right now"))).toBeVisible();
  await expect(page.getByText("Couldn't load your next card")).toHaveCount(0);

  const { data: progressAfter } = await admin
    .from("user_card_progress")
    .select("card_status")
    .eq("user_id", profile!.id)
    .eq("card_id", targetCardId)
    .maybeSingle();
  expect(progressAfter?.card_status).toBe("LEARNED");

  const { data: deckStateAfter } = await admin
    .from("user_deck_learning_state")
    .select("mastered_count, has_achieved_full_mastery")
    .eq("user_id", profile!.id)
    .eq("deck_id", deckId)
    .maybeSingle();
  expect(deckStateAfter?.mastered_count).toBe(2);
  expect(deckStateAfter?.has_achieved_full_mastery).toBe(true);

  expect(consoleErrors).toEqual([]);
});
