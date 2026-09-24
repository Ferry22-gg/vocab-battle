import { test, expect } from "@playwright/test";
import { loginAs, logoutViaButton, expectPath } from "../helpers";
import { FRESH_TESTER } from "../fixtures/identities";
import { getDecksOwnedBy, getProfileByPublicUserId } from "../db-assertions";

const NICKNAME = "E2eFreshTester";

test("fresh active tester: login through onboarding to Home, then logout", async ({
  page,
}) => {
  await loginAs(page, FRESH_TESTER.publicUserId, FRESH_TESTER.password);

  // login() -> "/" -> requireOnboardedTester() -> no nickname -> here.
  await expectPath(page, "/onboarding/nickname");

  await page.getByLabel("Nickname").fill(NICKNAME);
  await page.getByRole("button", { name: /continue/i }).click();

  await expectPath(page, "/onboarding/deck");

  // Exactly the two official starter decks, by name, are offered -- not
  // just "some two decks".
  const deckRadios = page.locator('input[name="deckId"]');
  await expect(deckRadios).toHaveCount(2);
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

  await expect(
    page.getByRole("heading", { name: `Welcome, ${NICKNAME}` })
  ).toBeVisible();
  await expect(
    page.getByText(`Tester ID ${FRESH_TESTER.publicUserId}`)
  ).toBeVisible();
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

  // -- Logout --
  await logoutViaButton(page);
  await expectPath(page, "/login");

  // / is protected again after logout.
  await page.goto("/");
  await expectPath(page, "/login");
});
