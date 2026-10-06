/**
 * Learning Engine v1 -- Runtime Cutover RC-C: the pure answer-preparation
 * helper, `prepareLearningEngineAnswer`.
 *
 * Source of truth: the RC-C task brief section 6 ("pure TypeScript answer
 * preparation"), composing -- never duplicating -- every already-reviewed
 * Phase 2/4/5/battle primitive:
 *   - lib/learning-engine/transitions.ts (Phase 2, plus the RC-C
 *     spec-gap-correction additions) for every card_status/learning_stage/
 *     relearning_phase transition;
 *   - lib/learning-engine/repair-scheduler.ts (Phase 4, plus the RC-C
 *     additions) for repair-obligation creation/resolution;
 *   - lib/learning-engine/fsrs/lifecycle.ts (Phase 5) for every FSRS-
 *     touching Correct/Wrong;
 *   - lib/learning/battle.ts's calculateBattleResult (unchanged) for the
 *     Battle result -- memory-state transitions above never depend on it,
 *     and it never depends on them (section 1.3/24 of the spec).
 *
 * Pure throughout: no database access, no generated ids, no `Date.now()`
 * (the caller supplies `now`), no mutation of input. The only randomness
 * is the injected RandomSource, used exclusively for sampling a fresh
 * repair window (createRepairObligation) -- never for anything FSRS/
 * Battle-related, which have their own separate RNG/clock story.
 *
 * ---------------------------------------------------------------------
 * Dispatch key: selectionReason, not card_status alone
 * ---------------------------------------------------------------------
 * Per the brief's own warning (section 8): `repair_target`/`repair_hard_cap`
 * can mean either the ordinary within-day repair mechanism (card_status
 * LEARNING) or the relearning one (card_status FORGOTTEN) -- this module
 * branches on `cardState.cardStatus` ONLY within that one selectionReason
 * family, exactly where the spec itself requires it, never as a
 * standalone heuristic replacing selectionReason.
 *
 * ---------------------------------------------------------------------
 * What this module deliberately does NOT compute
 * ---------------------------------------------------------------------
 * - scheduler_revision: a pure optimistic-concurrency token with no
 *   Learning Engine policy content -- the trusted DB layer increments it
 *   directly from its own locked value (RC-C pre-check A).
 * - active_draws_since_eligible: exclusively a claim-time concern since
 *   the RC-B correction (RC-C pre-check B) -- this module never touches
 *   it, and the trusted answer-commit transaction must not either.
 * - mastered_count / has_achieved_full_mastery: these need the WHOLE
 *   deck's live card set, which this single-card module has no visibility
 *   into -- the trusted DB layer recomputes both as a live aggregate at
 *   commit time (see that migration's own header for why a live recompute,
 *   not an incremental delta, is the correct answer-time contract).
 * - same_day_seen_count/same_day_wrong_count/first_presented_at/
 *   last_seen_at/last_answer_at: Asia/Tokyo-day-scoped bookkeeping
 *   arithmetic with no Learning Engine policy content -- handled in SQL,
 *   mirroring the existing daily_user_stats day-row pattern.
 * - cards_since_last_seen/seconds_since_last_seen and every other review-
 *   event telemetry field: lib/learning-engine/telemetry/review-event.ts's
 *   buildReviewEvent already computes these from this module's
 *   cardStateBefore/After plus context the orchestration layer already
 *   has -- not duplicated here.
 * - Daily Goal / streak / XP persistence and the correct_answer/
 *   enemy_defeated/daily_goal_completed XP amounts: Game Economy
 *   bookkeeping with no Learning Engine policy content, mirroring the
 *   existing commit_answer_transaction()'s own established arithmetic
 *   exactly -- handled in SQL. This module DOES compute the one XP
 *   component that genuinely depends on Learning Engine lifecycle
 *   knowledge no SQL layer should re-derive: whether a Mastery milestone
 *   (+15) occurred this answer, and under which of the two reasons.
 */

import type { Card, Grade } from "ts-fsrs";

