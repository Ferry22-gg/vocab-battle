import { describe, expect, it } from "vitest";

import { toSessionCardUiState, classifySubmitAnswerError } from "@/lib/session-ui/session-card-state";
import type { NextSessionCard } from "@/lib/sessions/dal";
import type { SubmitAnswerErrorCode } from "@/lib/learning/submit-answer";

describe("toSessionCardUiState", () => {
  it('maps status "ok" to kind "card" with the expected fields', () => {
    const result: NextSessionCard = {
      status: "ok",
      sessionId: "session-1",
      sessionMode: "learning",
      cardId: "card-1",
      front: "ubiquitous",
      back: "遍在する",
      enemyType: "enemy_b",
      enemyHp: 50,
      enemyMaxHp: 110,
      combo: 3,
    };

    expect(toSessionCardUiState(result)).toEqual({
      kind: "card",
      card: {
        sessionId: "session-1",
        sessionMode: "learning",
        cardId: "card-1",
        front: "ubiquitous",
        back: "遍在する",
        enemyType: "enemy_b",
        enemyHp: 50,
        enemyMaxHp: 110,
        combo: 3,
      },
    });
  });

  it.each<NextSessionCard["status"]>(["not_found", "error"])(
    'maps status "%s" to kind "unavailable" (never leaks the internal reason)',
    (status) => {
      const result =
        status === "not_found"
          ? ({ status: "not_found" } as NextSessionCard)
          : ({ status: "error", reason: "SESSION_MISSING_BATTLE_STATE" } as NextSessionCard);

      expect(toSessionCardUiState(result)).toEqual({ kind: "unavailable" });
    },
  );

  it('maps status "no_card" to kind "no_card" regardless of reason', () => {
    const result: NextSessionCard = { status: "no_card", reason: "LEARNING_ALL_ON_COOLDOWN" };
    expect(toSessionCardUiState(result)).toEqual({ kind: "no_card" });
  });
});

describe("classifySubmitAnswerError", () => {
  it("marks STALE_STATE and NOT_FOUND_OR_INACCESSIBLE as requiring a fresh card", () => {
    expect(classifySubmitAnswerError("STALE_STATE").requiresFreshCard).toBe(true);
    expect(classifySubmitAnswerError("NOT_FOUND_OR_INACCESSIBLE").requiresFreshCard).toBe(true);
  });

  it("marks INVALID_INPUT and COMMIT_FAILED as safe to retry without refetching", () => {
    expect(classifySubmitAnswerError("INVALID_INPUT").requiresFreshCard).toBe(false);
    expect(classifySubmitAnswerError("COMMIT_FAILED").requiresFreshCard).toBe(false);
  });

  it("returns a non-empty, generic message for every known error code", () => {
    const codes: SubmitAnswerErrorCode[] = [
      "STALE_STATE",
      "NOT_FOUND_OR_INACCESSIBLE",
      "INVALID_INPUT",
      "COMMIT_FAILED",
    ];
    for (const code of codes) {
      const view = classifySubmitAnswerError(code);
      expect(view.message.length).toBeGreaterThan(0);
      // Never leaks the raw code itself into the user-facing message.
      expect(view.message).not.toContain(code);
    }
  });
});
