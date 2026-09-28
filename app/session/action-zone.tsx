"use client";

/**
 * The shared bottom thumb interaction zone (P2 spec, "Thumb/action-zone
 * design" + "Accidental double-tap protection"). Before Reveal this region
 * is one large Reveal button; after Reveal it becomes Wrong (left) /
 * Correct (right), equal size, neither implying moral superiority.
 *
 * Reveal is a plain click handler -- no pointerdown/window-listener
 * plumbing. An earlier revision triggered Reveal on pointerdown so it
 * could separately track "has this exact pointer been released" as a
 * precondition for grading; that machinery was the source of a real
 * stuck-Reveal bug (see lib/session-ui/reveal-guard.ts's header for the
 * full mechanism) and is unnecessary anyway: click only ever fires once
 * the activating press has already been fully released, so the guard
 * needs no separate "pointer released" signal at all, for mouse, touch,
 * or keyboard alike. This also means Reveal now behaves like an ordinary
 * button for every input method with no extra code -- keyboard Enter/Space
 * activation Just Works.
 */

import { canGrade, canReveal, type RevealGuardState } from "@/lib/session-ui/reveal-guard";

export function ActionZone({
  guardState,
  onReveal,
  onGrade,
}: {
  readonly guardState: RevealGuardState;
  readonly onReveal: () => void;
  readonly onGrade: (correct: boolean) => void;
}) {
  function handleRevealClick() {
    if (!canReveal(guardState)) return;
    onReveal();
  }

  if (canReveal(guardState) || guardState.phase === "revealing") {
    return (
      <button
        type="button"
        onClick={handleRevealClick}
        disabled={guardState.phase === "revealing"}
        aria-label="Reveal the meaning"
        className="w-full rounded-xl bg-zinc-950 px-4 py-4 text-base font-semibold text-white shadow-sm transition-colors active:bg-zinc-800 disabled:opacity-90 dark:bg-white dark:text-zinc-950"
      >
        Reveal
      </button>
    );
  }

  const gradeable = canGrade(guardState);

  return (
    <div className="grid grid-cols-2 gap-3" role="group" aria-label="Grade your recall">
      <button
        type="button"
        onClick={() => onGrade(false)}
        disabled={!gradeable}
        aria-label="Wrong -- I did not recall this correctly"
        className="flex items-center justify-center gap-2 rounded-xl border-2 border-zinc-300 bg-white px-4 py-4 text-base font-semibold text-zinc-700 shadow-sm transition-colors active:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
      >
        <span aria-hidden="true">✕</span> Wrong
      </button>
      <button
        type="button"
        onClick={() => onGrade(true)}
        disabled={!gradeable}
        aria-label="Correct -- I recalled this correctly"
        className="flex items-center justify-center gap-2 rounded-xl border-2 border-zinc-300 bg-white px-4 py-4 text-base font-semibold text-zinc-700 shadow-sm transition-colors active:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
      >
        <span aria-hidden="true">✓</span> Correct
      </button>
    </div>
  );
}
