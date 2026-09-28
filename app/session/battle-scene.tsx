"use client";

/**
 * The battle/enemy zone -- the top ~30-35% of the Session screen (P2 spec,
 * "Session layout" + "Enemies" + "Enemy HP" + "Correct/Wrong feedback" +
 * "Combo" + "Critical" + "Enemy defeat" + "Daily goal/level-up events").
 *
 * Renders purely from props. All feedback here is transient and
 * non-blocking -- nothing in this component can delay or gate the next
 * card (MVP_UI_SPEC.md 2.3); the parent (session-screen.tsx) owns every
 * timer that clears these transient bits of state.
 */

import Image from "next/image";
import type { EnemyVisual } from "@/lib/session-ui/enemies";
import { clampHpPercent } from "@/lib/session-ui/hp";

export interface HitFx {
  readonly key: number;
  readonly damage: number;
  readonly critical: boolean;
}

export interface ComboFx {
  readonly key: number;
}

export interface DefeatFx {
  readonly key: number;
  readonly visual: EnemyVisual;
}

export interface DailyGoalFx {
  readonly key: number;
}

export function BattleScene({
  enemy,
  hp,
  maxHp,
  reducedMotion,
  hitFx,
  comboFx,
  defeatFx,
  dailyGoalFx,
}: {
  readonly enemy: EnemyVisual | null;
  readonly hp: number;
  readonly maxHp: number;
  readonly reducedMotion: boolean;
  readonly hitFx: HitFx | null;
  readonly comboFx: ComboFx | null;
  readonly defeatFx: DefeatFx | null;
  readonly dailyGoalFx: DailyGoalFx | null;
}) {
  const percent = clampHpPercent(hp, maxHp);

  return (
    <div
      className="relative flex shrink-0 flex-col items-center justify-end"
      style={{ minHeight: "clamp(232px, 37vh, 320px)" }}
    >
      {dailyGoalFx && (
        <div
          key={`daily-goal-${dailyGoalFx.key}`}
          role="status"
          aria-live="polite"
          className={
            "pointer-events-none absolute top-1 z-10 rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold text-sky-800 shadow-sm dark:bg-sky-900/60 dark:text-sky-200" +
            (reducedMotion ? "" : " animate-[vb-toast-fade_2200ms_ease-in-out_forwards]")
          }
        >
          ✓ Daily Goal complete
        </div>
      )}

      <div className="relative flex flex-1 items-end justify-center">
        {enemy && (
          <div style={{ width: enemy.sizePx, height: enemy.sizePx }} className="relative select-none">
            <Image
              src={enemy.src}
              alt={enemy.label}
              fill
              sizes={`${enemy.sizePx}px`}
              className="object-contain"
              preload
            />
          </div>
        )}

        {defeatFx && (
          <div
            key={`defeat-${defeatFx.key}`}
            aria-hidden="true"
            className={
              "pointer-events-none absolute" +
              (reducedMotion ? "" : " animate-[vb-pop-fade_450ms_ease-in_forwards]")
            }
            style={{ width: defeatFx.visual.sizePx, height: defeatFx.visual.sizePx }}
          >
            <Image
              src={defeatFx.visual.src}
              alt=""
              fill
              sizes={`${defeatFx.visual.sizePx}px`}
              className="object-contain"
            />
          </div>
        )}

        {hitFx && (
          <div
            key={`hit-${hitFx.key}`}
            aria-hidden="true"
            className={
              "pointer-events-none absolute top-0 flex flex-col items-center" +
              (reducedMotion ? "" : " animate-[vb-float-fade_700ms_ease-out_forwards]")
            }
          >
            {hitFx.critical && (
              <span className="text-xs font-bold tracking-wide text-rose-600 dark:text-rose-400">
                CRITICAL!
              </span>
            )}
            <span
              className={
                hitFx.critical
                  ? "text-2xl font-extrabold text-rose-600 dark:text-rose-400"
                  : "text-lg font-semibold text-orange-600 dark:text-orange-400"
              }
            >
              −{hitFx.damage}
            </span>
          </div>
        )}

        {comboFx && (
          <div
            key={`combo-${comboFx.key}`}
            aria-hidden="true"
            className={
              "pointer-events-none absolute -top-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800 dark:bg-amber-900/60 dark:text-amber-200" +
              (reducedMotion ? "" : " animate-[vb-toast-fade_1400ms_ease-in-out_forwards]")
            }
          >
            COMBO UP!
          </div>
        )}
      </div>

      <div className="w-full max-w-56 px-2 pb-1">
        <div
          role="progressbar"
          aria-label="Enemy health"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
        >
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    </div>
  );
}
