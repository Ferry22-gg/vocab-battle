"use client";

/**
 * Phase F1 Session screen: the core "Think -> Reveal -> Self-grade ->
 * Instant feedback -> Next" loop (MVP_UI_SPEC.md section 6/16).
 *
 * Client-owned state here is limited to genuinely interactive UI concerns
 * (reveal state, the response timer, pending-submission state, transient
 * battle feedback) -- see the module boundary comment on each piece of
 * state below. Every trusted value (which card is next, battle result,
 * XP, enemy HP, queue/lifecycle state) comes from the server via
 * getNextSessionCardAction()/submitAnswer(), never computed or guessed
 * here. This component never queries an arbitrary card, and never
 * reimplements Active Pool / review-queue / cooldown / forced-reappearance
 * selection -- getNextSessionCard() is the ONLY source of "what card is
 * next" (see lib/session-ui/session-card-state.ts's module header).
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { submitAnswer } from "@/app/actions/answers";
import { getNextSessionCardAction } from "@/app/actions/sessions";
import type { NextSessionCard } from "@/app/actions/sessions";
import {
  toSessionCardUiState,
  classifySubmitAnswerError,
  type SessionCardUiState,
} from "@/lib/session-ui/session-card-state";
import type { SubmitAnswerSuccess } from "@/lib/learning/submit-answer";

const ENEMY_DISPLAY: Record<string, { emoji: string; label: string }> = {
  enemy_a: { emoji: "🦎", label: "Sprite" },
  enemy_b: { emoji: "👹", label: "Goblin" },
  enemy_c: { emoji: "🐉", label: "Drake" },
};

function enemyDisplay(enemyType: string): { emoji: string; label: string } {
  return ENEMY_DISPLAY[enemyType] ?? { emoji: "❓", label: "Enemy" };
}

/** A currently-in-flight-or-retryable grading attempt for the visible card. */
interface PendingSubmission {
  readonly clientEventId: string;
  readonly cardId: string;
  readonly correct: boolean;
  readonly responseTimeMs: number;
}

const FEEDBACK_VISIBLE_MS = 1600;

export function SessionScreen({
  sessionId,
  initialCard,
}: {
  readonly sessionId: string;
  readonly initialCard: NextSessionCard;
}) {
  const [cardState, setCardState] = useState<SessionCardUiState>(() => toSessionCardUiState(initialCard));
  const [revealed, setRevealed] = useState(false);
  const [responseTimeMs, setResponseTimeMs] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingSubmission, setPendingSubmission] = useState<PendingSubmission | null>(null);
  const [feedback, setFeedback] = useState<SubmitAnswerSuccess | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Response-time measurement start (MVP_UI_SPEC.md section 7): the
  // instant the card front is fully presented and recall can begin. A
  // ref, not state -- it is read only inside the Reveal handler, never
  // rendered, so it must not trigger/participate in re-renders.
  const frontShownAtRef = useRef<number | null>(null);
  const feedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
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
    setRevealed(false);
    setResponseTimeMs(null);
    setPendingSubmission(null);
    frontShownAtRef.current = view.kind === "card" ? performance.now() : null;
  }

  async function refetchCard() {
    const result = await getNextSessionCardAction(sessionId);
    if (!mountedRef.current) return;
    applyNextCard(result);
  }

  function handleReveal() {
    if (revealed) return;
    const startedAt = frontShownAtRef.current ?? performance.now();
    setResponseTimeMs(Math.max(0, Math.round(performance.now() - startedAt)));
    setRevealed(true);
  }

  async function handleGrade(correct: boolean) {
    if (cardState.kind !== "card" || pending || responseTimeMs === null) return;

    const card = cardState.card;
    // Reuse the same clientEventId when retrying the exact same logical
    // answer (same card + same grade choice) -- a genuinely new choice
    // (or a new card) is a new logical answer and gets a fresh id.
    const submission: PendingSubmission =
      pendingSubmission &&
      pendingSubmission.cardId === card.cardId &&
      pendingSubmission.correct === correct
        ? pendingSubmission
        : { clientEventId: crypto.randomUUID(), cardId: card.cardId, correct, responseTimeMs };

    setPending(true);
    setPendingSubmission(submission);
    setErrorMessage(null);

    const result = await submitAnswer({
      clientEventId: submission.clientEventId,
      sessionId,
      cardId: submission.cardId,
      correct: submission.correct,
      responseTimeMs: submission.responseTimeMs,
    });

    if (!mountedRef.current) return;

    if (result.ok) {
      setFeedback(result.data);
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = setTimeout(() => {
        if (mountedRef.current) setFeedback(null);
      }, FEEDBACK_VISIBLE_MS);

      setPending(false);
      setPendingSubmission(null);
      await refetchCard();
      return;
    }

    const view = classifySubmitAnswerError(result.code);
    setErrorMessage(view.message);
    setPending(false);

    if (view.requiresFreshCard) {
      await refetchCard();
    }
    // Otherwise: leave pendingSubmission/revealed/responseTimeMs intact so
    // the tester can safely retry the exact same attempt.
  }

  return (
    <div className="flex min-h-dvh flex-col bg-gradient-to-b from-indigo-50 to-zinc-50 dark:from-zinc-950 dark:to-black">
      <header className="flex items-center justify-between px-4 py-3">
        <Link
          href="/"
          className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-200/60 dark:text-zinc-400 dark:hover:bg-zinc-800/60"
        >
          ← Exit
        </Link>
        {cardState.kind === "card" && (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
            Combo x{cardState.card.combo}
          </span>
        )}
      </header>

      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col px-4 pb-8">
        {cardState.kind === "card" && (
          <BattleCard
            card={cardState.card}
            revealed={revealed}
            pending={pending}
            errorMessage={errorMessage}
            feedback={feedback}
            onReveal={handleReveal}
            onGrade={handleGrade}
          />
        )}

        {cardState.kind === "no_card" && (
          <EmptyState
            title="Nothing to study right now"
            body="Check back in a bit, or exit for now -- your progress is saved."
            onRetry={refetchCard}
          />
        )}

        {cardState.kind === "unavailable" && (
          <EmptyState
            title="Couldn't load your next card"
            body="Something went wrong. Please try again."
            onRetry={refetchCard}
          />
        )}
      </main>
    </div>
  );
}

