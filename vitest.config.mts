import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Scoped to a dedicated directory (and .test.ts, not .spec.ts) so this
    // never picks up tests/e2e/specs/**/*.spec.ts -- those are Playwright
    // tests and fail under Vitest's runner (and vice versa).
    include: ["tests/unit/**/*.test.ts"],
    exclude: ["node_modules/**", "tests/e2e/**"],
    // No unit tests exist yet (Phase A is infra-only) -- this keeps the
    // script from failing before Phase C adds the first pure-module tests.
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
});
