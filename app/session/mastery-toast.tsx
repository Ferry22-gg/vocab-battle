"use client";

/**
 * Non-blocking mastery toast presentation (spec sections 15/25.1). Mirrors
 * battle-scene.tsx's `DailyGoalFx` exactly: `role="status"`/
 * `aria-live="polite"`, `pointer-events-none`, no modal, no required
 * dismissal, auto-fades via the same shared `vb-toast-fade` keyframe
 * (app/globals.css), respecting `reducedMotion`.
 *
 * Runtime Cutover RC-E: wired into app/session/battle-scene.tsx, scheduled
 * from app/session/session-screen.tsx's handleGrade() exactly the way
 * DailyGoalFx already is -- see this module's own `style` prop doc below
 * for why a plain `top-1` Tailwind class alone is no longer enough.
 */

import type { CSSProperties } from "react";

/**
 * Optional top-offset override, in addition to (not instead of) this
 * component's own default `top-1` position -- battle-scene.tsx passes one
 * whenever more than one top badge (Daily Goal / Card Mastered / Full
 * Mastery) can be visible at once (spec section 15/25.1's simultaneous
 * "final card triggers both" case), so the two never render on top of
 * each other. `undefined` (the default) reproduces this component's
 * original single-badge position exactly.
 */
interface MasteryToastProps {
  readonly reducedMotion: boolean;
  readonly style?: CSSProperties;
}

export function CardMasteredToast({ reducedMotion, style }: MasteryToastProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={style}
      className={
        "pointer-events-none absolute top-1 z-10 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800 shadow-sm dark:bg-emerald-900/60 dark:text-emerald-200" +
        (reducedMotion ? "" : " animate-[vb-toast-fade_2200ms_ease-in-out_forwards]")
      }
    >
      ⭐ Card mastered
    </div>
  );
}

export function FullMasteryToast({ reducedMotion, style }: MasteryToastProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={style}
      className={
        "pointer-events-none absolute top-1 z-10 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800 shadow-sm dark:bg-amber-900/60 dark:text-amber-200" +
        (reducedMotion ? "" : " animate-[vb-toast-fade_2200ms_ease-in-out_forwards]")
      }
    >
      🏆 Deck fully mastered!
    </div>
  );
}
