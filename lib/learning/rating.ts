/**
 * Internal FSRS rating estimator (docs/MVP_SPEC_FOR_CLAUDE.md section 16).
 *
 * The user only ever taps Correct/Wrong -- this module infers which of
 * ts-fsrs's four ratings (Again/Hard/Good/Easy, never Manual) that answer
 * corresponds to, using response time and a small amount of recent-answer
 * history supplied by the caller.
 *
 * Pure and side-effect free: no FSRS calls, no database access, no battle
 * or card-lifecycle logic, no mutation of its input. The caller is
 * responsible for gathering the history facts this function needs (e.g.
 * from `user_card_progress` / recent `answer_events` rows) and for doing
 * anything with the returned rating (calling ts-fsrs, computing battle
 * damage, updating card status).
 */

import { Rating } from "ts-fsrs";
import type { Grade } from "ts-fsrs";

import { RATING_CONFIG } from "@/lib/learning/config";

export interface RatingEstimatorInput {
  /** Whether the user judged this answer Correct or Wrong. */
  readonly correct: boolean;

  /**
   * Milliseconds from front display to the user tapping "Show Answer"
   * (docs/MVP_SPEC_FOR_CLAUDE.md section 14) -- never reveal/decide time.
   */
  readonly responseTimeMs: number;

  /**
   * The card's seen_count including this current answer (i.e. the
   * post-increment value -- docs/MVP_SPEC_FOR_CLAUDE.md section 18 updates
   * seen/streak state before estimating the rating).
   */
  readonly seenCount: number;

  /**
   * The card's most recent *previously committed* answers, ordered
   * most-recent-first (`recentAnswerHistory[0]` is the immediately
   * preceding answer). Does NOT include the current answer being rated.
   * `true` = that historical answer was Correct, `false` = Wrong. The
   * caller only needs to supply up to
   * `RATING_CONFIG.EASY_STABLE_HISTORY_LENGTH` entries; fewer entries
   * (including none, e.g. a card's first exposure) are valid and simply
   * make Easy ineligible.
   */
  readonly recentAnswerHistory: readonly boolean[];
}

/**
 * Estimates the ts-fsrs rating for one answer.
 *
 * Decision order (first match wins):
 * 1. Wrong -> Again.
 * 2. Correct with responseTimeMs >= HARD_RESPONSE_THRESHOLD_MS -> Hard.
 * 3. Correct with responseTimeMs <= EASY_RESPONSE_THRESHOLD_MS AND all Easy
 *    gates pass -> Easy:
 *    - seenCount >= RATING_CONFIG.EASY_MIN_SEEN_COUNT
 *    - the most recent RATING_CONFIG.EASY_STABLE_HISTORY_LENGTH entries of
 *      recentAnswerHistory all exist and are all Correct (fewer entries
 *      than that length is never stable)
 *    - recentAnswerHistory[0] (the immediately previous answer) was
 *      Correct, not Wrong
 * 4. Everything else -> Good.
 */
export function estimateRating(input: RatingEstimatorInput): Grade {
  const { correct, responseTimeMs, seenCount, recentAnswerHistory } = input;

  if (!correct) {
    return Rating.Again;
  }

  if (responseTimeMs >= RATING_CONFIG.HARD_RESPONSE_THRESHOLD_MS) {
    return Rating.Hard;
  }

  if (responseTimeMs <= RATING_CONFIG.EASY_RESPONSE_THRESHOLD_MS) {
    const meetsSeenCount = seenCount >= RATING_CONFIG.EASY_MIN_SEEN_COUNT;

    const stableHistoryLength = RATING_CONFIG.EASY_STABLE_HISTORY_LENGTH;
    const hasStableHistory =
      recentAnswerHistory.length >= stableHistoryLength &&
      recentAnswerHistory
        .slice(0, stableHistoryLength)
        .every((wasCorrect) => wasCorrect);

    const previousAnswerNotWrong = recentAnswerHistory[0] === true;

    if (meetsSeenCount && hasStableHistory && previousAnswerNotWrong) {
      return Rating.Easy;
    }
  }

  return Rating.Good;
}
