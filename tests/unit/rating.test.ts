import { describe, expect, it } from "vitest";
import { Rating } from "ts-fsrs";

import { RATING_CONFIG } from "@/lib/learning/config";
import { estimateRating, type RatingEstimatorInput } from "@/lib/learning/rating";

/** All-correct history of the given length, oldest facts omitted -- convenience for Easy-gate fixtures. */
const stableHistory = (length: number): readonly boolean[] =>
  Array.from({ length }, () => true);

interface Case {
  readonly name: string;
  readonly input: RatingEstimatorInput;
  readonly expected: Rating;
}

const cases: readonly Case[] = [
  // 1. Wrong always -> Again, regardless of response time.
  {
    name: "wrong at fast response time -> Again",
    input: {
      correct: false,
      responseTimeMs: 500,
      seenCount: 10,
      recentAnswerHistory: stableHistory(3),
    },
    expected: Rating.Again,
  },
  {
    name: "wrong at normal response time -> Again",
    input: {
      correct: false,
      responseTimeMs: 5000,
      seenCount: 10,
      recentAnswerHistory: stableHistory(3),
    },
    expected: Rating.Again,
  },
  {
    name: "wrong at slow response time -> Again",
    input: {
      correct: false,
      responseTimeMs: 20000,
      seenCount: 10,
      recentAnswerHistory: [],
    },
    expected: Rating.Again,
  },

  // 2-3. Hard threshold boundary.
  {
    name: "correct at exactly HARD_RESPONSE_THRESHOLD_MS -> Hard",
    input: {
      correct: true,
      responseTimeMs: RATING_CONFIG.HARD_RESPONSE_THRESHOLD_MS,
      seenCount: 10,
      recentAnswerHistory: stableHistory(3),
    },
    expected: Rating.Hard,
  },
  {
    name: "correct above HARD_RESPONSE_THRESHOLD_MS -> Hard",
    input: {
      correct: true,
      responseTimeMs: RATING_CONFIG.HARD_RESPONSE_THRESHOLD_MS + 1000,
      seenCount: 10,
      recentAnswerHistory: stableHistory(3),
    },
    expected: Rating.Hard,
  },

  // 4-5. Easy threshold boundary, all gates passing.
  {
    name: "correct at exactly EASY_RESPONSE_THRESHOLD_MS with all gates passing -> Easy",
    input: {
      correct: true,
      responseTimeMs: RATING_CONFIG.EASY_RESPONSE_THRESHOLD_MS,
      seenCount: RATING_CONFIG.EASY_MIN_SEEN_COUNT,
      recentAnswerHistory: stableHistory(RATING_CONFIG.EASY_STABLE_HISTORY_LENGTH),
    },
    expected: Rating.Easy,
  },
  {
    name: "correct below EASY_RESPONSE_THRESHOLD_MS with all gates passing -> Easy",
    input: {
      correct: true,
      responseTimeMs: RATING_CONFIG.EASY_RESPONSE_THRESHOLD_MS - 1000,
      seenCount: RATING_CONFIG.EASY_MIN_SEEN_COUNT + 1,
      recentAnswerHistory: stableHistory(RATING_CONFIG.EASY_STABLE_HISTORY_LENGTH),
    },
    expected: Rating.Easy,
  },

  // 6. Fast but seen_count gate fails.
  {
    name: "fast but seenCount below EASY_MIN_SEEN_COUNT -> Good",
    input: {
      correct: true,
      responseTimeMs: RATING_CONFIG.EASY_RESPONSE_THRESHOLD_MS,
      seenCount: RATING_CONFIG.EASY_MIN_SEEN_COUNT - 1,
      recentAnswerHistory: stableHistory(RATING_CONFIG.EASY_STABLE_HISTORY_LENGTH),
    },
    expected: Rating.Good,
  },

  // 7. Fast but stability gate fails (an older-than-previous entry was Wrong).
  {
    name: "fast but recent history not stable -> Good",
    input: {
      correct: true,
      responseTimeMs: RATING_CONFIG.EASY_RESPONSE_THRESHOLD_MS,
      seenCount: RATING_CONFIG.EASY_MIN_SEEN_COUNT,
      recentAnswerHistory: [true, false, true],
    },
    expected: Rating.Good,
  },

  // 8. Fast but the immediately previous answer was Wrong.
  {
    name: "fast but previous answer was Wrong -> Good",
    input: {
      correct: true,
      responseTimeMs: RATING_CONFIG.EASY_RESPONSE_THRESHOLD_MS,
      seenCount: RATING_CONFIG.EASY_MIN_SEEN_COUNT,
      recentAnswerHistory: [false, true, true],
    },
    expected: Rating.Good,
  },

  // 9. Normal-speed correct answer (neither Hard nor Easy threshold hit).
  {
    name: "normal-speed correct answer -> Good",
    input: {
      correct: true,
      responseTimeMs: 5000,
      seenCount: RATING_CONFIG.EASY_MIN_SEEN_COUNT + 5,
      recentAnswerHistory: stableHistory(RATING_CONFIG.EASY_STABLE_HISTORY_LENGTH),
    },
    expected: Rating.Good,
  },

  // 10. History shorter than the stability window is never stable.
  {
    name: "fast but history shorter than EASY_STABLE_HISTORY_LENGTH -> Good",
    input: {
      correct: true,
      responseTimeMs: RATING_CONFIG.EASY_RESPONSE_THRESHOLD_MS,
      seenCount: RATING_CONFIG.EASY_MIN_SEEN_COUNT,
      recentAnswerHistory: stableHistory(RATING_CONFIG.EASY_STABLE_HISTORY_LENGTH - 1),
    },
    expected: Rating.Good,
  },
  {
    name: "fast but no history at all (first exposure) -> Good",
    input: {
      correct: true,
      responseTimeMs: RATING_CONFIG.EASY_RESPONSE_THRESHOLD_MS,
      seenCount: RATING_CONFIG.EASY_MIN_SEEN_COUNT,
      recentAnswerHistory: [],
    },
    expected: Rating.Good,
  },
];

describe("estimateRating", () => {
  it.each(cases.map((c) => [c.name, c.input, c.expected] as const))(
    "%s",
    (_name, input, expected) => {
      expect(estimateRating(input)).toBe(expected);
    },
  );

  it("never returns Manual, across every fixture", () => {
    for (const { input } of cases) {
      expect(estimateRating(input)).not.toBe(Rating.Manual);
    }
  });

  it("does not mutate its input", () => {
    const history = [true, true, true];
    const input: RatingEstimatorInput = {
      correct: true,
      responseTimeMs: RATING_CONFIG.EASY_RESPONSE_THRESHOLD_MS,
      seenCount: RATING_CONFIG.EASY_MIN_SEEN_COUNT,
      recentAnswerHistory: history,
    };
    const frozen = structuredClone(input);

    estimateRating(input);

    expect(input).toEqual(frozen);
    expect(history).toEqual([true, true, true]);
  });
});
