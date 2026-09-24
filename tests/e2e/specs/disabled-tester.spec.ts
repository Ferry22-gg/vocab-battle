import { test, expect } from "@playwright/test";
import { loginAs, logoutViaButton, expectPath } from "../helpers";
import { DISABLED_TESTER } from "../fixtures/identities";

test("disabled tester authenticates but is routed to /account-disabled, can log out", async ({
  page,
}) => {
  // Supabase Auth has no concept of account_status -- this login succeeds
  // at the Auth level exactly like any other tester's.
  await loginAs(page, DISABLED_TESTER.publicUserId, DISABLED_TESTER.password);

  await expectPath(page, "/account-disabled");
  await expect(
    page.getByRole("heading", { name: "Account disabled" })
  ).toBeVisible();

  await logoutViaButton(page);
  await expectPath(page, "/login");
});
