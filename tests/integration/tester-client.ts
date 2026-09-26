/**
 * A real, per-tester authenticated Supabase client for the integration
 * suite's read side: signs in with the anon/publishable key via
 * `signInWithPassword`, exactly the credential class a real browser
 * session uses (docs/DATABASE_SCHEMA.md 6.2's synthetic-email mapping).
 * The resulting client carries a genuine JWT, so Postgres RLS evaluates
 * `auth.uid()` for it identically to a real cookie-based session --
 * nothing about RLS enforcement is mocked or weakened by using
 * `signInWithPassword` instead of a browser's cookie flow; it's simply
 * the Node-compatible way to obtain the same kind of credential outside
 * an HTTP request (lib/supabase/server.ts's `createClient()` requires
 * next/headers' `cookies()`, which only works inside a Next.js request
 * context and cannot run in a plain Vitest process).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertLocalSupabaseUrl, loadIntegrationEnv } from "./env";

export async function createTesterClient(email: string, password: string): Promise<SupabaseClient> {
  const env = loadIntegrationEnv();
  assertLocalSupabaseUrl(env.supabaseUrl);

  const client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(`createTesterClient: failed to sign in as ${email}`, { cause: error });
  }

  return client;
}