function BattleCard({
  card,
  revealed,
  pending,
  errorMessage,
  feedback,
  onReveal,
  onGrade,
}: {
  readonly card: { enemyType: string; enemyHp: number; enemyMaxHp: number; combo: number; front: string; back: string };
  readonly revealed: boolean;
  readonly pending: boolean;
  readonly errorMessage: string | null;
  readonly feedback: SubmitAnswerSuccess | null;
  readonly onReveal: () => void;
  readonly onGrade: (correct: boolean) => void;
}) {
  const enemy = enemyDisplay(card.enemyType);
  const hpPct = card.enemyMaxHp > 0 ? Math.max(0, Math.min(100, (card.enemyHp / card.enemyMaxHp) * 100)) : 0;

  return (
    <div className="flex flex-1 flex-col">
      {/* Battle HUD -- lightweight, playful placeholder (MVP_UI_SPEC.md 3.2/10) */}
      <div className="mb-6 rounded-xl border border-zinc-200 bg-white/80 p-4 dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            {enemy.emoji} {enemy.label}
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-500">
            {card.enemyHp} / {card.enemyMaxHp} HP
          </span>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all duration-500 ease-out"
            style={{ width: `${hpPct}%` }}
          />
        </div>

        {feedback && (
          <div
            role="status"
            className="mt-3 flex flex-wrap items-center gap-2 text-sm"
            aria-live="polite"
          >
            {!feedback.correct && (
              <span className="rounded-full bg-zinc-200 px-2 py-0.5 font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                Missed
              </span>
            )}
            {feedback.correct && feedback.damage > 0 && (
              <span className="rounded-full bg-orange-100 px-2 py-0.5 font-semibold text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
                −{feedback.damage} dmg
              </span>
            )}
            {feedback.critical && (
              <span className="rounded-full bg-rose-100 px-2 py-0.5 font-bold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
                CRITICAL!
              </span>
            )}
            {feedback.enemyDefeated && (
              <span className="rounded-full bg-purple-100 px-2 py-0.5 font-semibold text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                Enemy defeated!
              </span>
            )}
            {feedback.dailyGoalJustCompleted && (
              <span className="rounded-full bg-sky-100 px-2 py-0.5 font-semibold text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                ✓ Daily Goal complete
              </span>
            )}
          </div>
        )}
      </div>

      {/* The card -- primary cognitive object (MVP_UI_SPEC.md 10). */}
      <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-zinc-200 bg-white p-8 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-600">English</p>
        <p className="mt-2 text-3xl font-semibold text-zinc-950 dark:text-zinc-50">{card.front}</p>

        {revealed && (
          <>
            <div className="my-4 h-px w-full bg-zinc-200 dark:bg-zinc-800" />
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-600">
              Japanese
            </p>
            <p className="mt-2 text-2xl font-medium text-zinc-950 dark:text-zinc-50">{card.back}</p>
          </>
        )}
      </div>

      {errorMessage && (
        <p role="alert" className="mt-3 text-center text-sm text-red-600 dark:text-red-400">
          {errorMessage}
        </p>
      )}

      <div className="mt-6">
        {!revealed ? (
          <button
            type="button"
            onClick={onReveal}
            className="w-full rounded-md bg-zinc-950 px-4 py-3 text-base font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            Reveal
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => onGrade(false)}
              disabled={pending}
              className="rounded-md border-2 border-red-300 bg-red-50 px-4 py-3 text-base font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-950/70"
            >
              Wrong
            </button>
            <button
              type="button"
              onClick={() => onGrade(true)}
              disabled={pending}
              className="rounded-md border-2 border-emerald-300 bg-emerald-50 px-4 py-3 text-base font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400 dark:hover:bg-emerald-950/70"
            >
              Correct
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-950">
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
