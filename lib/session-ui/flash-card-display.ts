/**
 * Pure state machine for app/session/flash-card.tsx's "displayed-content
 * freeze" fix (Alpha-blocking: neither the next card's answer NOR the
 * previous card's front may ever flash during the grading transition),
 * extended for the Alpha card-loop perceived-latency experiment: the
 * outgoing-card transition now starts the INSTANT grading begins,
 * overlapping with the server round trip instead of waiting for it.
 *
 * Two distinct leaks had to be closed originally, both caused by the same
 * root cause (grading swaps `revealed: true -> false` and the card's
 * content in the same commit, but the flip is a single continuous
 * 180deg -> 0deg rotation):
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
 * ---------------------------------------------------------------------
 * Perceived-latency extension: two INDEPENDENT signals racing, not one
 * ---------------------------------------------------------------------
 * The original version above assumed the next card's content was always
 * already known the instant `revealed` flipped to `false` (session-
 * screen.tsx updated both in the same commit, only after the server had
 * already replied). This version starts the exit transition BEFORE the
 * server has replied -- `revealed` flips to `false` the moment grading
 * begins, with no content yet -- so the content swap can no longer be
 * driven by `revealed` alone. There are now two independent events, and
 * the swap must happen at whichever finishes LAST:
 *
 *   - EDGE_REACHED: the real CSS transition has ACTUALLY completed its
 *     back-to-edge leg (flash-card.tsx's `onTransitionEnd`, same signal
 *     as before). Tracked as `edgeReached`, deliberately kept SEPARATE
 *     from `position === "edge"` -- `position` flips to `"edge"`
 *     synchronously the instant grading starts (it's what tells the CSS
 *     layer which angle to animate TOWARD), but the rotation itself
 *     still takes the leg's real duration to actually arrive there. A
 *     version of this module that treated `position === "edge"` as
 *     "the edge has been reached" would let a sufficiently fast server
 *     response swap content WHILE the rotation is still mid-flight,
 *     exposing it at a readable angle -- exactly the hazard this split
 *     exists to prevent.
 *   - NEXT_CARD_READY: `content` actually changing while a grading exit
 *     is in progress (session-screen.tsx has called setCardState with
 *     the server's authoritative result).
 *
 * If EDGE_REACHED fires first (the common case: a server round trip
 * almost always outlasts the ~100ms rotation leg), the card holds at the
 * edge -- nothing readable -- until NEXT_CARD_READY resolves it (the
 * "hold at the safe hidden state" case). If NEXT_CARD_READY fires first
 * (an unusually fast response), the content is parked in `pendingSwap`
 * and the rotation continues uninterrupted; the swap still only happens
 * when EDGE_REACHED actually fires, so there is never an early swap and
 * never an added pause either. Either order produces the identical
 * final sequence the original fix guaranteed: old answer -> edge
 * (nothing readable) -> new question -- never the old question, never
 * the new answer, and never dependent on which of the two signals
 * happens to arrive first.
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
 * card's front/question, fully settled or settling into view). This is
 * the CSS layer's TARGET angle, not a confirmation that the DOM has
 * actually arrived there -- see `edgeReached` for that.
 */
export type FlashCardRevealPosition = "back" | "edge" | "front";

export interface FlashCardDisplayState {
  /** What is actually rendered right now. */
  readonly displayed: FlashCardContent;
  /** `revealed` as of the last processed change -- lets the render-time check detect a true->false (or false->true) transition from a single new value, which `revealed` alone cannot (see flash-card.tsx). */
  readonly prevRevealed: boolean;
  /** `content.cardId` as of the last processed change -- lets the render-time check detect "the authoritative next card just became known", independent of `revealed` (see module header: these are now two separate signals). */
  readonly prevContentCardId: string;
  readonly position: FlashCardRevealPosition;
  /** Non-null exactly while a grading-triggered swap is frozen at `displayed`, parked here because NEXT_CARD_READY fired before the real EDGE_REACHED did. */
  readonly pendingSwap: FlashCardContent | null;
  /** True from the moment a grading exit begins (revealed goes true->false, with no content known yet) until the next card is actually installed. */
  readonly awaitingNextCard: boolean;
  /**
   * True once the real CSS transition has ACTUALLY completed its leg
   * toward `"edge"` (flash-card.tsx's genuine `onTransitionEnd`, or its
   * fallback timer) -- deliberately NOT the same thing as
   * `position === "edge"`, which becomes true synchronously the instant
   * grading starts, well before the DOM has visually arrived there. Only
   * meaningful while `awaitingNextCard`; otherwise always false.
   */
  readonly edgeReached: boolean;
}

export function initialFlashCardDisplayState(content: FlashCardContent, revealed: boolean): FlashCardDisplayState {
  return {
    displayed: content,
    prevRevealed: revealed,
    prevContentCardId: content.cardId,
    position: revealed ? "back" : "front",
    pendingSwap: null,
    awaitingNextCard: false,
    edgeReached: false,
  };
}

