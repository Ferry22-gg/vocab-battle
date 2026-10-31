import { test, expect } from "@playwright/test";
import { loginAs, expectPath } from "../helpers";
import { FRESH_TESTER } from "../fixtures/identities";
import { getDecksOwnedBy, getProfileByPublicUserId } from "../db-assertions";

const NICKNAME = "E2eFreshTester";

test("fresh active tester: login through onboarding to Home", async ({
  page,
}) => {
  await loginAs(page, FRESH_TESTER.publicUserId, FRESH_TESTER.password);

  // login() -> "/" -> requireOnboardedTester() -> no nickname -> here.
  await expectPath(page, "/onboarding/nickname");

  await page.getByLabel("Nickname").fill(NICKNAME);
  await page.getByRole("button", { name: /continue/i }).click();

  await expectPath(page, "/onboarding/deck");

  // Exactly the three official starter decks are offered (two English
  // decks plus Swahili Basics) -- not just "some three decks".
  const deckRadios = page.locator('input[name="deckId"]');
  await expect(deckRadios).toHaveCount(3);
  await expect(
    page.getByText("Advanced English Vocabulary I", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("Advanced English Vocabulary II", { exact: true })
  ).toBeVisible();

  await page
    .getByText("Advanced English Vocabulary I", { exact: true })
    .click();
  await page.getByRole("button", { name: /continue/i }).click();

  // duplicate_starter_deck() completes -> Home.
  await expectPath(page, "/");

  // Current Home header shows the nickname as plain text, not a heading,
  // and no longer surfaces the tester's public ID anywhere on Home
  // (app/home/home-header.tsx) -- this is the P3 game-style Home
  // redesign, not a v1 runtime-cutover behavior, so there is nothing to
  // fix on the app side here.
  await expect(page.getByText(NICKNAME, { exact: true })).toBeVisible();
  await expect(
    page.getByText("Advanced English Vocabulary I", { exact: true })
  ).toBeVisible();

  // -- Persistence assertions (local Admin-side, after browser actions) --
  const profile = await getProfileByPublicUserId(FRESH_TESTER.publicUserId);
  expect(profile).not.toBeNull();
  expect(profile?.nickname).toBe(NICKNAME);
  expect(profile?.onboarding_completed).toBe(true);
  expect(profile?.selected_deck_id).not.toBeNull();

  const ownedDecks = await getDecksOwnedBy(FRESH_TESTER.publicUserId);
  expect(ownedDecks).toHaveLength(1);
  expect(ownedDecks[0]!.id).toBe(profile?.selected_deck_id);
  expect(ownedDecks[0]!.name).toBe("Advanced English Vocabulary I");
});
