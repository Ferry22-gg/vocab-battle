/**
 * Test-only environment loading for the Phase E Learning Engine
 * integration suite. Node/Vitest-side only -- never imported from app/*,
 * lib/auth/*, or lib/supabase/*, and nothing here (or
 * tests/integration/.env.local, which it loads) ever reaches the Next.js
 * app's module graph or runtime env.
 *
 * Deliberately separate from tests/e2e/env.ts rather than shared: this
 * suite has no dependency on Playwright/global-setup timing, and keeping
 * the two decoupled means a change to one suite's env handling can't
 * silently affect the other's local-only guarantee.
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
      `${name} is not set. Copy tests/integration/.env.local from \`pnpm exec supabase status -o env\` ` +
        `(SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY) before running the integration suite.`,
    );
  }
  return value;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * The one safety gate every integration fixture/read/write path must pass
 * through before touching the database: refuses to run against anything
 * that isn't unambiguously the local Supabase stack. A strict hostname
 * allowlist, not a denylist of "looks remote" patterns -- a denylist can
 * miss a URL shape it wasn't written for, an allowlist can't. There is
 * deliberately no override/escape hatch here at all (unlike
 * lib/supabase/service-role-guard.ts's ALLOW_REMOTE_SUPABASE_SERVICE_ROLE,
 * which exists for a deliberate one-off production operation) -- an
 * automated integration test suite must never have a path to touching a
 * remote project, under any environment variable.
 */
export function assertLocalSupabaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Integration tests refused to run: "${url}" is not a valid URL.`);
  }

  if (!LOCAL_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(
      `Integration tests refused to run against "${url}" -- hostname "${parsed.hostname}" ` +
        `is not localhost/127.0.0.1/::1. This suite must only ever touch the local Supabase ` +
        `stack, never a linked/remote project, and has no override for this. Run ` +
        `\`pnpm exec supabase start\` and point tests/integration/.env.local at its local API_URL.`,
    );
  }
}

export interface IntegrationEnv {
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  readonly supabaseServiceRoleKey: string;
}

export function loadIntegrationEnv(): IntegrationEnv {
  const supabaseUrl = requireEnv("SUPABASE_URL");

  // Enforced here too, not just inside each client constructor: any code
  // path that reads this env is guarded, not only the one that happens to
  // hold the service-role key.
  assertLocalSupabaseUrl(supabaseUrl);

  return {
    supabaseUrl,
    supabaseAnonKey: requireEnv("SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  };
}
