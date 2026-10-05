/**
 * Pure, dependency-free helpers for the Session UI (app/session/*). No
 * React, no fetch, no Supabase -- everything here is unit-testable in
 * isolation from a real browser/DB.
 *
 * Deliberately does NOT decide which card to show, or re-derive any
 * Active Pool / review-queue / cooldown / forced-reappearance rule --
 * that authority stays entirely PostgreSQL-owned via
 * getNextSessionCard()/get_next_session_card() (lib/sessions/dal.ts,
 * supabase/migrations/20260924010000_get_next_session_card.sql). This
 * module only normalizes that RPC's already-authoritative result, and a
 * submitAnswer() error code, into the small set of states the Session
 * screen actually renders.
 */

import type { NextSessionCard } from "@/lib/sessions/dal";
import type { SubmitAnswerErrorCode } from "@/lib/learning/submit-answer";

/** The subset of an "ok" NextSessionCard the Session screen renders. */
export interface SessionCardView {
  readonly sessionId: string;
  readonly sessionMode: "review" | "learning";
  readonly cardId: string;
  readonly front: string;
  readonly back: string;
  readonly enemyType: string;
  readonly enemyHp: number;
  readonly enemyMaxHp: number;
  readonly combo: number;
  /**
   * Runtime Cutover RC-D: the OPEN selection_claims id this card was
   * claimed under, for a v1 session -- `null` for a legacy card. Carried
   * back opaquely on the matching submitAnswer() call so the answer
   * commits against the exact claim that produced this displayed card.
   */
  readonly claimId: string | null;
}

/**
 * Collapses every NextSessionCard variant into what the Session screen
 * actually needs to decide what to render:
 *  - "card": a real answerable card is available.
 *  - "no_card": a normal, expected state (deck/cooldown-driven) -- not an
 *    error. The specific reason (REVIEW_QUEUE_EMPTY_PENDING_TRANSITION /
 *    LEARNING_NO_ELIGIBLE_CARDS / LEARNING_ALL_ON_COOLDOWN) is
 *    intentionally not surfaced to the UI in F1 -- MVP_UI_SPEC.md leaves
 *    "full Session summary UX" and per-reason messaging unresolved, so
 *    this uses one generic, safe, minimal message for all of them rather
 *    than inventing permanent copy per reason.
 *  - "unavailable": `not_found` and `error` are both genuine anomalies
 *    from the UI's perspective (missing/inaccessible session, or a
 *    malformed/anomalous backend state) -- collapsed into one generic,
 *    safe bucket rather than leaking internal reason codes to the
 *    tester, per the "do not leak raw DB/service-role errors" rule.
 */
export type SessionCardUiState =
  | { readonly kind: "card"; readonly card: SessionCardView }
  | { readonly kind: "no_card" }
  | { readonly kind: "unavailable" };

export function toSessionCardUiState(result: NextSessionCard): SessionCardUiState {
  switch (result.status) {
    case "ok":
      return {
        kind: "card",
        card: {
          sessionId: result.sessionId,
          sessionMode: result.sessionMode,
          cardId: result.cardId,
          front: result.front,
          back: result.back,
          enemyType: result.enemyType,
          enemyHp: result.enemyHp,
          enemyMaxHp: result.enemyMaxHp,
          combo: result.combo,
          claimId: result.claimId,
        },
      };
    case "no_card":
      return { kind: "no_card" };
    case "not_found":
    case "error":
      return { kind: "unavailable" };
  }
}

export interface SubmitAnswerErrorView {
  /** Generic, server-safe copy -- never the raw code or a DB message. */
  readonly message: string;
  /**
   * Whether recovering from this error requires refetching authoritative
   * session/card state before the next attempt -- i.e. the pending
   * attempt is void and a retry must be a genuinely new logical answer
   * with a fresh clientEventId (STALE_STATE's documented contract:
   * lib/learning/submit-answer.ts's module header, "a genuinely stale
   * snapshot means the caller must re-fetch/recompute ... and resubmit
   * with a NEW clientEventId"). When false, the exact same pending
   * attempt (same clientEventId/card/responseTimeMs) may be safely
   * retried as-is -- commit_answer_transaction()'s idempotency guarantee
   * covers that retry.
   */
  readonly requiresFreshCard: boolean;
}

const SUBMIT_ANSWER_ERROR_VIEWS: Record<SubmitAnswerErrorCode, SubmitAnswerErrorView> = {
  STALE_STATE: {
    message: "The board changed -- here's the current card.",
    requiresFreshCard: true,
  },
  NOT_FOUND_OR_INACCESSIBLE: {
    message: "Your session couldn't be found. Try exiting and resuming.",
    requiresFreshCard: true,
  },
  INVALID_INPUT: {
    message: "Something went wrong. Please try again.",
    requiresFreshCard: false,
  },
  COMMIT_FAILED: {
    message: "Something went wrong submitting your answer. Please try again.",
    requiresFreshCard: false,
  },
};

export function classifySubmitAnswerError(code: SubmitAnswerErrorCode): SubmitAnswerErrorView {
  return SUBMIT_ANSWER_ERROR_VIEWS[code];
}
