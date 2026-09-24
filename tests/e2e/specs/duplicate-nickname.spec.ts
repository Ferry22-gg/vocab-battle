import { test, expect } from "@playwright/test";
import { loginAs, expectPath } from "../helpers";
import { DUPLICATE_NICKNAME_TESTER, NICKNAME_HOLDER } from "../fixtures/identities";
import { getProfileByPublicUserId } from "../db-assertions";

test("case-insensitive duplicate nickname shows a friendly error, doesn't persist", async ({
  page,
}) => {
  // NICKNAME_HOLDER (802) is fixture-seeded with nickname "E2ENickname".
  // This tester (803) attempts a case-different duplicate of it.
  const collidingNickname = NICKNAME_HOLDER.nickname!.toLowerCase();

  await loginAs(
    page,
    DUPLICATE_NICKNAME_TESTER.publicUserId,
    DUPLICATE_NICKNAME_TESTER.password
  );
  await expectPath(page, "/onboarding/nickname");

  await page.getByLabel("Nickname").fill(collidingNickname);
  await page.getByRole("button", { name: /continue/i }).click();

  await expect(page.getByRole("alert")).toHaveText(
    "That nickname is taken. Please choose another."
  );
  // Still on the nickname form -- did not advance to /onboarding/deck.
  await expect(page).toHaveURL((url) => url.pathname === "/onboarding/nickname");

  const profile = await getProfileByPublicUserId(
    DUPLICATE_NICKNAME_TESTER.publicUserId
  );
  expect(profile?.nickname).toBeNull();
});
