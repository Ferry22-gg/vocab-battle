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

import { useEffect, useRef, type CSSProperties } from "react";

/** Matches the `duration-*` Tailwind classes below -- keep both in sync. */
const FLIP_DURATION_MS = 200;
const REDUCED_MOTION_DURATION_MS = 150;

export function FlashCard({
  front,
  back,
  frontLabel,
  backLabel,
  revealed,
  reducedMotion,
  onFlipDone,
}: {
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

  return (
    <div
      className="relative min-h-[220px] max-h-[28rem] flex-1 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
      style={reducedMotion ? undefined : { perspective: "1200px" }}
    >
      <div
        className="absolute inset-0"
        style={
          reducedMotion
            ? undefined
            : {
                transformStyle: "preserve-3d",
                transform: revealed ? "rotateY(180deg)" : "rotateY(0deg)",
                transition: "transform 200ms ease-out",
              }
        }
      >
        <CardFace
          eyebrow={frontLabel}
          text={front}
          style={
            reducedMotion
              ? { position: "absolute", inset: 0, opacity: revealed ? 0 : 1, transition: "opacity 150ms ease-out" }
              : { position: "absolute", inset: 0, backfaceVisibility: "hidden" }
          }
        />
        <CardFace
          eyebrow={backLabel}
          text={back}
          style={
            reducedMotion
              ? { position: "absolute", inset: 0, opacity: revealed ? 1 : 0, transition: "opacity 150ms ease-out" }
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
}: {
  readonly eyebrow: string;
  readonly text: string;
  readonly style: CSSProperties;
}) {
  return (
    <div className="flex h-full flex-col p-6" style={style}>
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
