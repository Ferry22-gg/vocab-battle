"use client";

/**
 * Phase P2 Session screen: the core "Think -> Reveal -> Self-grade ->
 * Instant feedback -> Next" loop (MVP_UI_SPEC.md section 6/16), restyled
 * per the P2 Session UX Polish spec into the mobile-first battle layout
 * (top ~30-35% battle zone / middle flashcard / bottom thumb zone), with a
 * real flip, a shared Reveal<->grade interaction zone guarded against
 * accidental double-taps, restrained non-blocking battle feedback, and
 * lightweight synthesized sound.
 *
 * Client-owned state here is limited to genuinely interactive UI concerns
 * (reveal-guard phase, the response timer, pending-submission state,
 * transient battle FX) -- see the module boundary comment on each piece of
 * state below. Every trusted value (which card is next, battle result,
 * XP, enemy HP, queue/lifecycle state) comes from the server via
 * getNextSessionCardAction()/submitAnswer(), never computed or guessed
 * here. This component never queries an arbitrary card, and never
 * reimplements Active Pool / review-queue / cooldown / forced-reappearance
 * selection -- getNextSessionCard() is the ONLY source of "what card is
 * next" (see lib/session-ui/session-card-state.ts's module header).
 */

import { useEffect, useReducer, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { submitAnswer } from "@/app/actions/answers";
import { getNextSessionCardAction } from "@/app/actions/sessions";
import type { NextSessionCard } from "@/app/actions/sessions";
import {
  toSessionCardUiState,
  classifySubmitAnswerError,
  type SessionCardUiState,
  type SessionCardView,
} from "@/lib/session-ui/session-card-state";
import {
  revealGuardReducer,
  initialRevealGuardState,
  canGrade,
} from "@/lib/session-ui/reveal-guard";
import { getEnemyVisual } from "@/lib/session-ui/enemies";
import { deriveComboEvent } from "@/lib/session-ui/combo-events";
import { usePrefersReducedMotion } from "@/lib/session-ui/reduced-motion";
import { sessionSounds } from "@/lib/session-ui/sound";
import { FlashCard } from "./flash-card";
import { ActionZone } from "./action-zone";
import { BattleScene, type ComboFx, type DailyGoalFx, type DefeatFx, type HitFx } from "./battle-scene";

/** A currently-in-flight-or-retryable grading attempt for the visible card. */
interface PendingSubmission {
  readonly clientEventId: string;
  readonly cardId: string;
  readonly correct: boolean;
  readonly responseTimeMs: number;
}

/** How long each transient battle-feedback element stays on screen before it's removed -- matched 1:1 to that element's own CSS animation duration in battle-scene.tsx so removal never clips the animation. */
const HIT_FX_MS = 700;
const COMBO_FX_MS = 1400;
const DEFEAT_FX_MS = 450;
const DAILY_GOAL_FX_MS = 2200;

export function SessionScreen({
  sessionId,
  initialCard,
}: {
  readonly sessionId: string;
  readonly initialCard: NextSessionCard;
}) {
  const [cardState, setCardState] = useState<SessionCardUiState>(() => toSessionCardUiState(initialCard));
  const [guardState, dispatchGuard] = useReducer(revealGuardReducer, initialRevealGuardState);
  const [responseTimeMs, setResponseTimeMs] = useState<number | null>(null);
  const [pendingSubmission, setPendingSubmission] = useState<PendingSubmission | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [hitFx, setHitFx] = useState<HitFx | null>(null);
  const [comboFx, setComboFx] = useState<ComboFx | null>(null);
  const [defeatFx, setDefeatFx] = useState<DefeatFx | null>(null);
  const [dailyGoalFx, setDailyGoalFx] = useState<DailyGoalFx | null>(null);

  const reducedMotion = usePrefersReducedMotion();

  // Response-time measurement start (MVP_UI_SPEC.md section 7): the
  // instant the card front is fully presented and recall can begin. A
  // ref, not state -- it is read only inside the Reveal handler, never
  // rendered, so it must not trigger/participate in re-renders.
  const frontShownAtRef = useRef<number | null>(null);
  const fxKeyRef = useRef(0);
  const hitFxTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const comboFxTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const defeatFxTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dailyGoalFxTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      [hitFxTimeoutRef, comboFxTimeoutRef, defeatFxTimeoutRef, dailyGoalFxTimeoutRef].forEach((ref) => {
        if (ref.current) clearTimeout(ref.current);
      });
    };
  }, []);

  // Starts the timer for the server-provided initial card. Client-side
  // only (performance.now() has no meaningful server-side equivalent for
  // "ready for recall on this device").
  useEffect(() => {
    if (cardState.kind === "card") {
      frontShownAtRef.current = performance.now();
    }
    // Only the very first card -- every subsequent card transition sets
    // this directly inside its own async handler below, not via effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyNextCard(result: NextSessionCard) {
    const view = toSessionCardUiState(result);
    setCardState(view);
    setResponseTimeMs(null);
    setPendingSubmission(null);
    dispatchGuard({ type: "RESET" });
    frontShownAtRef.current = view.kind === "card" ? performance.now() : null;
  }

  async function refetchCard() {
    const result = await getNextSessionCardAction(sessionId);
    if (!mountedRef.current) return;
    applyNextCard(result);
  }

  function handleReveal() {
    const startedAt = frontShownAtRef.current ?? performance.now();
    setResponseTimeMs(Math.max(0, Math.round(performance.now() - startedAt)));
    dispatchGuard({ type: "REVEAL" });
    sessionSounds.reveal();
  }

  function handleFlipDone() {
    dispatchGuard({ type: "FLIP_DONE" });
  }

  function scheduleFx<T>(
    ref: RefObject<ReturnType<typeof setTimeout> | null>,
    setter: (value: T | null) => void,
    value: T,
    ms: number,
  ) {
    if (ref.current) clearTimeout(ref.current);
    ref.current = setTimeout(() => {
      if (mountedRef.current) setter(null);
    }, ms);
    setter(value);
  }

  async function handleGrade(correct: boolean) {
    if (cardState.kind !== "card" || !canGrade(guardState) || responseTimeMs === null) return;

    const card: SessionCardView = cardState.card;
    // Reuse the same clientEventId when retrying the exact same logical
    // answer (same card + same grade choice) -- a genuinely new choice
    // (or a new card) is a new logical answer and gets a fresh id.
    const submission: PendingSubmission =
      pendingSubmission &&
      pendingSubmission.cardId === card.cardId &&
      pendingSubmission.correct === correct
        ? pendingSubmission
        : { clientEventId: crypto.randomUUID(), cardId: card.cardId, correct, responseTimeMs };

    dispatchGuard({ type: "GRADE_SUBMIT" });
    setPendingSubmission(submission);
    setErrorMessage(null);

    const comboBefore = card.combo;
    const enemyVisualBefore = getEnemyVisual(card.enemyType);

    const result = await submitAnswer({
      clientEventId: submission.clientEventId,
      sessionId,
      cardId: submission.cardId,
      correct: submission.correct,
      responseTimeMs: submission.responseTimeMs,
    });

    if (!mountedRef.current) return;

    if (result.ok) {
      const data = result.data;
      const fxKey = ++fxKeyRef.current;

      if (data.correct) {
        scheduleFx(hitFxTimeoutRef, setHitFx, { key: fxKey, damage: data.damage, critical: data.critical }, HIT_FX_MS);
        if (data.critical) {
          sessionSounds.critical();
        } else {
          sessionSounds.correct();
        }

        if (deriveComboEvent(comboBefore, data.comboAfter)) {
          scheduleFx(comboFxTimeoutRef, setComboFx, { key: fxKey }, COMBO_FX_MS);
        }
      } else {
        sessionSounds.wrong();
      }

      if (data.enemyDefeated) {
        sessionSounds.defeat();
        if (enemyVisualBefore) {
          scheduleFx(defeatFxTimeoutRef, setDefeatFx, { key: fxKey, visual: enemyVisualBefore }, DEFEAT_FX_MS);
        }
      }

      if (data.dailyGoalJustCompleted) {
        scheduleFx(dailyGoalFxTimeoutRef, setDailyGoalFx, { key: fxKey }, DAILY_GOAL_FX_MS);
      }

      dispatchGuard({ type: "GRADE_RESULT", retry: false });
      setPendingSubmission(null);
      await refetchCard();
      return;
    }

    const view = classifySubmitAnswerError(result.code);
    setErrorMessage(view.message);

    if (view.requiresFreshCard) {
      dispatchGuard({ type: "GRADE_RESULT", retry: false });
      await refetchCard();
    } else {
      // Safe to retry the exact same attempt -- back to "ready" rather than
      // resetting the card, so the tester's revealed state/timer survive.
      dispatchGuard({ type: "GRADE_RESULT", retry: true });
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50 dark:bg-black">
      <header className="flex items-center px-4 py-3">
        <Link
          href="/"
          className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-200/60 dark:text-zinc-400 dark:hover:bg-zinc-800/60"
        >
          ← Exit
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-sm flex-1 min-h-0 flex-col justify-center gap-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {cardState.kind === "card" && (
          <>
            <BattleScene
              enemy={getEnemyVisual(cardState.card.enemyType)}
              hp={cardState.card.enemyHp}
              maxHp={cardState.card.enemyMaxHp}
              reducedMotion={reducedMotion}
              hitFx={hitFx}
              comboFx={comboFx}
              defeatFx={defeatFx}
              dailyGoalFx={dailyGoalFx}
            />

            <FlashCard
              front={cardState.card.front}
              back={cardState.card.back}
              revealed={guardState.phase !== "idle"}
              reducedMotion={reducedMotion}
              onFlipDone={handleFlipDone}
            />

            {errorMessage && (
              <p role="alert" className="text-center text-sm text-red-600 dark:text-red-400">
                {errorMessage}
              </p>
            )}

            <ActionZone guardState={guardState} onReveal={handleReveal} onGrade={handleGrade} />
          </>
        )}

        {cardState.kind === "no_card" && (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              title="Nothing to study right now"
              body="Check back in a bit, or exit for now -- your progress is saved."
              onRetry={refetchCard}
            />
          </div>
        )}

        {cardState.kind === "unavailable" && (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              title="Couldn't load your next card"
              body="Something went wrong. Please try again."
              onRetry={refetchCard}
            />
          </div>
        )}
      </main>
    </div>
  );
}

function EmptyState({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }) {
  return (
    <div className="flex w-full flex-col items-center justify-center rounded-xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">{title}</p>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{body}</p>
      <div className="mt-6 flex w-full flex-col gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="w-full rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          Check again
        </button>
        <Link
          href="/"
          className="w-full rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
        >
          Back to Home
        </Link>
      </div>
    </div>
  );
}
