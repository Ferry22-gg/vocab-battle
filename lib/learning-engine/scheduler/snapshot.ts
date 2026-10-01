/**
 * Learning Engine v1 -- scheduler snapshot types (Phase 6A of the
 * implementation plan).
 *
 * Source of truth: the Phase 6 architecture plan (read -> decide ->
 * commit), as refined by the explicit decisions made before
 * implementation began:
 *   1. scheduler_position is a per-user-deck monotonic counter (one step
 *      per successfully committed answered question), never reset
 *      between sessions.
 *   2. lastCriticalDuePosition enables the exact (not approximated)
 *      5-global-question Critical Due guarantee (section 22.2).
 *   6. schedulerRevision is an optimistic-concurrency token: a later
 *      trusted selection/commit path must reject a decision computed
 *      against a stale revision and rerun scheduling, rather than
 *      trusting that the one submitted card happens to still be
 *      individually eligible.
 *
 * Pure type definitions only -- no DB access, no construction logic. A
 * future DAL (not Phase 6A/6B, which stays isolated and pure per
 * decision 5) is responsible for reading
 * supabase/migrations/20261002000000_learning_engine_v1_scheduler_position.sql's
 * columns and lib/learning-engine/state.ts's existing per-card columns
 * into this shape.
 */

import type { ActivePoolCardState } from "@/lib/learning-engine/state";

/**
 * One card's full scheduler-relevant state: Phase 2's card-state fields,
 * Phase 3's Active Pool fields (already composed into ActivePoolCardState),
 * plus the Phase 4 repair/relearning fields and the FSRS card needed for
 * Phase 5's Due/Near-Due classification. A strict superset of every
 * narrower per-module type used so far (DeckActivePoolCard,
 * RepairGovernanceCardState, etc.) -- those stay as the narrow,
 * independently-reusable types each module declares; this is the single
 * wide shape the Phase 6 pipeline reads from and narrows down from, not a
 * replacement for any of them.
 */
export interface SchedulableCardRow extends ActivePoolCardState {
  readonly cardId: string;

  /** Phase 4's RepairObligation, or null if this card has no pending repair (repair_pending = false). */
  readonly repairObligation: import("@/lib/learning-engine/repair-scheduler").RepairObligation | null;

  /**
   * The card's current ts-fsrs Card (via lib/learning-engine/fsrs/
   * adapter.ts's progressToFsrsCard), for Phase 5's deriveRetrievability/
   * due-classification. Only meaningful for poolStatus === "OUTSIDE"
   * cards; present for every row regardless, since a card's FSRS columns
   * always have *some* value (even a never-reviewed card converts via
   * createEmptyCard) -- callers restrict to OUTSIDE cards before using
   * it for Due/Near-Due purposes, the same precondition Phase 5's own
   * functions already enforce.
   */
  readonly fsrsCard: import("ts-fsrs").Card;
}

/** Per (user, deck) scheduler-level state -- supabase/migrations/20261002000000_learning_engine_v1_scheduler_position.sql's new columns, plus the Phase 1 fields the scheduler also needs. */
export interface DeckSchedulerState {
  readonly desiredRetention: number;
  readonly policyVersion: string;
  readonly hasAchievedFullMastery: boolean;
  readonly masteredCount: number;
  /** Decision 1: per-user-deck monotonic draw counter, never reset between sessions. */
  readonly schedulerPosition: number;
  /** Decision 2: null until the first-ever Critical Due force-selection for this deck. */
  readonly lastCriticalDuePosition: number | null;
  /** Decision 6: optimistic-concurrency token for the whole snapshot. */
  readonly schedulerRevision: number;
}

export interface DailyGoalSnapshot {
  readonly enemiesDefeatedToday: number;
  readonly completed: boolean;
}

/**
 * Everything one scheduler decision (lib/learning-engine/scheduler/
 * next-card.ts, Phase 6E) needs. Must be freshly read before EVERY card
 * presentation -- never cached or reused across draws -- so that
 * due_count and every position-gated eligibility check are naturally
 * re-evaluated per-draw (section 20: "Re-evaluate before every ordinary
 * card selection") without any module needing its own staleness logic.
 */
export interface DeckSchedulerSnapshot {
  readonly userId: string;
  readonly deckId: string;
  readonly now: Date;
  readonly deckState: DeckSchedulerState;
  readonly dailyGoal: DailyGoalSnapshot;
  readonly cards: readonly SchedulableCardRow[];
}
