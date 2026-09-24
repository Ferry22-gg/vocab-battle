/**
 * Service-role Supabase client for E2E fixture setup/cleanup only. Never
 * imported by app/*, lib/auth/*, or lib/supabase/* -- those use
 * lib/supabase/{client,server,proxy}.ts with the publishable/anon key,
 * exclusively. This client exists only to do what no app-facing code path
 * is allowed to do: create/delete Auth users directly and write
 * profiles/decks rows that bypass RLS for fixture setup.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertLocalSupabaseUrl, loadE2eEnv } from "./env";

export function createAdminClient(): SupabaseClient {
  const env = loadE2eEnv();

  // Redundant with the check inside loadE2eEnv(), deliberately: this is
  // the exact call site that receives the service-role key, so it gets
  // its own unconditional guard rather than trusting an upstream caller
  // did it first.
  assertLocalSupabaseUrl(env.supabaseUrl);

  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
