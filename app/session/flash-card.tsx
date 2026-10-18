"use client";

/**
 * The flashcard itself -- the primary cognitive object of the Session
 * screen (MVP_UI_SPEC.md 10, P2 "Reveal/Card interaction"). Renders as a
 * real front/back flip: both faces are stacked via `position: absolute;
 * inset: 0` inside a `position: relative` rotating layer, which itself
 * fills the outer (non-rotating) card frame the same way.
 *
 * This is deliberately NOT CSS Grid `gridArea` stacking with a
 * percentage-height (`height: 100%` / `h-full`) child, which an earlier
 * revision used. That broke silently: this card's outer frame gets its
 * definite height from `flex-1` + `min-h`/`max-h` (flex-grow, not a plain
 * `height` value), and a percentage `height` on a descendant does not
 * reliably resolve against a flex-grown ancestor's size the way it does
 * against an ancestor with an explicit `height` -- every grid/flex child
 * in that chain was silently collapsing to its own content's natural
 * height (~108px) instead of filling the ~448px card, which is exactly
 * why the revealed word rendered pinned near the top instead of centered
 * (verified with real DOM measurements, not guessed). `inset: 0` on an
 * absolutely positioned element has no such caveat -- it always fills its
 * positioned ancestor's box, full stop -- so both faces reliably get the
 * card's actual full height, `CardFace`'s own `h-full` genuinely applies,
 * and the word centers in the remaining space below the eyebrow label.
 *
 * `overflow-hidden` + `rounded-2xl` still live on the OUTER (non-rotating)
 * wrapper, never on the rotating faces themselves. This is deliberate: a
 * static clip mask on a non-transformed ancestor stays correct at every
 * instant of the 3D rotation, including the middle of the flip, which
 * fixes a real bug where the back face's content/background could render
 * slightly outside the card's rounded corners mid-rotation when each
 * face tried to clip itself individually while also being 3D-transformed.
 *
 * FLIP_DONE (the reveal-guard's signal that grading may begin) is driven
 * by a plain `setTimeout` matched to the CSS transition duration below,
 * NOT by a `transitionend` listener. A `transitionend`-driven signal is
 * fragile in exactly the way this app hit in production: if a new Reveal
 * fires very soon after the previous card resets (flipping back to
 * front), the browser can coalesce the "flip back" and "flip to back
 * again" transform changes into a single net-zero transition (identical
 * start/end value) that never fires `transitionend` at all -- permanently
 * stranding the reveal-guard in its "revealing" phase. A timer has no such
 * hazard: it always fires, exactly once, `FLIP_DURATION_MS` after this
 * component starts showing the revealed face. See
 * lib/session-ui/reveal-guard.ts's header for the full incident writeup.
 */

import { useEffect, useRef, useState, type CSSProperties, type TransitionEvent } from "react";
import {
  applyEdgeReached,
  applyNextCardReady,
  applyRevealedChange,
  initialFlashCardDisplayState,
  type FlashCardContent,
} from "@/lib/session-ui/flash-card-display";

/** Matches the `duration-*` Tailwind classes below -- keep both in sync. */
const FLIP_DURATION_MS = 200;
const REDUCED_MOTION_DURATION_MS = 150;

// The grading-transition flip is two legs (back -> edge -> front), each
// half of the single-leg reveal flip's own duration, so the total
// perceived pacing matches what it always has.
const ROTATE_LEG_MS = FLIP_DURATION_MS / 2;
const OPACITY_LEG_MS = REDUCED_MOTION_DURATION_MS / 2;

// Pure safety net, not the primary driver: if the real transitionend
// this is paired with never fires for some unanticipated reason, this
// forces the edge-reached swap anyway rather than stranding the card
// frozen forever. Generous relative to the leg duration specifically so
// it never fires before a legitimately slow (but real) transitionend
// would -- see this module's own header on why a timer is not the
// preferred primary signal here. Computed per-mode (rotation vs.
// opacity legs have different durations), never a single fixed constant.
function edgeFallbackMs(reducedMotion: boolean): number {
  return (reducedMotion ? OPACITY_LEG_MS : ROTATE_LEG_MS) * 3;
}

