import { test, expect, type Page } from "@playwright/test";
import { loginAs, expectPath } from "../helpers";
import { RC_D_V1_SMOKE_TESTER, RC_D_LEGACY_SMOKE_TESTER } from "../fixtures/identities";
import { getProfileByPublicUserId } from "../db-assertions";
import { createAdminClient } from "../admin-client";

/**
 * Learning Engine v1 Runtime Cutover RC-D: authenticated browser smoke
 * test (RC-D section 34) -- the first live UI wiring for the v1 engine,
 * so this is required, not optional.
 *
 * Admission for the v1 tester is performed here via the real
 * `admit_user_to_learning_engine_v1` RPC (the exact primitive
 * lib/learning-engine/cutover/enroll.ts's enrollUserInLearningEngineV1()
 * also calls, after normalization -- not needed here since this is a
 * freshly onboarded tester with zero pre-existing legacy progress,
 * exactly the case tests/integration/17-learning-engine-v1-rc-d-routing.test.ts's
 * own "scenario 2" already proves normalizes to zero cards). Called
 * directly via the admin client rather than importing
 * enrollUserInLearningEngineV1() from this Playwright spec: that import
 * chain pulls in `server-only`-guarded modules (lib/supabase/service-role.ts),
 * which throws outside Next.js's react-server build condition -- exactly
 * why the unit/integration suites each carry their own `server-only`
 * shim (vitest-setup.ts), which this Playwright suite has no equivalent
 * for and does not need one just for this single call.
 *
 * Mobile viewport per RC-D section 34 (390x844). Does NOT use a real
 * tester account (RC-D section 29) -- RC_D_V1_SMOKE_TESTER/
 * RC_D_LEGACY_SMOKE_TESTER are dedicated, test-owned identities
 * (tests/e2e/fixtures/identities.ts), never enrolled/visible to any real
 * Alpha tester.
 */
test.use({ viewport: { width: 390, height: 844 } });

const V1_NICKNAME = "RcDV1SmokeTester";
const LEGACY_NICKNAME = "RcDLegacySmokeTester";

async function completeOnboarding(page: Page, nickname: string): Promise<void> {
  await expectPath(page, "/onboarding/nickname");
  await page.getByLabel("Nickname").fill(nickname);
  await page.getByRole("button", { name: /continue/i }).click();

  await expectPath(page, "/onboarding/deck");
  await page.getByText("Advanced English Vocabulary I", { exact: true }).click();
  await page.getByRole("button", { name: /continue/i }).click();

  await expectPath(page, "/");
}

test("legacy smoke: a never-enrolled tester's Session flow is completely unchanged", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await loginAs(page, RC_D_LEGACY_SMOKE_TESTER.publicUserId, RC_D_LEGACY_SMOKE_TESTER.password);
  await completeOnboarding(page, LEGACY_NICKNAME);

  const profile = await getProfileByPublicUserId(RC_D_LEGACY_SMOKE_TESTER.publicUserId);
  expect(profile).not.toBeNull();

  await page.goto("/session");
  await expectPath(page, "/session");

  // A card renders -- front text visible, no horizontal overflow.
  await expect(page.getByLabel("Reveal the meaning")).toBeVisible();
  const bodyScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const bodyClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(bodyScrollWidth).toBeLessThanOrEqual(bodyClientWidth + 1);

  await page.getByLabel("Reveal the meaning").click();
  await expect(page.getByLabel("Correct -- I recalled this correctly")).toBeVisible();
  await page.getByLabel("Correct -- I recalled this correctly").click();

  // A fresh card loads after grading -- the loop continues.
  await expect(page.getByLabel("Reveal the meaning")).toBeVisible();

  const admin = createAdminClient();
  const { data: sessionRow } = await admin.from("sessions").select("id, engine_version").eq("user_id", profile!.id).eq("status", "active").maybeSingle();
  expect(sessionRow?.engine_version).toBe("legacy");

  expect(consoleErrors).toEqual([]);
});

