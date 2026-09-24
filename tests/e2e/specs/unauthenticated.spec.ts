import { test, expect } from "@playwright/test";

test.describe("Unauthenticated route protection", () => {
  test("visiting / redirects to /login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL((url) => url.pathname === "/login");
  });

  const protectedPaths = [
    "/onboarding/nickname",
    "/onboarding/deck",
    "/admin",
    "/account-disabled",
    "/profile-missing",
  ];

  for (const path of protectedPaths) {
    test(`visiting ${path} redirects to /login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL((url) => url.pathname === "/login");
    });
  }
});
