import { test, expect, type Page } from "@playwright/test";
import { loginAs, expectPath } from "../helpers";
import { RC_E_V1_SMOKE_TESTER, RC_E_LEGACY_SMOKE_TESTER } from "../fixtures/identities";
import { getProfileByPublicUserId, getDecksOwnedBy } from "../db-assertions";
import { createAdminClient } from "../admin-client";
import { computeDeckProgress } from "../../../lib/learning-engine/progress/deck-progress";

/**
 * Learning Engine v1 Runtime Cutover RC-E: authenticated browser smoke
 * test for live Deck Progress rendering (spec/TODO "Deck Progress live
 * rendering") -- the first live UI consumer of
 * lib/learning-engine/progress/deck-progress.ts's computeDeckProgress(),
 * so this is required, not optional (mirrors
 * learning-engine-v1-rc-d-routing.spec.ts's own rationale for RC-D).
 *
 * Mobile viewport (390x844). Does NOT use a real tester account --
 * RC_E_V1_SMOKE_TESTER/RC_E_LEGACY_SMOKE_TESTER are dedicated, test-owned
 * identities (tests/e2e/fixtures/identities.ts), never enrolled/visible
 * to any real Alpha tester.
 *
 * The v1 case seeds two cards to known, legal card_status values directly
 * via the admin client (LEARNED and FORGOTTEN -- never the v1-only
 * LEARNING+learning_stage shape, since that combination has its own
 * stricter invariants enforced by the live scheduler snapshot path this
 * read-only Deck Progress query never goes through) and asserts the
 * rendered percentage matches computeDeckProgress() run directly against
 * that exact same known state -- never a hardcoded percentage that could
 * silently drift from the real card count of whichever official starter
 * deck onboarding offers.
 */
test.use({ viewport: { width: 390, height: 844 } });

async function completeOnboarding(page: Page, nickname: string): Promise<void> {
  await expectPath(page, "/onboarding/nickname");
  await page.getByLabel("Nickname").fill(nickname);
  await page.getByRole("button", { name: /continue/i }).click();

  await expectPath(page, "/onboarding/deck");
  await page.getByText("Advanced English Vocabulary I", { exact: true }).click();
  await page.getByRole("button", { name: /continue/i }).click();

  await expectPath(page, "/");
}

/**
 * Filters out Next.js dev-mode HMR WebSocket noise -- an artifact of this
 * local sandbox's `next dev` process lock forcing this suite to attach to
 * an already-running dev server on a hostname/port it wasn't started
 * for, never a real app console error. Every other recorded message
 * still fails the assertion below.
 */
function isRealConsoleError(text: string): boolean {
  return !text.includes("_next/hmr");
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
}

test("legacy smoke: Deck Detail/Decks list/Home never render Deck Progress -- only the authoritative Mastered count", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && isRealConsoleError(msg.text())) consoleErrors.push(msg.text());
  });

  await loginAs(page, RC_E_LEGACY_SMOKE_TESTER.publicUserId, RC_E_LEGACY_SMOKE_TESTER.password);
  await completeOnboarding(page, "RcELegacySmokeTester");

  const profile = await getProfileByPublicUserId(RC_E_LEGACY_SMOKE_TESTER.publicUserId);
  expect(profile?.selected_deck_id).not.toBeNull();
  const deckId = profile!.selected_deck_id as string;

  await page.goto(`/decks/${deckId}`);
  await expect(page.getByText("Mastered", { exact: false })).toBeVisible();
  await expect(page.getByText(/Deck Progress/i)).toHaveCount(0);
  await assertNoHorizontalOverflow(page);

  await page.goto("/decks");
  await expect(page.getByText(/Deck Progress/i)).toHaveCount(0);
  await assertNoHorizontalOverflow(page);

  await page.goto("/");
  await expect(page.getByText("Mastered", { exact: false })).toBeVisible();
  await expect(page.getByText(/Deck Progress/i)).toHaveCount(0);
  await assertNoHorizontalOverflow(page);

  expect(consoleErrors).toEqual([]);
});

