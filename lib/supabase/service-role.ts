import "server-only";

/**
 * The privileged, RLS-bypassing Supabase client (docs/DATABASE_SCHEMA.md
 * section 10.3: `commit_answer_transaction()` is `service_role`-only).
 * This module only builds the client -- it does not call any RPC. A later
 * phase's trusted application-layer code (e.g. the future submitAnswer())
 * is the only intended caller of getServiceRoleClient().
 *
 * `import "server-only"` makes any accidental import of this module from
 * client-reachable code a build-time error, not just a convention (same
 * pattern as lib/supabase/service-role-guard.ts).
 *
 * Deliberately does NOT use @supabase/ssr or cookies -- this client has no
 * per-request user session to carry: it is a single stateless backend
 * credential, constructed directly with @supabase/supabase-js.
 */

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import { assertLocalSupabaseServiceRoleAllowed } from "@/lib/supabase/service-role-guard";

function requireServerEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `getServiceRoleClient: missing required environment variable "${name}". ` +
        "Set it in .env.local (see .env.example) before using the service-role client.",
    );
  }
  return value;
}

/**
 * Builds the service-role Supabase client for one caller. Fails loudly
 * (throws, never logs the key's value) if NEXT_PUBLIC_SUPABASE_URL or
 * SUPABASE_SERVICE_ROLE_KEY is missing, and defers to
 * assertLocalSupabaseServiceRoleAllowed -- which remains the sole
 * authority on whether the resolved URL may be used -- before ever
 * constructing a client against it.
 *
 * Constructs a fresh client on every call rather than caching a module-level
 * singleton: @supabase/supabase-js client construction does no network I/O,
 * so this costs nothing, and it avoids introducing any global mutable
 * state for this privileged credential to live in.
 *
 * The returned client is configured as a stateless backend client -- no
 * session persistence, no auto token refresh, no URL-based session
 * detection, since a service-role key already carries full privileges
 * without a user session and this client is never used in a browser
 * context where any of those would apply.
 */
export function getServiceRoleClient(): SupabaseClient {
  const url = requireServerEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requireServerEnv("SUPABASE_SERVICE_ROLE_KEY");

  assertLocalSupabaseServiceRoleAllowed(url);

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