import { applyFirstPresentation, applyNormalCorrect, applySpacedCorrect, applyWrong } from "@/lib/learning-engine/transitions";
import {
  createRepairObligation,
  resolveOrdinaryRepairCorrect,
  resolveOrdinaryRepairWrong,
  resolveRelearningRepairCorrect,
  resolveRelearningRepairWrong,
  resolveSpacedConfirmationWrong,
  type RandomSource,
  type RepairObligation,
} from "@/lib/learning-engine/repair-scheduler";
import { applyCorrectCooldown } from "@/lib/learning-engine/active-priority";
import {
  resolveLongTermWrong,
  resolveNearDueCorrect,
  resolveQualifyingFsrsCorrect,
  resolveRandomMasteredCorrect,
  resolveRandomMasteredWrong,
} from "@/lib/learning-engine/fsrs/lifecycle";
import type { UserCardProgressFsrsUpdate } from "@/lib/learning-engine/fsrs/adapter";
import { shouldShowCardMasteredToast } from "@/lib/learning-engine/progress/notifications";
import { calculateBattleResult, type BattleCalculationResult } from "@/lib/learning/battle";
import type { LearningEngineCardState } from "@/lib/learning-engine/state";
import type { SelectionReason } from "@/lib/learning-engine/scheduler/next-card";

export type { RandomSource };

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`prepare-answer: ${message}`);
  }
}

export interface PrepareLearningEngineAnswerInput {
  readonly cardId: string;
  /** The authoritative pre-answer card state (section 29.1 fields this module reads/writes). */
  readonly cardState: LearningEngineCardState;
  /** The authoritative pre-answer ts-fsrs Card -- only read for an FSRS-touching path (due/near-due/random-mastered). */
  readonly fsrsCard: Card;
  /** The claim's own SelectionTrace.selectionReason -- the dispatch key (see module header). */
  readonly selectionReason: SelectionReason;
  readonly desiredRetention: number;
  /** claim.schedulerPosition + 1 -- the position this committed answer occupies. Already deterministic from already-trusted claim data; no DB round-trip needed to compute it. */
  readonly newSchedulerPosition: number;
  readonly correct: boolean;
  readonly responseTimeMs: number;
  readonly comboBefore: number;
  readonly enemyHpBefore: number;
  /** Used exclusively for a fresh repair-obligation sample (never FSRS/Battle). */
  readonly random: RandomSource;
  readonly now: Date;
}

export interface PrepareLearningEngineAnswerResult {
  readonly cardStateBefore: LearningEngineCardState;
  readonly cardStateAfter: LearningEngineCardState;
  /** Null when this path never touches FSRS (every ordinary Active/repair/spaced-confirmation path) -- the trusted DB layer must store NULL for the FSRS review fields on this answer, never a fabricated value. */
  readonly fsrsUpdate: UserCardProgressFsrsUpdate | null;
  readonly fsrsGrade: Grade | null;
  /** The complete repair-obligation state after this answer -- null means no obligation is pending (whether none ever existed, or this answer's Correct just resolved one). Never a partial obligation. */
  readonly repairObligationAfter: RepairObligation | null;
  /** The normal-Correct-cooldown gate after this answer -- null means none is in force (accurate for every non-ordinary-Active-Correct path, not merely "unchanged"). */
  readonly correctCooldownUntilPositionAfter: number | null;
  /** True exactly when this answer's claim was selected via the Critical Due interrupt -- presentation-gated, not correctness-gated (section 22.2). */
  readonly shouldUpdateLastCriticalDuePosition: boolean;
  /** The Phase 9 Card-Mastered notification signal (section 15.2) -- true ONLY on the exact ACQUIRED -> LEARNED transition, never on a FORGOTTEN -> LEARNED restoration (shouldShowCardMasteredToast's own, already-reviewed scope -- see masteryXp below for the broader XP-eligible transition). */
  readonly cardMasteredJustNow: boolean;
  /** The Mastery XP milestone (+15, section 23) -- fires on ANY transition INTO LEARNED from a non-LEARNED status, distinguishing first-time mastery from FORGOTTEN restoration. Null when no such transition occurred this answer. */
  readonly masteryXp: { readonly amount: 15; readonly reason: "card_learned" | "card_relearned" } | null;
  readonly battle: BattleCalculationResult;
}

const ORDINARY_ACTIVE_REASONS: ReadonlySet<SelectionReason> = new Set([
  "active_first_pass",
  "active_starvation",
  "active_weighted_selection",
  "emergency_cooldown_relaxation",
]);

const MASTERY_XP_AMOUNT = 15;

/** Section 19/23: fires on any before != LEARNED -> after === LEARNED transition, distinguishing first-time mastery (card_learned) from a previously-mastered FORGOTTEN card's restoration (card_relearned) -- mirrors commit_answer_transaction()'s own v_mastery_xp_reason arithmetic exactly. */
function computeMasteryXp(
  before: LearningEngineCardState,
  after: LearningEngineCardState,
): { readonly amount: 15; readonly reason: "card_learned" | "card_relearned" } | null {
  if (after.cardStatus !== "LEARNED" || before.cardStatus === "LEARNED") {
    return null;
  }
  return { amount: MASTERY_XP_AMOUNT, reason: before.cardStatus === "FORGOTTEN" ? "card_relearned" : "card_learned" };
}

