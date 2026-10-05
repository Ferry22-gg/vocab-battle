"use client";

/**
 * The three top-of-screen transient badges that must survive a
 * card-to-card transition -- Daily Goal, Card Mastered, Full Mastery
 * (spec sections 15/25.1/26) -- rendered independently of whether a card
 * is currently on screen.
 *
 * RC-E bugfix: these three previously rendered only inside
 * app/session/battle-scene.tsx, which session-screen.tsx mounts only
 * while `cardState.kind === "card"`. The single most natural way to
 * trigger Card Mastered is mastering a deck's LAST remaining due/new
 * card -- the very same answer that also makes refetchCard() return
 * `no_card`, unmounting BattleScene (and therefore the toast) before it
 * was ever visible. Hoisting this trio out to its own always-mounted
 * component, rendered by session-screen.tsx regardless of `cardState.kind`,
 * fixes that for Card Mastered/Full Mastery and for the pre-existing Daily
 * Goal badge alike -- one shared root cause, one fix, not two.
 *
 * Deliberately NOT part of BattleScene: hitFx/comboFx/defeatFx remain
 * there unchanged -- those are genuinely battle-moment-specific (a hit on
 * an enemy that may no longer be on screen makes no sense to keep
 * showing), so no change in behavior is intended or made for them.
 */

import { CardMasteredToast, FullMasteryToast } from "./mastery-toast";

export interface DailyGoalFx {
  readonly key: number;
}

export interface CardMasteredFx {
  readonly key: number;
}

export interface FullMasteryFx {
  readonly key: number;
}

/**
 * Fixed vertical slots, one per possible badge -- never compacted/
 * reflowed by which subset is actually visible, so no two of Daily Goal /
 * Card Mastered / Full Mastery can ever render on top of each other,
 * including the spec section 15/25.1 case where the final card of a deck
 * triggers Card Mastered and Full Mastery simultaneously.
 */
const DAILY_GOAL_TOP = "0.25rem";
const CARD_MASTERED_TOP = "2.25rem";
const FULL_MASTERY_TOP = "4.25rem";

export function TopBadgeStack({
  reducedMotion,
  dailyGoalFx,
  cardMasteredFx,
  fullMasteryFx,
}: {
  readonly reducedMotion: boolean;
  readonly dailyGoalFx: DailyGoalFx | null;
  readonly cardMasteredFx: CardMasteredFx | null;
  readonly fullMasteryFx: FullMasteryFx | null;
}) {
  // Renders nothing at all (not even an empty flex item) when no badge is
  // active -- session-screen.tsx's `<main>` is `flex flex-col gap-3`, so
  // an always-present empty wrapper would otherwise add a permanent extra
  // gap to every card state, even though nothing is visible.
  if (dailyGoalFx === null && cardMasteredFx === null && fullMasteryFx === null) {
    return null;
  }

  return (
    <div className="relative">
      {dailyGoalFx && (
        <div
          key={`daily-goal-${dailyGoalFx.key}`}
          role="status"
          aria-live="polite"
          style={{ top: DAILY_GOAL_TOP }}
          className={
            "pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold text-sky-800 shadow-sm dark:bg-sky-900/60 dark:text-sky-200" +
            (reducedMotion ? "" : " animate-[vb-toast-fade_2200ms_ease-in-out_forwards]")
          }
        >
          ✓ Daily Goal complete
        </div>
      )}

      {cardMasteredFx && (
        <div
          key={`card-mastered-${cardMasteredFx.key}`}
          className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2"
          style={{ top: CARD_MASTERED_TOP }}
        >
          <CardMasteredToast reducedMotion={reducedMotion} style={{ position: "static" }} />
        </div>
      )}

      {fullMasteryFx && (
        <div
          key={`full-mastery-${fullMasteryFx.key}`}
          className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2"
          style={{ top: FULL_MASTERY_TOP }}
        >
          <FullMasteryToast reducedMotion={reducedMotion} style={{ position: "static" }} />
        </div>
      )}
    </div>
  );
}
