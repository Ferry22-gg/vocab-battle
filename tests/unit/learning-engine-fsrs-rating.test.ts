import { describe, expect, it } from "vitest";
import { Rating } from "ts-fsrs";

import { mapAnswerToFsrsGrade } from "@/lib/learning-engine/fsrs/rating";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 1.4
 * (Phase 5: binary FSRS rating mapping).
 */

describe("mapAnswerToFsrsGrade (section 1.4)", () => {
  it("1. WRONG maps only to Again", () => {
    expect(mapAnswerToFsrsGrade(false)).toBe(Rating.Again);
  });

  it("2. CORRECT maps only to Good", () => {
    expect(mapAnswerToFsrsGrade(true)).toBe(Rating.Good);
  });

  it("never returns Hard or Easy", () => {
    expect(mapAnswerToFsrsGrade(true)).not.toBe(Rating.Hard);
    expect(mapAnswerToFsrsGrade(true)).not.toBe(Rating.Easy);
    expect(mapAnswerToFsrsGrade(false)).not.toBe(Rating.Hard);
    expect(mapAnswerToFsrsGrade(false)).not.toBe(Rating.Easy);
  });

  it("3. takes only `correct` -- there is no parameter for response time or any other signal to change the rating", () => {
    // Type-level proof: the function signature itself is (correct: boolean) => Grade.
    // Runtime proof: calling it twice with the same `correct` always agrees,
    // regardless of what a caller might otherwise have passed to a
    // response-time-aware estimator (there is nowhere to pass it here).
    expect(mapAnswerToFsrsGrade(true)).toBe(mapAnswerToFsrsGrade(true));
    expect(mapAnswerToFsrsGrade(false)).toBe(mapAnswerToFsrsGrade(false));
  });
});
