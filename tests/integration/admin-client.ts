/**
 * Service-role Supabase client for integration-test fixture setup/
 * cleanup/postcondition inspection ONLY. Never used for the read-side
 * calls `runSubmitAnswer()` itself makes during a scenario under test --
 * those must go through a real per-tester authenticated client
 * (./tester-client.ts) so RLS is genuinely exercised, matching production
 * (docs/DATABASE_SCHEMA.md 7). Mirrors tests/e2e/admin-client.ts's
 * pattern; kept separate per-suite deliberately (see env.ts).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertLocalSupabaseUrl, loadIntegrationEnv } from "./env";

export function createAdminClient(): SupabaseClient {
  const env = loadIntegrationEnv();

  // Redundant with the check inside loadIntegrationEnv(), deliberately:
  // this is the exact call site that receives the service-role key, so it
  // gets its own unconditional guard rather than trusting an upstream
  // caller did it first.
  assertLocalSupabaseUrl(env.supabaseUrl);

  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
