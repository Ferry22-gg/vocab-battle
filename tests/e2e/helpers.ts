import { expect, type Page } from "@playwright/test";

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
