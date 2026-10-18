import { describe, expect, it } from "vitest";
import {
  applyEdgeReached,
  applyNextCardReady,
  applyRevealedChange,
  initialFlashCardDisplayState,
  type FlashCardContent,
} from "@/lib/session-ui/flash-card-display";

/**
 * Unit tests for the Alpha-blocking flash-card grading-transition fix,
 * extended for the Alpha card-loop perceived-latency experiment:
 * NEITHER the next card's answer NOR the previous card's front may ever
 * be rendered visibly during the grading transition -- only the
 * genuinely edge-on (unreadable) instant may ever show a content swap --
 * and this guarantee must hold regardless of whether the server's
 * response (NEXT_CARD_READY) or the real CSS transition's own completion
 * (EDGE_REACHED) happens first.
 *
 * This is the PURE decision logic app/session/flash-card.tsx wires to
 * React (useState + the real CSS transition's own `onTransitionEnd`,
 * with a timer only as a defensive fallback). This test suite cannot
 * inspect actual rendered DOM/CSS frames (no component-rendering test
 * infrastructure exists in this project -- vitest.config.mts runs in a
 * plain "node" environment, no jsdom, no @testing-library/react).
 * Instead it proves the INVARIANT the fix depends on at the state level:
 * `displayed` never adopts new content except via a resolved swap at a
 * confirmed edge, and `position` never claims a readable face ("back" or
 * "front") for content that hasn't actually been safely swapped in yet.
 */

const cardA: FlashCardContent = { cardId: "a", front: "maji", back: "water", frontLabel: "Swahili", backLabel: "English" };
const cardB: FlashCardContent = { cardId: "b", front: "nyumba", back: "house", frontLabel: "Swahili", backLabel: "English" };