export function FlashCard({
  cardId,
  front,
  back,
  frontLabel,
  backLabel,
  revealed,
  reducedMotion,
  onFlipDone,
}: {
  /** session-screen.tsx's cardState.card.cardId -- identifies which card `front`/`back` belong to; see the freeze block below for why this component needs it. */
  readonly cardId: string;
  readonly front: string;
  readonly back: string;
  /** The front/back face's eyebrow label (e.g. "Swahili" / "English"), derived from the deck's own front_language/back_language -- never hardcoded here, so this component works for any deck language pair. */
  readonly frontLabel: string;
  readonly backLabel: string;
  readonly revealed: boolean;
  readonly reducedMotion: boolean;
  readonly onFlipDone: () => void;
}) {
  // Read through a ref so the timer effect below only needs to depend on
  // `revealed`/`reducedMotion` -- not on `onFlipDone`'s identity, which
  // would otherwise (re)start the timer on every parent re-render. Kept in
  // sync via its own effect (not written during render) -- this one runs
  // on every render, always before the timer effect below, since effects
  // run in declaration order.
  const onFlipDoneRef = useRef(onFlipDone);
  useEffect(() => {
    onFlipDoneRef.current = onFlipDone;
  });

  useEffect(() => {
    if (!revealed) return;
    const duration = reducedMotion ? REDUCED_MOTION_DURATION_MS : FLIP_DURATION_MS;
    const timer = setTimeout(() => onFlipDoneRef.current(), duration);
    return () => clearTimeout(timer);
  }, [revealed, reducedMotion]);

  // ---------------------------------------------------------------------
  // Displayed-content freeze (Alpha-blocking fix: NEITHER the next
  // card's answer NOR the previous card's front may ever flash during
  // the grading transition)
  // ---------------------------------------------------------------------
  // `displayed` is this component's OWN copy of what is actually
  // rendered -- deliberately never `front`/`back`/`frontLabel`/
  // `backLabel` directly.
  //
  // Alpha card-loop perceived-latency experiment: `revealed` now flips
  // true -> false the INSTANT grading is submitted (session-screen.tsx's
  // guardState phase leaving "ready"), well before the server has
  // replied -- not, as originally, in the same commit as
  // `setCardState(nextCard)`. `front`/`back`/etc. only change LATER, once
  // the server's response actually arrives. This is exactly why the
  // content freeze below can no longer be driven by the `revealed`
  // transition alone -- see lib/session-ui/flash-card-display.ts's own
  // header ("Perceived-latency extension") for the two-signal race this
  // now resolves (EDGE_REACHED vs. NEXT_CARD_READY, whichever is last).
  //
  // A first fix simply froze `displayed` on the OLD card for the whole
  // flip-back duration, then swapped once fully settled at 0deg/front-
  // facing. That closed the next-answer leak but opened a second one:
  // once the rotation swings back past 90deg toward 0deg, the face
  // coming back into view is still showing the OLD card -- its FRONT
  // (question) becomes briefly readable again before the eventual swap.
  //
  // The actual fix is a genuine two-phase flip, split at the edge
  // (90deg -- or, in the reduced-motion cross-fade, the instant both
  // faces are simultaneously at opacity 0), where NEITHER face is
  // readable: freeze on the OLD content while rotating/fading TOWARD the
  // edge, swap content exactly AT the edge, then rotate/fade the NEW
  // content IN. The viewer only ever sees: old answer -> edge (nothing
  // readable) -> new question -- never the old question, never the new
  // answer. See lib/session-ui/flash-card-display.ts's own header for
  // the full state machine this is wired to.
  //
  // The edge-reached swap is driven by the real CSS transition's own
  // `onTransitionEnd` (filtered to this element's own `transform`/
  // `opacity` property, not a bubbled child event), never a guessed
  // timer -- a timer-at-midpoint can drift under slow rendering and fire
  // before or after the rotation has actually reached an unreadable
  // angle. A generous fallback timer (edgeFallbackMs, well past the leg's
  // own duration) exists purely so a transition that somehow never fires
  // `transitionend` (the hazard this file's header documents for the
  // *reveal* direction's own timer-over-transitionend choice) can't
  // strand the card frozen forever -- applyEdgeReached is idempotent, so
  // whichever of the two fires first wins and the other is a no-op.
  //
  // The decision logic itself is the pure, directly-unit-tested state
  // machine in lib/session-ui/flash-card-display.ts -- this component
  // only wires it to React: both the `revealed`-changed branch AND the
  // new content-changed-while-awaiting branch below run DURING RENDER
  // (React's own documented "adjusting state when a prop changes"
  // escape hatch --
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  // -- a conditional setState call compared against a previous-render
  // snapshot, not inside an Effect). Only the actual timed fallback (an
  // external-clock wait, which IS Effect territory) lives in a real
  // `useEffect` below.
  const content: FlashCardContent = { cardId, front, back, frontLabel, backLabel };
  const [displayState, setDisplayState] = useState(() => initialFlashCardDisplayState(content, revealed));

  // Two independent signals, not one -- see lib/session-ui/flash-card-display.ts's
  // own header ("Perceived-latency extension") for the full race
  // analysis. `revealed` flipping false now starts the exit transition
  // immediately, BEFORE the next card's content is known; `content`
  // itself changing afterward (while still awaiting one) is what
  // supplies it, independently of whether the edge has been reached yet.
  if (revealed !== displayState.prevRevealed) {
    setDisplayState(applyRevealedChange(displayState, content, revealed));
  } else if (displayState.awaitingNextCard && content.cardId !== displayState.prevContentCardId) {
    setDisplayState(applyNextCardReady(displayState, content));
  }

  const { position, pendingSwap, awaitingNextCard, edgeReached } = displayState;

  // Fallback-only; the primary signal is the transitionend handlers wired
  // into the rotating layer / back face below. `applyEdgeReached` itself
  // is idempotent once arrival has already been confirmed via the other
  // path, so whichever of the two fires first is the one that actually
  // matters. Scheduled whenever arrival at the edge hasn't been
  // confirmed yet -- NOT only when `pendingSwap` is already set: the
  // perceived-latency extension's "hold at the safe hidden state" case
  // (awaitingNextCard, pendingSwap still null because the server hasn't
  // replied) must ALSO get a fallback, or a real transitionend that
  // somehow never fires would leave `edgeReached` permanently false even
  // after the content eventually arrives.
  useEffect(() => {
    if (position !== "edge" || edgeReached) return;
    if (pendingSwap === null && !awaitingNextCard) return;
    const timer = setTimeout(() => setDisplayState(applyEdgeReached), edgeFallbackMs(reducedMotion));
    return () => clearTimeout(timer);
  }, [position, pendingSwap, awaitingNextCard, edgeReached, reducedMotion]);

  const displayed = displayState.displayed;

  function handleRotationTransitionEnd(event: TransitionEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || event.propertyName !== "transform") return;
    setDisplayState(applyEdgeReached);
  }

  function handleBackFaceTransitionEnd(event: TransitionEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || event.propertyName !== "opacity") return;
    setDisplayState(applyEdgeReached);
  }

  const rotationDeg = position === "back" ? 180 : position === "edge" ? 90 : 0;

  return (
    <div
      className="relative min-h-[220px] max-h-[28rem] flex-1 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
      style={reducedMotion ? undefined : { perspective: "1200px" }}
    >
      <div
        className="absolute inset-0"
        onTransitionEnd={reducedMotion ? undefined : handleRotationTransitionEnd}
        style={
          reducedMotion
            ? undefined
            : {
                transformStyle: "preserve-3d",
                transform: `rotateY(${rotationDeg}deg)`,
                transition: `transform ${ROTATE_LEG_MS}ms ease-out`,
              }
        }
      >
        <CardFace
          eyebrow={displayed.frontLabel}
          text={displayed.front}
          style={
            reducedMotion
              ? {
                  position: "absolute",
                  inset: 0,
                  opacity: position === "front" ? 1 : 0,
                  transition: `opacity ${OPACITY_LEG_MS}ms ease-out`,
                }
              : { position: "absolute", inset: 0, backfaceVisibility: "hidden" }
          }
        />
        <CardFace
          eyebrow={displayed.backLabel}
          text={displayed.back}
          onTransitionEnd={reducedMotion ? handleBackFaceTransitionEnd : undefined}
          style={
            reducedMotion
              ? {
                  position: "absolute",
                  inset: 0,
                  opacity: position === "back" ? 1 : 0,
                  transition: `opacity ${OPACITY_LEG_MS}ms ease-out`,
                }
              : { position: "absolute", inset: 0, backfaceVisibility: "hidden", transform: "rotateY(180deg)" }
          }
        />
      </div>
    </div>
  );
}

/**
 * The eyebrow label is a fixed-height element near the top, NOT part of
 * the centered group -- the word/meaning below it centers within the
 * REMAINING space (`flex-1 items-center justify-center`), not within the
 * whole face including the label. That keeps the label from pulling the
 * main content's visual center upward: the word is what reads as centered,
 * the label just sits quietly above it.
 */
function CardFace({
  eyebrow,
  text,
  style,
  onTransitionEnd,
}: {
  readonly eyebrow: string;
  readonly text: string;
  readonly style: CSSProperties;
  readonly onTransitionEnd?: (event: TransitionEvent<HTMLDivElement>) => void;
}) {
  return (
    <div className="flex h-full flex-col p-6" style={style} onTransitionEnd={onTransitionEnd}>
      <p className="shrink-0 pt-2 text-center text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-600">
        {eyebrow}
      </p>
      <div className="flex flex-1 items-center justify-center px-2">
        <p className="w-full text-center text-3xl font-semibold text-balance text-zinc-950 dark:text-zinc-50">
          {text}
        </p>
      </div>
    </div>
  );
}
