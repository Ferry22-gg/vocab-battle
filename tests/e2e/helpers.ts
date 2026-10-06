import { expect, type Locator, type Page } from "@playwright/test";

export async function loginAs(
  page: Page,
  publicUserId: string,
  password: string
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("User ID").fill(publicUserId);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
}

export async function logoutViaButton(page: Page): Promise<void> {
  await page.getByRole("button", { name: /log out/i }).click();
}

/** Waits for navigation to settle on an exact pathname, then asserts it. */
export async function expectPath(page: Page, path: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === path);
  expect(new URL(page.url()).pathname).toBe(path);
}

/**
 * The app's own form-level error message, e.g. the login/nickname/deck
 * forms' `<p role="alert">`. Excludes Next.js's always-present
 * `__next-route-announcer__` div, which also carries `role="alert"
 * aria-live="assertive"` for its own route-change announcements -- a bare
 * `page.getByRole("alert")` matches both and fails Playwright's strict
 * mode whenever a form error is shown after a client-side navigation.
 */
export function getFormAlert(page: Page): Locator {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}
