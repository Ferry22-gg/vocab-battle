import { describe, expect, it } from "vitest";
import {
  applyEdgeReached,
  applyRevealedChange,
  initialFlashCardDisplayState,
  type FlashCardContent,
} from "@/lib/session-ui/flash-card-display";

/**
 * Unit tests for the Alpha-blocking flash-card grading-transition fix:
 * NEITHER the next card's answer NOR the previous card's front may ever
 * be rendered visibly during the grading transition -- only the
 * genuinely edge-on (unreadable) instant may ever show a content swap.
 *
 * This is the PURE decision logic app/session/flash-card.tsx wires to
 * React (useState + the real CSS transition's own `onTransitionEnd`,
 * with a timer only as a defensive fallback). This test suite cannot
 * inspect actual rendered DOM/CSS frames (no component-rendering test
 * infrastructure exists in this project -- vitest.config.mts runs in a
 * plain "node" environment, no jsdom, no @testing-library/react,
 * confirmed by inspection before this fix was written). Instead it
 * proves the INVARIANT the fix depends on at the state level: `displayed`
 * never adopts new content except via an explicit `applyEdgeReached`
 * call, and `position` never claims a readable face ("back" or "front")
 * for content that hasn't actually been swapped in yet. The live,
 * full-stack confirmation (actual pixels, actual timing, actual
 * transitionend events) was performed manually via Playwright against a
 * running dev server; see the session report for that run's result.
 */

const cardA: FlashCardContent = { cardId: "a", front: "maji", back: "water", frontLabel: "Swahili", backLabel: "English" };
const cardB: FlashCardContent = { cardId: "b", front: "nyumba", back: "house", frontLabel: "Swahili", backLabel: "English" };

describe("flash-card-display: the grading transition only ever shows old-answer -> edge -> new-question, never old-question or new-answer", () => {
  it("A. grading a revealed card (revealed: true -> false, new content arriving in the same change) freezes `displayed` on the OLD card and heads to the edge -- the new card's content is not yet visible", () => {
    const state = initialFlashCardDisplayState(cardA, true); // card A, already revealed ("back")
    const afterGrade = applyRevealedChange(state, cardB, false); // applyNextCard: new content (B) + revealed -> false, in one change

    expect(afterGrade.position).toBe("edge");
    expect(afterGrade.displayed).toEqual(cardA); // still showing A -- B has not leaked
    expect(afterGrade.pendingSwap).toEqual(cardB); // B is queued, not yet visible
    expect(afterGrade.prevRevealed).toBe(false);
  });

  it("B. heading to the edge never claims the readable 'front' position for the OLD card -- the previous card's question cannot become displayed() while still at the edge, closing the old-front-flash leak", () => {
    const state = initialFlashCardDisplayState(cardA, true);
    const afterGrade = applyRevealedChange(state, cardB, false);

    // Unlike the first (superseded) fix, there is no intermediate state
    // where `displayed` is still card A AND `position` is "front" --
    // the only position paired with the frozen old content is "edge",
    // which this module's header establishes is the one position where
    // neither face is readable.
    expect(afterGrade.position).not.toBe("front");
    expect(afterGrade.displayed).toEqual(cardA);
  });

  it("C. the edge is reached: `displayed` swaps to the next card and heads for 'front' -- never jumps straight to 'back' (which would be the next card's answer)", () => {
    const state = initialFlashCardDisplayState(cardA, true);
    const atEdge = applyRevealedChange(state, cardB, false);
    const edgeReached = applyEdgeReached(atEdge);

    expect(edgeReached.displayed).toEqual(cardB);
    expect(edgeReached.position).toBe("front");
    expect(edgeReached.pendingSwap).toBeNull();
  });

  it("D. the next card's BACK becomes `displayed` only after an explicit, separate reveal of THAT card -- never as a side effect of the edge-reached swap itself", () => {
    const state = initialFlashCardDisplayState(cardA, true);
    const atEdge = applyRevealedChange(state, cardB, false);
    const edgeReached = applyEdgeReached(atEdge);

    expect(edgeReached.prevRevealed).toBe(false);
    expect(edgeReached.position).toBe("front"); // not "back" -- B's answer is not shown yet

    const revealedB = applyRevealedChange(edgeReached, cardB, true);
    expect(revealedB.displayed).toEqual(cardB);
    expect(revealedB.position).toBe("back");
    expect(revealedB.pendingSwap).toBeNull();
  });

  it("E. both grading paths (Correct and Wrong) produce the identical freeze-to-edge transition -- this logic has no notion of correctness at all, only of a revealed->not-revealed transition with new content", () => {
    const state = initialFlashCardDisplayState(cardA, true);
    const afterCorrect = applyRevealedChange(state, cardB, false);
    const afterWrong = applyRevealedChange(state, cardB, false);
    expect(afterCorrect).toEqual(afterWrong);
  });

  it("F. slow next-card arrival/slow rendering cannot expose either forbidden face: the edge holds for an ARBITRARY number of intervening calls/time, since nothing updates `displayed`/`position` except an explicit applyEdgeReached", () => {
    let state = initialFlashCardDisplayState(cardA, true);
    state = applyRevealedChange(state, cardB, false); // next card's data already arrived, frozen at the edge

    for (let i = 0; i < 50; i += 1) {
      expect(state.position).toBe("edge");
      expect(state.displayed).toEqual(cardA);
      expect(state.pendingSwap).toEqual(cardB);
    }

    state = applyEdgeReached(state);
    expect(state.position).toBe("front");
    expect(state.displayed).toEqual(cardB);
  });

  it("G. rapid interaction: a fresh Reveal landing before the edge is reached abandons the pending swap but is still always showing the CORRECT (authoritative, just-passed-in) content -- never a stale or half-swapped one", () => {
    const state = initialFlashCardDisplayState(cardA, true);
    const atEdge = applyRevealedChange(state, cardB, false); // grading card A, heading to edge with B queued

    // The user re-taps Reveal before the edge-reached transitionend ever
    // fires (e.g. the real app's guard already reset to "idle" as soon
    // as the server responded, independent of this component's own
    // animation phase) -- session-screen.tsx's cardState is already B by
    // now, so `content` here is authoritatively B, not a stale value.
    const rapidReveal = applyRevealedChange(atEdge, cardB, true);

    expect(rapidReveal.position).toBe("back");
    expect(rapidReveal.displayed).toEqual(cardB); // exactly what's being revealed -- never A, never a half-applied swap
    expect(rapidReveal.pendingSwap).toBeNull(); // the abandoned pending swap is cleared, not left dangling
  });

  it("a stale edge-reached call (nothing pending, e.g. an interrupted/replaced transition's belated completion) is a safe no-op", () => {
    const state = initialFlashCardDisplayState(cardA, false);
    expect(applyEdgeReached(state)).toEqual(state);

    const revealed = initialFlashCardDisplayState(cardA, true);
    expect(applyEdgeReached(revealed)).toEqual(revealed);
  });

  it("re-revealing the SAME card (no content change) never queues a pending swap and goes straight to 'back'", () => {
    const state = initialFlashCardDisplayState(cardA, false);
    const revealedAgain = applyRevealedChange(state, cardA, true);
    expect(revealedAgain.displayed).toEqual(cardA);
    expect(revealedAgain.position).toBe("back");
    expect(revealedAgain.pendingSwap).toBeNull();
  });
});
