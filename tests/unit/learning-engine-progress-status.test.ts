import { describe, expect, it } from "vitest";

import { toUserFacingCardStatus, type UserFacingCardStatus } from "@/lib/learning-engine/progress/status";
import type { CardStatus } from "@/lib/learning-engine/state";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 4
 * ("User-facing status mapping"), Phase 9.
 */

describe("toUserFacingCardStatus (section 4)", () => {
  it("1. NEW -> NEW", () => {
    expect(toUserFacingCardStatus("NEW")).toBe("NEW");
  });

  it("2. LEARNING -> LEARNING", () => {
    expect(toUserFacingCardStatus("LEARNING")).toBe("LEARNING");
  });

  it("3. ACQUIRED -> LEARNED", () => {
    expect(toUserFacingCardStatus("ACQUIRED")).toBe("LEARNED");
  });

  it("4. LEARNED -> MASTERED", () => {
    expect(toUserFacingCardStatus("LEARNED")).toBe("MASTERED");
  });

  it("5. FORGOTTEN -> RELEARNING", () => {
    expect(toUserFacingCardStatus("FORGOTTEN")).toBe("RELEARNING");
  });

  it("never returns the literal backend name 'ACQUIRED'", () => {
    const allBackendStatuses: CardStatus[] = ["NEW", "LEARNING", "ACQUIRED", "LEARNED", "FORGOTTEN"];
    const results = allBackendStatuses.map(toUserFacingCardStatus);
    expect(results).not.toContain("ACQUIRED" as unknown as UserFacingCardStatus);
  });

  it("never returns the literal backend name 'FORGOTTEN'", () => {
    const allBackendStatuses: CardStatus[] = ["NEW", "LEARNING", "ACQUIRED", "LEARNED", "FORGOTTEN"];
    const results = allBackendStatuses.map(toUserFacingCardStatus);
    expect(results).not.toContain("FORGOTTEN" as unknown as UserFacingCardStatus);
  });
});
