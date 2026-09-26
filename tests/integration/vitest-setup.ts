/**
 * Global setup applied to every Phase E integration test file
 * (vitest.integration.config.mts's `setupFiles`).
 *
 * 1. `server-only` shim: lib/learning/submit-answer.ts,
 *    lib/learning/commit-answer.ts, and lib/supabase/service-role*.ts all
 *    start with `import "server-only"`, which throws outside Next.js's
 *    "react-server" build condition. Same test-environment-only shim used
 *    throughout the unit suite (tests/unit/service-role.test.ts) -- does
 *    not touch any guarded module's real source.
 *
 * 2. Swaps `@/lib/supabase/server`'s `createClient()` (which normally
 *    requires next/headers' cookies(), unavailable in a plain Vitest
 *    process) for one that returns whatever real, per-tester authenticated
 *    client the current test registered via rls-client-context.ts. This
 *    is the ONLY substitution made: the production DAL functions
 *    (getActiveSessionById, getCardProgress, getRecentAnswerHistory,
 *    getAnswerEventByClientEventId, getXpEventsForAnswerEvent) run
 *    completely unmodified, issuing the exact same queries against the
 *    exact same local Postgres, with RLS fully enforced for a genuine JWT
 *    -- nothing about authorization is weakened or mocked.
 *
 * 3. Points the real getServiceRoleClient() (lib/supabase/service-role.ts)
 *    at the local stack by setting the same env vars it reads in
 *    production (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
 *    ALLOW_REMOTE_SUPABASE_SERVICE_ROLE is explicitly left unset --
 *    lib/supabase/service-role-guard.ts's local-hostname check is what
 *    actually allows this to proceed, the same guard production relies on,
 *    not an override.
 */

import { vi } from "vitest";
import { loadIntegrationEnv } from "./env";
import { getRlsClient } from "./rls-client-context";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => getRlsClient(),
}));

const env = loadIntegrationEnv();
process.env.NEXT_PUBLIC_SUPABASE_URL = env.supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY = env.supabaseServiceRoleKey;
delete process.env.ALLOW_REMOTE_SUPABASE_SERVICE_ROLE;
