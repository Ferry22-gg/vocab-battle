import { describe, expect, it } from "vitest";

import { resolveDesiredRetention } from "@/lib/learning-engine/fsrs/retention";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 14.3,
 * 27.2 (Phase 5: desired retention resolution).
 */

describe("resolveDesiredRetention (sections 14.3, 27.2)", () => {
  it("4. default desired retention is 0.90", () => {
    expect(resolveDesiredRetention(null)).toBe(0.9);
  });

  it("5. retention_loss desired retention is 0.92", () => {
    expect(resolveDesiredRetention("retention_loss")).toBe(0.92);
  });

  it("6a. null/missing preference falls back safely to 0.90", () => {
    expect(resolveDesiredRetention(null)).toBe(0.9);
  });

  it("6b. every other pain_point value falls back to 0.90 (section 27.2: 'No Learning Engine parameter change' for creation_cost/boredom)", () => {
    expect(resolveDesiredRetention("creation_cost")).toBe(0.9);
    expect(resolveDesiredRetention("boredom")).toBe(0.9);
  });

  it("never throws, regardless of input", () => {
    expect(() => resolveDesiredRetention(null)).not.toThrow();
    expect(() => resolveDesiredRetention("retention_loss")).not.toThrow();
  });
});
