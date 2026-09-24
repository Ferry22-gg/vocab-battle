/**
 * Test-only environment loading for the E2E suite. Node/Playwright-side
 * only -- never imported from app/*, lib/auth/*, or lib/supabase/*, and
 * nothing in this file (or tests/e2e/.env.local, which it loads) ever
 * reaches the Next.js app's module graph or runtime env. Importing this
 * from application code would be a build-time error anyway (this repo has
 * no bundler alias into tests/e2e/), but the boundary is also enforced by
 * convention: only files under tests/e2e/ import from here.
 */

import { existsSync } from "node:fs";
import path from "node:path";

const ENV_FILE = path.resolve(__dirname, ".env.local");

if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy tests/e2e/.env.local from \`pnpm exec supabase status -o env\` ` +
        `(SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY) before running the E2E suite.`
    );
  }
  return value;
}

/**
 * The one safety gate every fixture-provisioning path must pass through
 * before touching the database: refuses to run against anything that
 * isn't unambiguously the local Supabase stack. Deliberately a strict
 * hostname allowlist (localhost / 127.0.0.1 / [::1]), not a denylist of
 * "looks remote" patterns -- a denylist can miss a URL shape it wasn't
 * written for, an allowlist can't.
 */
export function assertLocalSupabaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`E2E fixtures refused to run: "${url}" is not a valid URL.`);
  }

  const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

  if (!LOCAL_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(
      `E2E fixtures refused to run against "${url}" -- hostname "${parsed.hostname}" ` +
        `is not localhost/127.0.0.1. This suite must only ever touch the local Supabase ` +
        `stack, never a linked/remote project. Run \`pnpm exec supabase start\` and point ` +
        `tests/e2e/.env.local at its local API_URL.`
    );
  }
}

export type E2eEnv = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
};

export function loadE2eEnv(): E2eEnv {
  const supabaseUrl = requireEnv("SUPABASE_URL");

  // Enforced here too, not just inside the admin client constructor: any
  // code path that reads this env (including the app-facing webServer env
  // in playwright.config.ts) is guarded, not only the one that happens to
  // hold the service-role key.
  assertLocalSupabaseUrl(supabaseUrl);

  return {
    supabaseUrl,
    supabaseAnonKey: requireEnv("SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  };
}