/**
 * Call when `revealed !== state.prevRevealed` (a Reveal action, or a
 * grading exit just started), with the CURRENT `content`/`revealed`
 * props.
 *
 *   revealed -> true: always revealing the SAME card already on screen
 *     (a fresh Reveal tap, or a retryable grading failure returning to
 *     "ready" -- see lib/session-ui/reveal-guard.ts; neither ever
 *     changes `content` itself) -- `content` is therefore always the
 *     authoritative current card, so it's safe to sync `displayed` to
 *     it immediately and head straight for "back", REGARDLESS of
 *     whatever position/pendingSwap/awaitingNextCard this state was
 *     previously in. This is what makes rapid repeat interaction safe
 *     (a fresh Reveal tap landing mid-exit from an abandoned/failed
 *     grade): there is no stale content left stranded to leak, because
 *     `content` here is always exactly the card being revealed.
 *   revealed -> false: a grade was just submitted. Unlike the original
 *     fix, `content` here is NOT yet the next card -- session-screen.tsx
 *     has not received the server's response yet, so `content` is still
 *     whatever card was just graded. Freeze `displayed` exactly as it
 *     was (it already equals `content` at this point, so this is a
 *     no-op either way), park nothing in `pendingSwap` (there is nothing
 *     to park -- the next card isn't known), mark `awaitingNextCard`,
 *     and set the CSS target to "edge" -- the real arrival is tracked
 *     separately via `edgeReached` (see module header).
 */
export function applyRevealedChange(
  state: FlashCardDisplayState,
  content: FlashCardContent,
  revealed: boolean,
): FlashCardDisplayState {
  if (revealed) {
    return {
      displayed: content,
      prevRevealed: true,
      prevContentCardId: content.cardId,
      position: "back",
      pendingSwap: null,
      awaitingNextCard: false,
      edgeReached: false,
    };
  }
  return {
    displayed: state.displayed,
    prevRevealed: false,
    prevContentCardId: content.cardId,
    position: "edge",
    pendingSwap: null,
    awaitingNextCard: true,
    edgeReached: false,
  };
}

/**
 * Call when `content.cardId !== state.prevContentCardId` while
 * `state.awaitingNextCard` is true -- the server has just supplied the
 * authoritative next card (session-screen.tsx called setCardState).
 *
 * If the edge has ALREADY been genuinely reached (`edgeReached`, the
 * common case -- a server round trip almost always outlasts the ~100ms
 * rotation leg), resolve immediately: there is nothing left to wait for,
 * so install the new content and continue straight into "front" with no
 * added pause.
 *
 * If the edge has NOT actually been reached yet (an unusually fast
 * response racing the animation), park the content in `pendingSwap` and
 * change nothing else -- `position` is already `"edge"` as the CSS
 * target, so the rotation continues uninterrupted toward it. The swap
 * still only happens once the real applyEdgeReached call confirms
 * arrival, never earlier.
 *
 * A no-op (aside from bookkeeping `prevContentCardId`) if called while
 * not awaiting a next card at all -- defensive only; the real call site
 * only invokes this under the `awaitingNextCard` guard.
 */
export function applyNextCardReady(
  state: FlashCardDisplayState,
  content: FlashCardContent,
): FlashCardDisplayState {
  if (!state.awaitingNextCard) {
    return { ...state, prevContentCardId: content.cardId };
  }
  if (state.edgeReached) {
    return {
      displayed: content,
      prevRevealed: state.prevRevealed,
      prevContentCardId: content.cardId,
      position: "front",
      pendingSwap: null,
      awaitingNextCard: false,
      edgeReached: false,
    };
  }
  return { ...state, pendingSwap: content, prevContentCardId: content.cardId };
}

/**
 * Call when the flip's first leg (back -> edge) ACTUALLY completes --
 * driven by the real transition's own completion signal, not a timer
 * (see flash-card.tsx for why: a timer-at-midpoint can drift under slow
 * rendering and fire before the rotation has really reached an
 * unreadable angle).
 *
 * A safe no-op if called while not targeting the edge at all (e.g. a
 * stale/interrupted transition's belated completion, or a fresh Reveal
 * already abandoned the edge for "back").
 *
 * While genuinely awaiting the next card: if `pendingSwap` is already
 * set (NEXT_CARD_READY fired first -- an unusually fast response),
 * resolve the swap now, exactly at the moment it becomes safe to do so.
 * If `pendingSwap` is still null (the common case -- the server hasn't
 * replied yet), this is the "hold at the safe hidden state" moment:
 * mark `edgeReached` and stay exactly here -- nothing readable -- until
 * applyNextCardReady eventually resolves it.
 */
export function applyEdgeReached(state: FlashCardDisplayState): FlashCardDisplayState {
  if (state.position !== "edge") {
    return state;
  }
  if (state.pendingSwap !== null) {
    return {
      displayed: state.pendingSwap,
      prevRevealed: state.prevRevealed,
      prevContentCardId: state.prevContentCardId,
      position: "front",
      pendingSwap: null,
      awaitingNextCard: false,
      edgeReached: false,
    };
  }
  if (!state.awaitingNextCard || state.edgeReached) {
    // Not a genuine grading exit (e.g. a stale/belated transitionend),
    // or already marked -- no-op.
    return state;
  }
  return { ...state, edgeReached: true };
}
