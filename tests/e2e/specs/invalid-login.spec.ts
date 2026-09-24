import { test, expect } from "@playwright/test";
import { loginAs } from "../helpers";
import { FRESH_TESTER } from "../fixtures/identities";

const GENERIC_ERROR = "Incorrect ID or password.";

test.describe("Invalid login", () => {
  test("malformed public_user_id shows the generic error", async ({ page }) => {
    await loginAs(page, "not-an-id", "whatever-password-1");
    await expect(page.getByRole("alert")).toHaveText(GENERIC_ERROR);
    await expect(page).toHaveURL((url) => url.pathname === "/login");
  });

  test("valid-format id, wrong password shows the same generic error", async ({
    page,
  }) => {
    await loginAs(page, FRESH_TESTER.publicUserId, "definitely-wrong-pw-1");
    await expect(page.getByRole("alert")).toHaveText(GENERIC_ERROR);
    await expect(page).toHaveURL((url) => url.pathname === "/login");
  });

  test("no authenticated session is created after a failed login", async ({
    page,
  }) => {
    await loginAs(page, FRESH_TESTER.publicUserId, "definitely-wrong-pw-1");
    await expect(page.getByRole("alert")).toHaveText(GENERIC_ERROR);

    // A real session would let this through to Home; an unauthenticated
    // visitor gets bounced back to /login by Proxy.
    await page.goto("/");
    await expect(page).toHaveURL((url) => url.pathname === "/login");
  });
});
