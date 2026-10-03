"use client";

/**
 * Non-blocking mastery toast presentation (spec sections 15/25.1). Mirrors
 * battle-scene.tsx's `DailyGoalFx` exactly: `role="status"`/
 * `aria-live="polite"`, `pointer-events-none`, no modal, no required
 * dismissal, auto-fades via the same shared `vb-toast-fade` keyframe
 * (app/globals.css), respecting `reducedMotion`.
 *
 * NOT WIRED YET. Nothing in app/session/session-screen.tsx imports or
 * renders either component below -- see
 * lib/learning-engine/progress/notifications.ts's module header for the
 * exact live-trigger gap this is waiting on. When that trigger exists,
 * wire these in the same way DailyGoalFx is wired: hold a `{ key, ... } |
 * null` fx state in session-screen.tsx, schedule it in handleGrade() when
 * shouldShowCardMasteredToast()/shouldShowFullMasteryToast() returns true
 * for that answer's before/after state, and clear it after its own
 * duration via the existing scheduleFx() helper.
 */

export function CardMasteredToast({ reducedMotion }: { readonly reducedMotion: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        "pointer-events-none absolute top-1 z-10 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800 shadow-sm dark:bg-emerald-900/60 dark:text-emerald-200" +
        (reducedMotion ? "" : " animate-[vb-toast-fade_2200ms_ease-in-out_forwards]")
      }
    >
      ⭐ Card mastered
    </div>
  );
}

export function FullMasteryToast({ reducedMotion }: { readonly reducedMotion: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        "pointer-events-none absolute top-1 z-10 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800 shadow-sm dark:bg-amber-900/60 dark:text-amber-200" +
        (reducedMotion ? "" : " animate-[vb-toast-fade_2200ms_ease-in-out_forwards]")
      }
    >
      🏆 Deck fully mastered!
    </div>
  );
}
