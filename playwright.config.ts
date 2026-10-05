import { defineConfig, devices } from "@playwright/test";
import { loadE2eEnv } from "./tests/e2e/env";

// Throws immediately (before any webServer or test starts) if
// tests/e2e/.env.local isn't pointed at localhost/127.0.0.1 -- see
// assertLocalSupabaseUrl() in tests/e2e/env.ts.
const e2eEnv = loadE2eEnv();

const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e/specs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  globalSetup: require.resolve("./tests/e2e/global-setup"),
  globalTeardown: require.resolve("./tests/e2e/global-teardown"),
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm exec next dev --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    // Only the app-facing public values are ever passed to the Next.js
    // process -- e2eEnv.supabaseServiceRoleKey is never included here, so
    // it never reaches app runtime env, let alone app code. These two
    // explicit env vars also take precedence over anything .env.local
    // (which points at the linked remote project) would otherwise supply.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: e2eEnv.supabaseUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: e2eEnv.supabaseAnonKey,
    },
  },
});