describe("flash-card-display: the grading transition only ever shows old-answer -> edge -> new-question, never old-question or new-answer", () => {
  it("A. grading a revealed card (revealed: true -> false) starts the exit with NO content known yet -- freezes `displayed` on the OLD card, heads to the edge, and marks awaitingNextCard", () => {
    const state = initialFlashCardDisplayState(cardA, true); // card A, already revealed ("back")
    // session-screen.tsx's `content` prop at this exact instant is STILL
    // card A -- the server hasn't replied, so there is nothing else it
    // could legitimately pass.
    const afterGrade = applyRevealedChange(state, cardA, false);

    expect(afterGrade.position).toBe("edge");
    expect(afterGrade.displayed).toEqual(cardA); // still showing A
    expect(afterGrade.pendingSwap).toBeNull(); // nothing queued -- the next card isn't known yet
    expect(afterGrade.awaitingNextCard).toBe(true);
    expect(afterGrade.edgeReached).toBe(false);
    expect(afterGrade.prevRevealed).toBe(false);
  });

  it("B. heading to the edge never claims the readable 'front' position for the OLD card -- the previous card's question cannot become displayed() while still at the edge, closing the old-front-flash leak", () => {
    const state = initialFlashCardDisplayState(cardA, true);
    const afterGrade = applyRevealedChange(state, cardA, false);

    expect(afterGrade.position).not.toBe("front");
    expect(afterGrade.displayed).toEqual(cardA);
  });

  it("C. SLOW SERVER: the real edge is reached before the next card arrives -- the card holds at the hidden edge (nothing readable, no content swapped) until the server actually replies, then swaps with no further delay", () => {
    let state = initialFlashCardDisplayState(cardA, true);
    state = applyRevealedChange(state, cardA, false); // grade tapped -- exit begins, no content yet

    // The real CSS transition finishes its back->edge leg before the
    // server has replied.
    state = applyEdgeReached(state);
    expect(state.position).toBe("edge");
    expect(state.displayed).toEqual(cardA); // still A -- nothing readable, nothing swapped
    expect(state.edgeReached).toBe(true);
    expect(state.pendingSwap).toBeNull();

    // The hold persists for an arbitrary number of intervening renders --
    // nothing updates `displayed`/`position` except an explicit resolve.
    for (let i = 0; i < 20; i += 1) {
      expect(state.position).toBe("edge");
      expect(state.displayed).toEqual(cardA);
    }

    // The server finally replies with card B.
    state = applyNextCardReady(state, cardB);
    expect(state.displayed).toEqual(cardB);
    expect(state.position).toBe("front");
    expect(state.pendingSwap).toBeNull();
    expect(state.awaitingNextCard).toBe(false);
  });

  it("D. FAST SERVER: the next card arrives before the real edge is reached -- the swap is parked, NOT applied early, and only resolves exactly when the edge is genuinely reached (no unnecessary pause)", () => {
    let state = initialFlashCardDisplayState(cardA, true);
    state = applyRevealedChange(state, cardA, false); // grade tapped -- exit begins, no content yet

    // The server replies before the CSS transition has actually finished
    // its leg (position is "edge" as a TARGET already, but edgeReached
    // is still false -- the DOM hasn't visually arrived there yet).
    state = applyNextCardReady(state, cardB);
    expect(state.displayed).toEqual(cardA); // still A -- NOT swapped early
    expect(state.position).toBe("edge");
    expect(state.pendingSwap).toEqual(cardB); // parked, not yet visible
    expect(state.edgeReached).toBe(false);

    // Only once the real transition genuinely completes does the swap
    // happen -- exactly at that moment, no earlier.
    state = applyEdgeReached(state);
    expect(state.displayed).toEqual(cardB);
    expect(state.position).toBe("front");
    expect(state.pendingSwap).toBeNull();
    expect(state.awaitingNextCard).toBe(false);
  });

  it("E. the next card's BACK becomes `displayed` only after an explicit, separate reveal of THAT card -- never as a side effect of the edge-reached swap itself", () => {
    let state = initialFlashCardDisplayState(cardA, true);
    state = applyRevealedChange(state, cardA, false);
    state = applyEdgeReached(state); // holding
    state = applyNextCardReady(state, cardB); // resolves to front

    expect(state.position).toBe("front"); // not "back" -- B's answer is not shown yet

    const revealedB = applyRevealedChange(state, cardB, true);
    expect(revealedB.displayed).toEqual(cardB);
    expect(revealedB.position).toBe("back");
    expect(revealedB.pendingSwap).toBeNull();
  });

  it("F. both grading paths (Correct and Wrong) produce the identical freeze-to-edge transition -- this logic has no notion of correctness at all, only of a revealed->not-revealed transition", () => {
    const state = initialFlashCardDisplayState(cardA, true);
    const afterCorrect = applyRevealedChange(state, cardA, false);
    const afterWrong = applyRevealedChange(state, cardA, false);
    expect(afterCorrect).toEqual(afterWrong);
  });

  it("G. rapid interaction: a fresh Reveal landing before the edge is reached abandons the pending exit but is still always showing the CORRECT (authoritative, just-passed-in) content -- never a stale or half-swapped one", () => {
    const state = initialFlashCardDisplayState(cardA, true);
    const atEdge = applyRevealedChange(state, cardA, false); // grading card A, heading to edge, awaiting next card

    // session-screen.tsx's cardState is already B by now (e.g. a
    // retryable failure returned to "ready" after the next card had
    // somehow already been installed) -- `content` here is
    // authoritatively B, not a stale value.
    const rapidReveal = applyRevealedChange(atEdge, cardB, true);

    expect(rapidReveal.position).toBe("back");
    expect(rapidReveal.displayed).toEqual(cardB); // exactly what's being revealed -- never A, never a half-applied swap
    expect(rapidReveal.pendingSwap).toBeNull();
    expect(rapidReveal.awaitingNextCard).toBe(false);
  });

  it("a stale edge-reached call (not targeting the edge at all) is a safe no-op", () => {
    const state = initialFlashCardDisplayState(cardA, false);
    expect(applyEdgeReached(state)).toEqual(state);

    const revealed = initialFlashCardDisplayState(cardA, true);
    expect(applyEdgeReached(revealed)).toEqual(revealed);
  });

  it("a stale/duplicate edge-reached call while already marked edgeReached (e.g. both the real transitionend and the fallback timer firing) is a safe no-op", () => {
    let state = initialFlashCardDisplayState(cardA, true);
    state = applyRevealedChange(state, cardA, false);
    state = applyEdgeReached(state);
    expect(state.edgeReached).toBe(true);

    const again = applyEdgeReached(state);
    expect(again).toEqual(state);
  });

  it("applyNextCardReady is a safe no-op (aside from cardId bookkeeping) when not actually awaiting a next card", () => {
    const state = initialFlashCardDisplayState(cardA, false); // settled at "front", not mid-exit
    const result = applyNextCardReady(state, cardB);
    expect(result.displayed).toEqual(cardA);
    expect(result.position).toBe("front");
    expect(result.awaitingNextCard).toBe(false);
  });

  it("re-revealing the SAME card (no content change) never queues a pending swap and goes straight to 'back'", () => {
    const state = initialFlashCardDisplayState(cardA, false);
    const revealedAgain = applyRevealedChange(state, cardA, true);
    expect(revealedAgain.displayed).toEqual(cardA);
    expect(revealedAgain.position).toBe("back");
    expect(revealedAgain.pendingSwap).toBeNull();
  });
});
