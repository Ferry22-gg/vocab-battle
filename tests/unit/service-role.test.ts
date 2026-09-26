import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * lib/supabase/service-role.ts (and lib/supabase/service-role-guard.ts,
 * which it calls) both start with `import "server-only"`. That package
 * throws unconditionally unless resolved under Next.js's own
 * "react-server" build condition -- which plain `vitest run` does not
 * set up, so an unmocked `import("server-only")` throws immediately, before
 * any of this file's own test logic runs (verified directly: a throwaway
 * probe import of "server-only" under this project's vitest config threw
 * "This module cannot be imported from a Client Component module...").
 *
 * This mock is a TEST-ENVIRONMENT-ONLY shim: it replaces vitest's
 * resolution of the "server-only" package for this test file so the
 * guarded modules can be imported and exercised at all. It does NOT touch
 * either guarded module's own source -- `import "server-only"` stays
 * exactly as written in both files, so the real boundary (a build-time
 * error for any accidental client-bundle import in the actual Next.js
 * build) is completely unweakened. Only this test file's module graph is
 * affected.
 */
vi.mock("server-only", () => ({}));

/**
 * Spies on the real @supabase/supabase-js createClient (wrapping, not
 * replacing, its actual implementation) so a test below can assert on the
 * exact auth options this module passes, without any network call.
 */
vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return { ...actual, createClient: vi.fn(actual.createClient) };
});

const supabaseJs = await import("@supabase/supabase-js");
const { getServiceRoleClient } = await import("@/lib/supabase/service-role");

const LOCAL_URL = "http://localhost:54321";
const REMOTE_URL = "https://example-project.supabase.co";
const FAKE_SERVICE_ROLE_KEY = "unit-test-synthetic-service-role-key";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getServiceRoleClient", () => {
  it("throws when NEXT_PUBLIC_SUPABASE_URL is missing", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", FAKE_SERVICE_ROLE_KEY);

    expect(() => getServiceRoleClient()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("throws when SUPABASE_SERVICE_ROLE_KEY is missing", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", LOCAL_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

    expect(() => getServiceRoleClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("never includes the service-role key's value in a thrown error message", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", FAKE_SERVICE_ROLE_KEY);

    try {
      getServiceRoleClient();
      expect.unreachable("expected getServiceRoleClient to throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(FAKE_SERVICE_ROLE_KEY);
    }
  });

  it("constructs successfully for a local Supabase URL", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", LOCAL_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", FAKE_SERVICE_ROLE_KEY);
    vi.stubEnv("ALLOW_REMOTE_SUPABASE_SERVICE_ROLE", "");

    const client = getServiceRoleClient();

    expect(typeof client.rpc).toBe("function");
    expect(typeof client.from).toBe("function");
  });

  it("throws for a remote URL without ALLOW_REMOTE_SUPABASE_SERVICE_ROLE", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", REMOTE_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", FAKE_SERVICE_ROLE_KEY);
    vi.stubEnv("ALLOW_REMOTE_SUPABASE_SERVICE_ROLE", "");

    expect(() => getServiceRoleClient()).toThrow(/localhost/);
  });

  it("constructs successfully for a remote URL when explicitly overridden", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", REMOTE_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", FAKE_SERVICE_ROLE_KEY);
    vi.stubEnv("ALLOW_REMOTE_SUPABASE_SERVICE_ROLE", "true");

    expect(() => getServiceRoleClient()).not.toThrow();
  });

  it("passes the exact URL/key and disables session persistence, auto-refresh, and URL session detection", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", LOCAL_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", FAKE_SERVICE_ROLE_KEY);
    vi.stubEnv("ALLOW_REMOTE_SUPABASE_SERVICE_ROLE", "");

    getServiceRoleClient();

    expect(vi.mocked(supabaseJs.createClient)).toHaveBeenCalledWith(LOCAL_URL, FAKE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  });

  it("constructs a fresh client on every call rather than caching a singleton", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", LOCAL_URL);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", FAKE_SERVICE_ROLE_KEY);
    vi.stubEnv("ALLOW_REMOTE_SUPABASE_SERVICE_ROLE", "");

    const first = getServiceRoleClient();
    const second = getServiceRoleClient();

    expect(first).not.toBe(second);
  });
});
