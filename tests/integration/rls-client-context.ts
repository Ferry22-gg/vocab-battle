/**
 * Lets an integration test tell the (mocked) `@/lib/supabase/server`
 * module which real, per-tester authenticated client the production DAL
 * (lib/sessions/dal.ts, lib/learning/progress-dal.ts) should use for its
 * `createClient()` calls during the current scenario. See
 * vitest-setup.ts for where this is wired in, and tester-client.ts for
 * how the client itself is obtained.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

let current: SupabaseClient | null = null;

export function setRlsClient(client: SupabaseClient): void {
  current = client;
}

export function clearRlsClient(): void {
  current = null;
}

export function getRlsClient(): SupabaseClient {
  if (!current) {
    throw new Error(
      "getRlsClient: no tester client set for this integration call -- call setRlsClient() first",
    );
  }
  return current;
}
