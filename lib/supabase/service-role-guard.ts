import "server-only";

/**
 * Guard-only module: decides whether the service-role Supabase client (added
 * in a later phase, see docs/DATABASE_SCHEMA.md section 10.3) is allowed to
 * initialize against a given Supabase URL. Deliberately contains no client
 * construction -- commit_answer_transaction() is service_role-only, and that
 * key must never execute against a remote project from an ordinary local
 * `pnpm dev` run before the local-dev environment is confirmed safe.
 *
 * `import "server-only"` makes any accidental import of this module from
 * client-reachable code a build-time error, not just a convention.
 *
 * Same allowlist pattern (not a denylist) as tests/e2e/env.ts's
 * assertLocalSupabaseUrl(), applied here to app-runtime env instead of the
 * E2E harness.
 */

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Throws unless `url` is a local Supabase host, or the caller has opted in
 * via ALLOW_REMOTE_SUPABASE_SERVICE_ROLE=true (server-only env var --
 * NEXT_PUBLIC_ vars are inlined into the browser bundle at build time, so
 * this override must never carry that prefix).
 */
export function assertLocalSupabaseServiceRoleAllowed(url: string): void {
  if (process.env.ALLOW_REMOTE_SUPABASE_SERVICE_ROLE === "true") {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `Refusing to initialize the service-role Supabase client: "${url}" is not a valid URL.`
    );
  }

  if (!LOCAL_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(
      `Refusing to initialize the service-role Supabase client against "${url}" -- ` +
        `hostname "${parsed.hostname}" is not localhost/127.0.0.1/::1. Ordinary local ` +
        `development must run against local Supabase. Set ` +
        `ALLOW_REMOTE_SUPABASE_SERVICE_ROLE=true (server-only env, never NEXT_PUBLIC_) ` +
        `to explicitly opt in for a deliberate remote operation.`
    );
  }
}
