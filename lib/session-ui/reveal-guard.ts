/**
 * Pure state machine for the Session card's Reveal -> grade lifecycle,
 * including the accidental-double-tap protection (P2 spec, "Accidental
 * double-tap protection"). Reveal and grading share one physical bottom
 * interaction zone, so this exists to guarantee two things:
 *
 *  1. A rapid/duplicate Reveal activation is ignored, never re-entrant.
 *  2. Grading is impossible until the flip has actually finished, and a
 *     submitted grade can't be submitted twice before the next card
 *     resets the machine.
 *
 * A single linear chain, deliberately as small as possible:
 *
 *   idle --REVEAL--> revealing --FLIP_DONE--> ready --GRADE_SUBMIT--> grading --GRADE_RESULT--> ready | locked --RESET--> idle
 *
 * Earlier revisions of this module also tracked "has the pointer that
 * triggered Reveal been released" as a second, separate precondition
 * alongside FLIP_DONE, driven by a real DOM pointerup/pointercancel
 * listener. That existed to guard against a pointerdown-triggered Reveal
 * whose still-held finger could slide onto the newly-swapped grade button
 * before lifting. In production use it caused a real, user-reported bug:
 * Reveal is now click-triggered (action-zone.tsx), which by definition
 * only fires once the activating gesture has already fully completed
 * (press AND release) -- so there is no longer a "still-held pointer" to
 * separately wait for, and carrying that extra condition only added a
 * second, independently-satisfiable precondition whose bookkeeping (a
 * window-level listener armed per-pointerId, torn down on its own event)
 * was the actual source of the stuck-Reveal bug: rapid-fire activity could
 * land a *new* Reveal so soon after the previous card's reset that the
 * card's CSS flip-back-to-front transition and the new flip-to-back
 * transition got coalesced by the browser into a no-op (identical start
 * and end transform value), so no `transitionend` -- and therefore no
 * FLIP_DONE -- ever fired for it, permanently stranding the phase at
 * "revealing". (See app/session/flash-card.tsx's header for the matching
 * fix on that side: FLIP_DONE is now driven by a plain timer, not a CSS
 * transition event, which sidesteps that same class of browser timing
 * hazard entirely.) Removing the second precondition here removes an
 * entire class of "stuck forever" states without weakening the actual
 * protection: a genuinely fast repeat tap still can't grade early, because
 * FLIP_DONE-gated "ready" is unreachable until the flip's fixed duration
 * has elapsed, exactly as before.
 */

export type RevealGuardPhase =
  | "idle" // pre-reveal: Reveal is tappable, grading is not.
  | "revealing" // Reveal was activated: the flip is still playing. Grading is blocked, and a repeat Reveal activation is ignored.
  | "ready" // the flip has finished: grading is now allowed.
  | "grading" // a grade was submitted and a result is pending: grading is blocked (duplicate-submission protection).
  | "locked"; // a grade was successfully committed: grading stays blocked until the next card resets the machine.

export interface RevealGuardState {
  readonly phase: RevealGuardPhase;
}

export type RevealGuardEvent =
  | { readonly type: "REVEAL" }
  | { readonly type: "FLIP_DONE" }
  | { readonly type: "GRADE_SUBMIT" }
  /** retry=true: the attempt is safe to re-grade as-is (e.g. a retryable submit error) -- back to "ready". retry=false: the grade committed (or requires a fresh card) -- "locked" until RESET. */
  | { readonly type: "GRADE_RESULT"; readonly retry: boolean }
  | { readonly type: "RESET" };

export const initialRevealGuardState: RevealGuardState = { phase: "idle" };

export function revealGuardReducer(
  state: RevealGuardState,
  event: RevealGuardEvent,
): RevealGuardState {
  switch (event.type) {
    case "REVEAL":
      return state.phase === "idle" ? { phase: "revealing" } : state;

    case "FLIP_DONE":
      return state.phase === "revealing" ? { phase: "ready" } : state;

    case "GRADE_SUBMIT":
      return state.phase === "ready" ? { phase: "grading" } : state;

    case "GRADE_RESULT":
      return state.phase === "grading" ? { phase: event.retry ? "ready" : "locked" } : state;

    case "RESET":
      return initialRevealGuardState;

    default:
      return state;
  }
}

export function canReveal(state: RevealGuardState): boolean {
  return state.phase === "idle";
}

export function canGrade(state: RevealGuardState): boolean {
  return state.phase === "ready";
}