test("v1 smoke: Deck Detail/Decks list/Home render live Deck Progress matching seeded per-card state", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && isRealConsoleError(msg.text())) consoleErrors.push(msg.text());
  });

  await loginAs(page, RC_E_V1_SMOKE_TESTER.publicUserId, RC_E_V1_SMOKE_TESTER.password);
  await completeOnboarding(page, "RcEV1SmokeTester");

  const profile = await getProfileByPublicUserId(RC_E_V1_SMOKE_TESTER.publicUserId);
  expect(profile?.selected_deck_id).not.toBeNull();
  const deckId = profile!.selected_deck_id as string;

  const admin = createAdminClient();

  // Admit to the v1 rollout via the real trusted primitive -- AFTER
  // onboarding created the deck, same as learning-engine-v1-rc-d-
  // routing.spec.ts's own v1 case. Zero pre-existing progress rows, so no
  // normalization is needed first.
  const { error: admitError } = await admin.rpc("admit_user_to_learning_engine_v1", { p_user_id: profile!.id });
  expect(admitError).toBeNull();

  const decks = await getDecksOwnedBy(RC_E_V1_SMOKE_TESTER.publicUserId);
  expect(decks.find((d) => d.id === deckId)).toBeTruthy();

  const { data: cardRows, error: cardsError } = await admin
    .from("cards")
    .select("id")
    .eq("deck_id", deckId)
    .is("deleted_at", null);
  expect(cardsError).toBeNull();
  const cardIds = (cardRows ?? []).map((row: { id: string }) => row.id);
  expect(cardIds.length).toBeGreaterThanOrEqual(2);

  // Known, legal seeded state: card[0] -> LEARNED (mastered), card[1] ->
  // FORGOTTEN (relearning), every other card left at whatever
  // duplicate_starter_deck() initialized it to (NEW either way -- no
  // progress row at all, or an explicit NEW row; computeDeckProgress
  // treats both identically) -- never the v1-only LEARNING shape, which
  // this read-only check does not need to exercise. upsert (not insert):
  // duplicate_starter_deck() may already seed a NEW row per card at deck
  // creation time.
  const { error: seedError } = await admin.from("user_card_progress").upsert(
    [
      { user_id: profile!.id, card_id: cardIds[0], card_status: "LEARNED", has_ever_been_mastered: true },
      { user_id: profile!.id, card_id: cardIds[1], card_status: "FORGOTTEN", has_ever_been_mastered: false },
    ],
    { onConflict: "user_id,card_id" },
  );
  expect(seedError).toBeNull();

  const expectedProgress = computeDeckProgress([
    { cardStatus: "LEARNED", learningStage: null },
    { cardStatus: "FORGOTTEN", learningStage: null },
    ...cardIds.slice(2).map(() => ({ cardStatus: "NEW" as const, learningStage: null })),
  ]);
  expect(expectedProgress.kind).toBe("ok");
  const expectedPercent = Math.round((expectedProgress as { progress: number }).progress * 100);

  await page.goto(`/decks/${deckId}`);
  await expect(page.getByText(`${expectedPercent}% Deck Progress`, { exact: true })).toBeVisible();
  await expect(page.getByText("1 Mastered", { exact: false })).toBeVisible();
  await assertNoHorizontalOverflow(page);

  await page.goto("/decks");
  await expect(page.getByText(`${expectedPercent}% Deck Progress`, { exact: true })).toBeVisible();
  await assertNoHorizontalOverflow(page);

  await page.goto("/");
  await expect(page.getByText(`${expectedPercent}% Deck Progress`, { exact: true })).toBeVisible();
  await assertNoHorizontalOverflow(page);

  expect(consoleErrors).toEqual([]);
});
