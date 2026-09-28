import { describe, expect, it } from "vitest";

import {
  canGrade,
  canReveal,
  initialRevealGuardState,
  revealGuardReducer,
  type RevealGuardState,
} from "@/lib/session-ui/reveal-guard";

function dispatch(state: RevealGuardState, events: Parameters<typeof revealGuardReducer>[1][]): RevealGuardState {
  return events.reduce(revealGuardReducer, state);
}

describe("revealGuardReducer", () => {
  it("starts pre-reveal: Reveal allowed, grading blocked", () => {
    expect(canReveal(initialRevealGuardState)).toBe(true);
    expect(canGrade(initialRevealGuardState)).toBe(false);
  });

  it("blocks grading while the flip is still in progress", () => {
    const state = dispatch(initialRevealGuardState, [{ type: "REVEAL" }]);
    expect(canReveal(state)).toBe(false);
    expect(canGrade(state)).toBe(false);
  });

  it("allows grading once the flip finishes", () => {
    const state = dispatch(initialRevealGuardState, [{ type: "REVEAL" }, { type: "FLIP_DONE" }]);
    expect(canGrade(state)).toBe(true);
  });

  it("ignores a second REVEAL once revealing has started (no re-entrant flip)", () => {
    const state = dispatch(initialRevealGuardState, [{ type: "REVEAL" }]);
    const again = revealGuardReducer(state, { type: "REVEAL" });
    expect(again).toEqual(state);
  });

  it("ignores FLIP_DONE outside the revealing phase (e.g. a stray/duplicate signal)", () => {
    expect(revealGuardReducer(initialRevealGuardState, { type: "FLIP_DONE" })).toEqual(initialRevealGuardState);
    const ready = dispatch(initialRevealGuardState, [{ type: "REVEAL" }, { type: "FLIP_DONE" }]);
    expect(revealGuardReducer(ready, { type: "FLIP_DONE" })).toEqual(ready);
  });

  it("prevents duplicate submissions: GRADE_SUBMIT blocks further grading until a result arrives", () => {
    const ready = dispatch(initialRevealGuardState, [{ type: "REVEAL" }, { type: "FLIP_DONE" }]);
    const grading = revealGuardReducer(ready, { type: "GRADE_SUBMIT" });
    expect(canGrade(grading)).toBe(false);

    // A rapid second GRADE_SUBMIT while still grading must not re-enter.
    const stillGrading = revealGuardReducer(grading, { type: "GRADE_SUBMIT" });
    expect(stillGrading).toEqual(grading);
  });

  it("locks grading after a committed result until the next card resets the machine", () => {
    const grading = dispatch(initialRevealGuardState, [
      { type: "REVEAL" },
      { type: "FLIP_DONE" },
      { type: "GRADE_SUBMIT" },
    ]);
    const locked = revealGuardReducer(grading, { type: "GRADE_RESULT", retry: false });
    expect(canGrade(locked)).toBe(false);
    expect(revealGuardReducer(locked, { type: "GRADE_SUBMIT" })).toEqual(locked);

    const reset = revealGuardReducer(locked, { type: "RESET" });
    expect(reset).toEqual(initialRevealGuardState);
  });

  it("returns to ready (not locked) on a retryable error, allowing the same attempt to be resubmitted", () => {
    const grading = dispatch(initialRevealGuardState, [
      { type: "REVEAL" },
      { type: "FLIP_DONE" },
      { type: "GRADE_SUBMIT" },
    ]);
    const retried = revealGuardReducer(grading, { type: "GRADE_RESULT", retry: true });
    expect(canGrade(retried)).toBe(true);
  });

  it("RESET always returns to the initial idle state from any phase", () => {
    const midFlip = dispatch(initialRevealGuardState, [{ type: "REVEAL" }]);
    expect(revealGuardReducer(midFlip, { type: "RESET" })).toEqual(initialRevealGuardState);
  });

  describe("rapid-tapping regression (real user-reported stuck-Reveal bug)", () => {
    // Reproduces "if I rapidly tap/click Reveal several times, the Session
    // can end up stuck showing an unresponsive Reveal button." Root cause
    // (see lib/session-ui/reveal-guard.ts's header): an earlier revision
    // required BOTH a FLIP_DONE signal AND a separately-tracked "pointer
    // released" signal before grading was allowed, and Reveal was
    // pointerdown-triggered. When a rapid burst of taps landed a *new*
    // Reveal activation immediately after a card reset, the resulting CSS
    // transition could be coalesced by the browser into a no-op that never
    // fired its completion event, permanently stranding the guard in
    // "revealing" -- because a real precondition (the second one) could
    // never become true. The fix removed that second precondition
    // entirely (Reveal is now click-triggered, so "pointer released" is
    // trivially always true by the time it fires) and made FLIP_DONE the
    // ONLY gate for "ready". These tests assert the *state machine* itself
    // can no longer get permanently stuck no matter how many extra events
    // arrive in what order -- it always converges to a gradeable or
    // idle/locked state, never to a dead end.

    it("a burst of REVEAL events (simulating a rapid multi-tap) never desyncs the machine -- one FLIP_DONE is always enough to reach ready", () => {
      const afterBurst = dispatch(initialRevealGuardState, [
        { type: "REVEAL" },
        { type: "REVEAL" },
        { type: "REVEAL" },
        { type: "REVEAL" },
        { type: "REVEAL" },
      ]);
      expect(afterBurst.phase).toBe("revealing");

      const ready = revealGuardReducer(afterBurst, { type: "FLIP_DONE" });
      expect(canGrade(ready)).toBe(true);
    });

    it("extra FLIP_DONE events arriving before or after the real one never get the machine stuck", () => {
      // A stray/duplicate FLIP_DONE before REVEAL, and duplicates after
      // reaching "ready" -- all must be safe no-ops, never regressing the
      // phase or blocking the eventual "ready" state.
      let state = revealGuardReducer(initialRevealGuardState, { type: "FLIP_DONE" });
      state = revealGuardReducer(state, { type: "REVEAL" });
      state = revealGuardReducer(state, { type: "FLIP_DONE" });
      state = revealGuardReducer(state, { type: "FLIP_DONE" });
      state = revealGuardReducer(state, { type: "FLIP_DONE" });
      expect(canGrade(state)).toBe(true);
    });

    it("a full rapid grade->reset->reveal->grade cycle, run twice back to back, never gets stuck", () => {
      let state = initialRevealGuardState;
      for (let i = 0; i < 2; i++) {
        state = revealGuardReducer(state, { type: "REVEAL" });
        state = revealGuardReducer(state, { type: "REVEAL" }); // extra rapid tap, must be ignored
        state = revealGuardReducer(state, { type: "FLIP_DONE" });
        expect(canGrade(state)).toBe(true);
        state = revealGuardReducer(state, { type: "GRADE_SUBMIT" });
        state = revealGuardReducer(state, { type: "GRADE_RESULT", retry: false });
        expect(canGrade(state)).toBe(false);
        state = revealGuardReducer(state, { type: "RESET" });
        expect(state).toEqual(initialRevealGuardState);
      }
    });
  });
});
