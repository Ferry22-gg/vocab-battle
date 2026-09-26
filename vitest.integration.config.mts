import path from "node:path";
import { defineConfig } from "vitest/config";

// Separate from vitest.config.mts (the unit suite) deliberately: this
// config requires a running local Supabase stack (`pnpm exec supabase
// start`) and performs real network calls, so it must never run as part
// of the fast `pnpm run test:unit` loop. See tests/integration/env.ts for
// the local-only safety gate every test here goes through.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["node_modules/**"],
    setupFiles: ["tests/integration/vitest-setup.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    // Scenarios share a small set of deterministic tester identities and
    // mutate real session/progress state sequentially on purpose (Phase E
    // scenario 9's concurrency case aside, which uses Promise.all *within*
    // one test) -- running test files in parallel workers would race
    // fixture setup/teardown against each other.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
});
