import { test, expect } from "@playwright/test";
import { loginAs, logoutViaButton, expectPath } from "../helpers";
import { MISSING_PROFILE_USER } from "../fixtures/identities";
import { getProfileByPublicUserId } from "../db-assertions";

test("valid Auth user with no profiles row routes to /profile-missing, no loop, can log out", async ({
  page,
}) => {
  await loginAs(
    page,
    MISSING_PROFILE_USER.publicUserId,
    MISSING_PROFILE_USER.password
  );

  await expectPath(page, "/profile-missing");
  await expect(
    page.getByRole("heading", { name: "Account issue" })
  ).toBeVisible();

  // No redirect loop: reload the same page, still here, still rendered.
  await page.reload();
  await expectPath(page, "/profile-missing");
  await expect(
    page.getByRole("heading", { name: "Account issue" })
  ).toBeVisible();

  // Confirm no profile row was ever created for this identity by any of
  // the above (proves the page doesn't provision).
  const profile = await getProfileByPublicUserId(
    MISSING_PROFILE_USER.publicUserId
  );
  expect(profile).toBeNull();

  await logoutViaButton(page);
  await expectPath(page, "/login");
});
