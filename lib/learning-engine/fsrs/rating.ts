/**
 * Learning Engine v1 -- binary FSRS rating mapping (Phase 5 of the
 * implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 1.4
 * ("Binary learner input"):
 *
 *   WRONG   -> Again
 *   CORRECT -> Good
 *
 * "The UX must not require Again/Hard/Good/Easy self-rating after every
 * card" and "Raw behavior must still be logged for future inference of
 * latent retrieval quality" -- i.e. response time and other behavioral
 * signals remain legitimate telemetry (answer_events.response_time_ms and
 * friends are untouched by this phase), but they must NEVER influence
 * what gets sent to FSRS in v1. This module is the single, deliberately
 * trivial place that decision is made for the v1 engine.
 *
 * ---------------------------------------------------------------------
 * Relationship to lib/learning/rating.ts (the LEGACY MVP estimator)
 * ---------------------------------------------------------------------
 * lib/learning/rating.ts infers Hard/Easy from response time and recent-
 * answer history, and IS currently wired into the legacy runtime's
 * submitAnswer() -> commit_answer_transaction() path. That inference
 * directly conflicts with this spec's section 1.4. Per the Phase 5 brief
 * ("do not wire the full unified scheduler yet... the existing
 * production/local app must remain runnable... do not partially switch
 * the app into a mixed-engine state"), this phase does NOT modify or
 * remove lib/learning/rating.ts or its legacy call sites -- doing so
 * would change live runtime behavior before Phase 6's cutover design
 * exists, which is explicitly out of scope here and would risk exactly
 * the mixed-engine state that brief warns against.
 *
 * Instead, this module is the explicit, unambiguous v1 replacement:
 * every v1-engine FSRS call site (lib/learning-engine/fsrs/lifecycle.ts)
 * uses ONLY mapAnswerToFsrsGrade, never lib/learning/rating.ts's
 * estimateRating. This is not a silent conflict -- it is the documented
 * resolution the brief asked for ("do not preserve a conflicting legacy
 * behavior silently"): the legacy estimator keeps running for the legacy
 * engine it was built for, and the v1 engine simply never calls it.
 */

import { Rating } from "ts-fsrs";
import type { Grade } from "ts-fsrs";

/**
 * The v1-authoritative mapping (section 1.4). Deliberately ignores
 * everything except `correct` -- no response time, no history, no
 * seen-count. A conforming caller passes response time and any other
 * behavioral signal to telemetry logging separately; it must never reach
 * this function's decision.
 */
export function mapAnswerToFsrsGrade(correct: boolean): Grade {
  return correct ? Rating.Good : Rating.Again;
}