test("v1 smoke: an enrolled tester's Session flow routes live to the v1 engine end-to-end", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await loginAs(page, RC_D_V1_SMOKE_TESTER.publicUserId, RC_D_V1_SMOKE_TESTER.password);
  await completeOnboarding(page, V1_NICKNAME);

  const profile = await getProfileByPublicUserId(RC_D_V1_SMOKE_TESTER.publicUserId);
  expect(profile).not.toBeNull();

  // Admit to the v1 rollout via the real trusted primitive -- AFTER
  // onboarding created the deck, mirroring when a real operator would
  // run enrollUserInLearningEngineV1() for an already-onboarded tester.
  const admin = createAdminClient();
  const { error: admitError } = await admin.rpc("admit_user_to_learning_engine_v1", { p_user_id: profile!.id });
  expect(admitError).toBeNull();

  await page.goto("/session");
  await expectPath(page, "/session");

  // This is a brand-new session created AFTER admission -> must be v1.
  const { data: sessionRow } = await admin.from("sessions").select("id, engine_version").eq("user_id", profile!.id).eq("status", "active").maybeSingle();
  expect(sessionRow?.engine_version).toBe("v1");
  const sessionId = sessionRow!.id as string;

  // Card displays correctly, no scheduler/source internals leaked, no
  // horizontal overflow.
  await expect(page.getByLabel("Reveal the meaning")).toBeVisible();
  const bodyScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const bodyClientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(bodyScrollWidth).toBeLessThanOrEqual(bodyClientWidth + 1);

  const { data: claimBefore } = await admin.from("selection_claims").select("id, status").eq("session_id", sessionId).eq("status", "OPEN").maybeSingle();
  expect(claimBefore).not.toBeNull();

  // Refresh while the OPEN claim exists -- the SAME card/claim resumes
  // (RC-D acceptance invariant: a reload is not a new logical selection).
  await page.reload();
  await expectPath(page, "/session");
  await expect(page.getByLabel("Reveal the meaning")).toBeVisible();
  const { data: claimAfterReload } = await admin.from("selection_claims").select("id, status").eq("session_id", sessionId).eq("status", "OPEN").maybeSingle();
  expect(claimAfterReload?.id).toBe(claimBefore?.id);

  // Correct flow.
  await page.getByLabel("Reveal the meaning").click();
  await expect(page.getByLabel("Correct -- I recalled this correctly")).toBeVisible();
  await page.getByLabel("Correct -- I recalled this correctly").click();
  await expect(page.getByLabel("Reveal the meaning")).toBeVisible();

  const { data: answeredClaim } = await admin.from("selection_claims").select("status").eq("id", claimBefore!.id).maybeSingle();
  expect(answeredClaim?.status).toBe("ANSWERED");

  // engine remains v1 after navigating within the Session.
  const { data: sessionAfterCorrect } = await admin.from("sessions").select("engine_version").eq("id", sessionId).maybeSingle();
  expect(sessionAfterCorrect?.engine_version).toBe("v1");

  // Navigate away (Exit link) and back -- NOT an abandonment; the
  // session remains active and resumable (RC-D section 17).
  await page.getByRole("link", { name: /exit/i }).click();
  await expectPath(page, "/");
  await page.goto("/session");
  await expectPath(page, "/session");
  const { data: sessionAfterNav } = await admin.from("sessions").select("id, status, engine_version").eq("id", sessionId).maybeSingle();
  expect(sessionAfterNav?.status).toBe("active");
  expect(sessionAfterNav?.engine_version).toBe("v1");

  // Wrong flow continues the loop without error.
  await expect(page.getByLabel("Reveal the meaning")).toBeVisible();
  await page.getByLabel("Reveal the meaning").click();
  await expect(page.getByLabel("Wrong -- I did not recall this correctly")).toBeVisible();
  await page.getByLabel("Wrong -- I did not recall this correctly").click();
  await expect(page.getByLabel("Reveal the meaning")).toBeVisible();

  // No scheduler/source/policy internals ever leaked into the DOM.
  const bodyText = await page.textContent("body");
  expect(bodyText).not.toMatch(/scheduler|selectionTrace|policyVersion|ACTIVE_POOL|repairObligation/i);

  expect(consoleErrors).toEqual([]);
});
