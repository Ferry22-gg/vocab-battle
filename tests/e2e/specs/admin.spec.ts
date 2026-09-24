import { test, expect } from "@playwright/test";
import { loginAs, expectPath } from "../helpers";
import { ADMIN } from "../fixtures/identities";
import { getProfileByPublicUserId } from "../db-assertions";

test("active admin logs in, routes to /admin, never enters tester onboarding", async ({
  page,
}) => {
  await loginAs(page, ADMIN.publicUserId, ADMIN.password);

  // login() -> "/" -> requireOnboardedTester() -> requireActiveTester() ->
  // role !== "tester" -> /admin. Never touches /onboarding/*.
  await expectPath(page, "/admin");
  await expect(page.getByText("Admin area")).toBeVisible();

  // Directly probing an onboarding route doesn't let the admin in either.
  await page.goto("/onboarding/nickname");
  await expectPath(page, "/admin");

  await page.goto("/onboarding/deck");
  await expectPath(page, "/admin");

  // No onboarding fixture fields were ever touched for this admin.
  const profile = await getProfileByPublicUserId(ADMIN.publicUserId);
  expect(profile?.role).toBe("admin");
  expect(profile?.account_status).toBe("active");
});
