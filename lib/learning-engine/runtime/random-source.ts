/**
 * Learning Engine v1 -- Runtime Cutover RC-B: the production
 * `RandomSource` for `chooseNextCard()`.
 *
 * Every other `RandomSource` in this codebase (lib/learning/battle.ts,
 * lib/learning-engine/scheduler/weighted-random.ts) uses the identical
 * contract -- "called with no arguments, returns a number in [0, 1)" --
 * and this project's own established production convention is to pass
 * `Math.random` directly (battle.ts's own doc comment: "production code
 * should pass `Math.random` directly"). This module does not invent a
 * different source for the Learning Engine; it only gives the runtime
 * orchestrator (lib/learning-engine/runtime/claim-next-card.ts) one named,
 * documented adapter to import instead of writing `Math.random` inline at
 * the call site, consistent with "chooseNextCard must continue to receive
 * an injected RandomSource... a small trusted server-runtime RandomSource
 * adapter."
 */

import type { RandomSource } from "@/lib/learning-engine/scheduler/next-card";

export const productionRandomSource: RandomSource = Math.random;
