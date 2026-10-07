/**
 * Pure state machine for app/session/flash-card.tsx's "displayed-content
 * freeze" fix (Alpha-blocking: neither the next card's answer NOR the
 * previous card's front may ever flash during the grading transition).
 * Mirrors this directory's own reveal-guard.ts pattern -- the actual
 * decision logic lives here, pure and framework-agnostic, so it can be
 * unit-tested directly; FlashCard itself only wires it to React state and
 * the real CSS transition's own completion.
 *
 * Two distinct leaks had to be closed, both caused by the same root
 * cause (grading swaps `revealed: true -> false` and the card's content
 * in the same commit, but the flip is a single continuous 180deg -> 0deg
 * rotation):
 *
 *   1. Swapping content immediately (no freeze) exposes the NEXT card's
 *      answer on the face that is still rotating through view.
 *   2. Freezing content for the rotation's ENTIRE duration (the first
 *      fix) exposes the OLD card's FRONT once the rotation passes 90deg
 *      and swings back into view still showing the old card -- the swap
 *      only happened once fully settled at 0deg.
 *
 * The fix is a genuine two-phase flip, split at the edge (90deg / fully
 * transparent for the reduced-motion cross-fade equivalent) where
 * NEITHER face is readable:
 *
 *   back (180deg, OLD content) --grade--> edge (90deg, OLD content, frozen)
 *     --[edge reached]--> edge (90deg, NEW content, swapped) --[next frame]--> front (0deg, NEW content)
 *
 * The content swap happens exactly at the edge, while nothing is
 * readable -- not merely "soon after grading" (leak 1) and not merely
 * "once fully settled" (leak 2). `applyEdgeReached` is driven by the real
 * CSS transition's own completion (flash-card.tsx's `transitionend`
 * handling), never a guessed timer -- a timer-at-midpoint can drift
 * under slow rendering, firing the swap before or after the rotation has
 * actually reached an unreadable angle.
 */
export interface FlashCardContent {
  readonly cardId: string;
  readonly front: string;
  readonly back: string;
  readonly frontLabel: string;
  readonly backLabel: string;
}

/**
 * Where the card is, visually: `"back"` (the current answer, fully
 * revealed), `"edge"` (mid-flip, edge-on -- no face is readable,
 * regardless of which content is currently loaded), or `"front"` (a
 * card's front/question, fully settled or settling into view).
 */
export type FlashCardRevealPosition = "back" | "edge" | "front";

export interface FlashCardDisplayState {
  /** What is actually rendered right now. */
  readonly displayed: FlashCardContent;
  /** `revealed` as of the last processed change -- lets applyRevealedChange detect a true->false (or false->true) transition from a single new value, which `revealed` alone cannot (see flash-card.tsx). */
  readonly prevRevealed: boolean;
  readonly position: FlashCardRevealPosition;
  /** Non-null exactly while a grading-triggered swap is frozen at `displayed`, waiting for the edge to be reached. */
  readonly pendingSwap: FlashCardContent | null;
}

export function initialFlashCardDisplayState(content: FlashCardContent, revealed: boolean): FlashCardDisplayState {
  return { displayed: content, prevRevealed: revealed, position: revealed ? "back" : "front", pendingSwap: null };
}

/**
 * Call when `revealed !== state.prevRevealed` (a reveal or a grading
 * transition just started), with the CURRENT incoming content/revealed
 * value.
 *
 *   revealed -> true: always revealing the SAME card already on screen
 *     (the only caller that ever changes content, session-screen.tsx's
 *     applyNextCard, always resets revealed to false in the same commit,
 *     never to true) -- `content` is therefore always the authoritative
 *     current card, so it's safe to sync `displayed` to it immediately
 *     and head straight for "back", REGARDLESS of whatever position/
 *     pendingSwap this state was previously in. This is deliberate, not
 *     an oversight: it's what makes rapid repeat interaction safe (a
 *     fresh Reveal tap landing mid-flip from the previous grade) --
 *     there is no stale content left stranded to leak, because `content`
 *     here is always exactly the card this Reveal is about to show.
 *   revealed -> false: a grade was just committed. `content` is already
 *     the NEXT card's data (session-screen.tsx updates it synchronously
 *     with the guard reset) -- but it must not become `displayed` yet.
 *     Freeze `displayed` exactly as it was, park `content` in
 *     `pendingSwap`, and head for the edge -- applyEdgeReached applies it
 *     once the edge is actually reached.
 */
export function applyRevealedChange(
  state: FlashCardDisplayState,
  content: FlashCardContent,
  revealed: boolean,
): FlashCardDisplayState {
  if (revealed) {
    return { displayed: content, prevRevealed: true, position: "back", pendingSwap: null };
  }
  return { displayed: state.displayed, prevRevealed: false, position: "edge", pendingSwap: content };
}

/**
 * Call when the flip's first leg (back -> edge) actually completes --
 * driven by the real transition's own completion signal, not a timer. A
 * no-op if nothing is pending (e.g. a stale/interrupted transition's
 * belated completion, or this fired after a fresh Reveal already
 * abandoned the edge for "back" -- see applyRevealedChange's header).
 */
export function applyEdgeReached(state: FlashCardDisplayState): FlashCardDisplayState {
  if (state.position !== "edge" || state.pendingSwap === null) {
    return state;
  }
  return { displayed: state.pendingSwap, prevRevealed: state.prevRevealed, position: "front", pendingSwap: null };
}