/**
 * The pure Learning Engine v1 answer-preparation function (RC-C section 6).
 * Never throws for a well-formed input matching its own claimed
 * selectionReason/cardStatus combination; the `invariant` calls below guard
 * states that would mean an upstream caller passed an answer context that
 * does not match the claim it came from, not states expected in practice.
 */
export function prepareLearningEngineAnswer(input: PrepareLearningEngineAnswerInput): PrepareLearningEngineAnswerResult {
  const { cardId, cardState, fsrsCard, selectionReason, desiredRetention, newSchedulerPosition, correct, random, now } = input;

  const battle = calculateBattleResult({
    correct,
    responseTimeMs: input.responseTimeMs,
    comboBefore: input.comboBefore,
    enemyHpBefore: input.enemyHpBefore,
    random,
  });

  const shouldUpdateLastCriticalDuePosition = selectionReason === "critical_due_interrupt";

  let cardStateAfter: LearningEngineCardState;
  let fsrsUpdate: UserCardProgressFsrsUpdate | null = null;
  let fsrsGrade: Grade | null = null;
  let repairObligationAfter: RepairObligation | null = null;
  let correctCooldownUntilPositionAfter: number | null = null;

  // ===========================================================================
  // Ordinary within-day Active (sections 9-12): NEW first presentation,
  // ordinary FRESH/LEARNING_1/LEARNING_2 Correct/Wrong. Never repair-
  // governed by construction (selectOrdinaryActiveCandidates already
  // excludes those cards) -- repairPending === false is asserted, not
  // branched on.
  // ===========================================================================
  if (ORDINARY_ACTIVE_REASONS.has(selectionReason)) {
    invariant(!cardState.repairPending, `ordinary Active selectionReason "${selectionReason}" requires repairPending === false`);
    const presentedState = cardState.cardStatus === "NEW" ? applyFirstPresentation(cardState) : cardState;

    if (correct) {
      cardStateAfter = applyNormalCorrect(presentedState);
      correctCooldownUntilPositionAfter = applyCorrectCooldown(newSchedulerPosition);
    } else {
      cardStateAfter = applyWrong(presentedState);
      repairObligationAfter = createRepairObligation({ cardId, wrongPosition: newSchedulerPosition, random });
    }
  }

  // ===========================================================================
  // Repair retry (sections 12.2/12.5, 13/13.2): within-day (LEARNING) or
  // relearning (FORGOTTEN). Dispatches on cardStatus WITHIN this reason
  // family only, per the module header.
  //
  // Approved RC-F small-deck audit follow-up: emergency_repair_relaxation
  // (the Repair liveness fallback, scheduler/next-card.ts) joins this
  // branch too, but ONLY for the repair-obligation shape it can actually
  // produce (not SPACED_CONFIRMATION_PENDING -- see the next branch
  // below). It is not a new transition family: a card released early by
  // that fallback is still, structurally, a normal within-day or
  // relearning repair-governed card (repairPending/relearningPhase
  // unchanged by the fallback itself), so it is resolved by the exact
  // same functions an ordinary repair_target/repair_hard_cap presentation
  // already uses -- "preserve its identity as a Repair/relearning
  // presentation" is satisfied by reuse, not a parallel implementation.
  // ===========================================================================
  else if (
    selectionReason === "repair_target" ||
    selectionReason === "repair_hard_cap" ||
    (selectionReason === "emergency_repair_relaxation" && cardState.relearningPhase !== "SPACED_CONFIRMATION_PENDING")
  ) {
    if (cardState.cardStatus === "LEARNING") {
      if (correct) {
        const result = resolveOrdinaryRepairCorrect(cardState, newSchedulerPosition);
        cardStateAfter = result.cardState;
        correctCooldownUntilPositionAfter = result.nextCorrectCooldownUntilPosition;
      } else {
        const result = resolveOrdinaryRepairWrong({ cardState, cardId, wrongPosition: newSchedulerPosition, random });
        cardStateAfter = result.cardState;
        repairObligationAfter = result.repairObligation;
      }
    } else {
      invariant(
        cardState.cardStatus === "FORGOTTEN" && cardState.relearningPhase === "REPAIR_PENDING",
        `repair-retry selectionReason "${selectionReason}" requires cardStatus LEARNING, or FORGOTTEN with relearningPhase REPAIR_PENDING`,
      );
      if (correct) {
        const result = resolveRelearningRepairCorrect(cardState, newSchedulerPosition);
        cardStateAfter = { ...result.cardState, ...result.clearedRepairFields };
        correctCooldownUntilPositionAfter = result.nextCorrectCooldownUntilPosition;
      } else {
        const result = resolveRelearningRepairWrong({ cardState, cardId, wrongPosition: newSchedulerPosition, random });
        cardStateAfter = result.cardState;
        repairObligationAfter = result.repairObligation;
      }
    }
  }

  // ===========================================================================
  // Spaced Confirmation (sections 13/13.2): FORGOTTEN + SPACED_CONFIRMATION_PENDING.
  //
  // Approved RC-F small-deck audit follow-up: emergency_repair_relaxation
  // also joins this branch when the released card is a
  // SPACED_CONFIRMATION_PENDING one (the other shape the Repair liveness
  // fallback can rescue) -- same reuse rationale as the branch above.
  // ===========================================================================
  else if (
    selectionReason === "spaced_confirmation" ||
    (selectionReason === "emergency_repair_relaxation" && cardState.relearningPhase === "SPACED_CONFIRMATION_PENDING")
  ) {
    invariant(
      cardState.cardStatus === "FORGOTTEN" && cardState.relearningPhase === "SPACED_CONFIRMATION_PENDING",
      `selectionReason "spaced_confirmation" requires cardStatus FORGOTTEN and relearningPhase SPACED_CONFIRMATION_PENDING`,
    );
    if (correct) {
      cardStateAfter = applySpacedCorrect(cardState);
    } else {
      const result = resolveSpacedConfirmationWrong({ cardState, cardId, wrongPosition: newSchedulerPosition, random });
      cardStateAfter = result.cardState;
      repairObligationAfter = result.repairObligation;
    }
  }

  // ===========================================================================
  // Long-term FSRS: FSRS_DUE (ordinary or Critical Due), NEAR_DUE, and
  // RANDOM_MASTERED all share the identical Wrong mechanics (section
  // 16.3/25's own "do not create a second Relearning/lapse implementation");
  // only the Correct mechanics differ by source (qualifying vs. weaker
  // evidence).
  // ===========================================================================
  else if (
    selectionReason === "due_weighted_selection" ||
    selectionReason === "critical_due_interrupt" ||
    selectionReason === "near_due_weighted_selection" ||
    selectionReason === "random_mastered_shuffle_bag"
  ) {
    invariant(
      cardState.cardStatus === "ACQUIRED" || cardState.cardStatus === "LEARNED",
      `selectionReason "${selectionReason}" requires cardStatus ACQUIRED or LEARNED, got ${cardState.cardStatus}`,
    );
    invariant(cardState.poolStatus === "OUTSIDE", `selectionReason "${selectionReason}" requires poolStatus OUTSIDE`);

    if (correct) {
      const result =
        selectionReason === "due_weighted_selection" || selectionReason === "critical_due_interrupt"
          ? resolveQualifyingFsrsCorrect({ card: fsrsCard, cardState, now, desiredRetention })
          : selectionReason === "near_due_weighted_selection"
            ? resolveNearDueCorrect({ card: fsrsCard, cardState, now, desiredRetention })
            : resolveRandomMasteredCorrect({ card: fsrsCard, cardState, now, desiredRetention });
      cardStateAfter = result.cardState;
      fsrsUpdate = result.fsrsUpdate;
      fsrsGrade = result.grade;
    } else {
      const result =
        selectionReason === "random_mastered_shuffle_bag"
          ? resolveRandomMasteredWrong({ card: fsrsCard, cardState, now, desiredRetention })
          : resolveLongTermWrong({ card: fsrsCard, cardState, now, desiredRetention });
      cardStateAfter = { ...result.cardState, repairPending: true };
      fsrsUpdate = result.fsrsUpdate;
      fsrsGrade = result.grade;
      repairObligationAfter = createRepairObligation({ cardId, wrongPosition: newSchedulerPosition, random });
    }
  } else {
    invariant(false, `unhandled selectionReason "${selectionReason}" -- no answerable claim should ever report "no_card_all_unavailable"`);
  }

  return {
    cardStateBefore: cardState,
    cardStateAfter,
    fsrsUpdate,
    fsrsGrade,
    repairObligationAfter,
    correctCooldownUntilPositionAfter,
    shouldUpdateLastCriticalDuePosition,
    cardMasteredJustNow: shouldShowCardMasteredToast(cardState.cardStatus, cardStateAfter.cardStatus),
    masteryXp: computeMasteryXp(cardState, cardStateAfter),
    battle,
  };
}
