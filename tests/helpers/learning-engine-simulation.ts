/**
 * Learning Engine v1 -- TEST-ONLY deterministic scheduler simulation
 * harness (Phase 6F).
 *
 * This is NOT a second scheduler and NOT a second source-selection
 * algorithm. It is a thin, pure, in-memory "commit layer" standing in for
 * the future trusted runtime cutover (lib/learning-engine/scheduler/
 * next-card.ts's own header: "Runtime cutover... happens later as one
 * coordinated change"). Every actual scheduling decision still comes from
 * chooseNextCard(); every state transition applied here reuses an
 * existing Phase 2/4/5 pure function verbatim. This file only answers
 * "given a NextCardDecision and a scripted Correct/Wrong outcome, what is
 * the next simulated DeckSchedulerSnapshot" -- the minimum bookkeeping
 * needed to run chooseNextCard in a loop and observe long-run behavior.
 *
 * ---------------------------------------------------------------------
 * Resolved (RC-C): a Wrong on a repair retry / spaced-confirmation retry
 * ---------------------------------------------------------------------
 * Previously a flagged gap (the spec described the Correct path for a
 * repair/spaced-confirmation retry but not a Wrong one, and this harness
 * threw rather than guess). Now locked as normative
 * (docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 12.2/13): a Wrong
 * on an already-pending repair retry replaces the old obligation with a
 * fresh one anchored at the current Wrong position, without advancing or
 * regressing the acquisition stage; a Wrong on Spaced Confirmation falls
 * back to REPAIR_PENDING with a fresh obligation. This harness now
 * exercises the real production composition
 * (lib/learning-engine/repair-scheduler.ts's resolveOrdinaryRepairWrong/
 * resolveRelearningRepairWrong/resolveSpacedConfirmationWrong) rather than
 * inventing its own -- see applyRepairRetryWrong/
 * applySpacedConfirmationWrongAnswer below.
 *
 * ---------------------------------------------------------------------
 * Bookkeeping decisions made here (documented, not left implicit)
 * ---------------------------------------------------------------------
 * - schedulerPosition advances by exactly 1 per COMMITTED ANSWERED
 *   question (decision.cardId !== null) -- never for a
 *   `no_card_all_unavailable` decision, which answered nothing.
 * - schedulerRevision advances by 1 on every decision this harness
 *   applies, including a no-card one -- modeling "a trusted commit
 *   occurred for this draw" even when no card was presented.
 * - lastCriticalDuePosition updates to the NEW (post-increment) position
 *   whenever selectionReason === "critical_due_interrupt" -- a
 *   PRESENTATION event, independent of whether the answer was correct
 *   (matches position.ts's own "the position... of the last Critical Due
 *   presentation").
 * - active_draws_since_eligible only advances when decision.source ===
 *   "ACTIVE" (section 9 of the Phase 6D/6F briefs: "count ACTIVE-source
 *   selections, not global questions") -- reusing
 *   lib/learning-engine/active-priority.ts's advanceActiveDrawCounters
 *   unchanged, fed the ordinary-candidate set AS IT EXISTED at the moment
 *   of this draw (lib/learning-engine/scheduler/active-selection.ts's
 *   selectOrdinaryActiveCandidates, not reimplemented). A card the draw
 *   actually selected resets to 0 only if it was itself one of those
 *   ordinary candidates (true for active_weighted_selection/
 *   active_starvation/active_first_pass/emergency_cooldown_relaxation);
 *   a repair_hard_cap/repair_target/spaced_confirmation draw still
 *   consumes an Active-source slot (decision.source is "ACTIVE" for all
 *   of these), so every OTHER eligible ordinary candidate still ages by
 *   one, correctly, with no new logic beyond this composition.
 *
 * ---------------------------------------------------------------------
 * Phase 7 additions
 * ---------------------------------------------------------------------
 * - hasAchievedFullMastery/masteredCount are recomputed after every step
 *   via lib/learning-engine/scheduler/post-mastery-mode.ts's
 *   computeHasAchievedFullMastery (unchanged), fed the live card set's
 *   actual LEARNED count -- never derived any other way, and never
 *   resettable to false once true, matching that function's own
 *   monotonic contract.
 * - postMasteryShuffleBag is applied from decision.postMasteryShuffleBagAfter
 *   exactly like firstPassQueue.
 * - RANDOM_MASTERED Correct (reviewed correction, Phase 7 brief section
 *   14): NOT a no-op. Treated as an early/optional FSRS review -- FSRS
 *   Good via lib/learning-engine/fsrs/lifecycle.ts's
 *   resolveRandomMasteredCorrect (a plain alias for resolveNearDueCorrect,
 *   the identical "update FSRS, leave mastery counters and cardState
 *   otherwise untouched" pattern already used for Near-Due Correct -- not
 *   a second FSRS implementation). fsrsReviewCorrectCount/Streak remain
 *   byte-for-byte unchanged; the card stays LEARNED.
 * - RANDOM_MASTERED Wrong (confirmed policy, Phase 7 brief section 15):
 *   reuses resolveRandomMasteredWrong (a plain alias for
 *   resolveLongTermWrong) -- the full long-term lapse lifecycle, same
 *   severity as an ordinary Due/Near-Due Wrong, never a lighter
 *   free-play-specific rule.
 */

import {
  advanceActiveDrawCounters,
  applyCorrectCooldown,
  type ActiveDrawCounterCard,
} from "@/lib/learning-engine/active-priority";
import { selectOrdinaryActiveCandidates } from "@/lib/learning-engine/scheduler/active-selection";
import {
  createRepairObligation,
  resolveOrdinaryRepairCorrect,
  resolveOrdinaryRepairWrong,
  resolveRelearningRepairCorrect,
  resolveRelearningRepairWrong,
  resolveSpacedConfirmationWrong,
} from "@/lib/learning-engine/repair-scheduler";
import { applyFirstPresentation, applyNormalCorrect, applySpacedCorrect, applyWrong } from "@/lib/learning-engine/transitions";
import {
  resolveLongTermWrong,
  resolveNearDueCorrect,
  resolveQualifyingFsrsCorrect,
  resolveRandomMasteredCorrect,
  resolveRandomMasteredWrong,
} from "@/lib/learning-engine/fsrs/lifecycle";
import { deriveRetrievability, progressToFsrsCard } from "@/lib/learning-engine/fsrs/adapter";
import { computeHasAchievedFullMastery } from "@/lib/learning-engine/scheduler/post-mastery-mode";
import { chooseNextCard, type NextCardDecision, type RandomSource } from "@/lib/learning-engine/scheduler/next-card";
import type { DailyGoalSnapshot, DeckSchedulerSnapshot, SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";
import type { RepairObligation } from "@/lib/learning-engine/repair-scheduler";
import { createEmptyCard, type Card } from "ts-fsrs";

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`learning-engine-simulation: ${message}`);
  }
}

// =============================================================================
// Seeded RNG (Phase 6F brief section 3)
// =============================================================================

/**
 * mulberry32 -- a small, well-known, transparent deterministic PRNG.
 * Same seed always produces the same sequence; different seeds produce
 * different (valid, [0,1)) sequences. No Math.random() anywhere. Test-only:
 * production code must keep using whatever RandomSource is injected by its
 * own caller, never this function directly.
 */
export function createSeededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// =============================================================================
// The simulation harness
// =============================================================================

export interface SimulationConfig {
  readonly cards: readonly SchedulableCardRow[];
  readonly random: RandomSource;
  readonly now?: Date;
  readonly desiredRetention?: number;
  readonly policyVersion?: string;
  readonly dailyGoal?: DailyGoalSnapshot;
  readonly schedulerPosition?: number;
  readonly schedulerRevision?: number;
  readonly lastCriticalDuePosition?: number | null;
  readonly firstPassQueue?: readonly string[] | null;
  /** The deck's initial persisted `has_achieved_full_mastery` -- defaults to false. Auto-advances (monotonically) after every step() via computeHasAchievedFullMastery; never needs to be set true "by hand" for a test that wants to reach unlock organically, but tests exercising an ALREADY-unlocked deck (e.g. a historical lapse scenario) should pass `true` here directly. */
  readonly hasAchievedFullMastery?: boolean;
  readonly postMasteryShuffleBag?: readonly string[] | null;
}

const DEFAULT_NOW = new Date("2026-01-01T00:00:00.000Z");

/**
 * One deck's simulated scheduler state, advanced one chooseNextCard()
 * decision at a time via `step()`. Never mutates the `cards` array passed
 * to the constructor, nor any row object within it -- every update
 * produces a brand new row object and replaces the map entry.
 */
export class SchedulerSimulation {
  private cards: Map<string, SchedulableCardRow>;
  private readonly now: Date;
  private readonly desiredRetention: number;
  private readonly policyVersion: string;
  private readonly dailyGoal: DailyGoalSnapshot;
  private schedulerPosition: number;
  private schedulerRevision: number;
  private lastCriticalDuePosition: number | null;
  private firstPassQueue: readonly string[] | null;
  private hasAchievedFullMastery: boolean;
  private postMasteryShuffleBag: readonly string[] | null;
  private readonly random: RandomSource;

  readonly decisions: NextCardDecision[] = [];

  constructor(config: SimulationConfig) {
    this.cards = new Map(config.cards.map((card) => [card.cardId, card]));
    this.random = config.random;
    this.now = config.now ?? DEFAULT_NOW;
    this.desiredRetention = config.desiredRetention ?? 0.9;
    this.policyVersion = config.policyVersion ?? "learning-engine-v1.0";
    this.dailyGoal = config.dailyGoal ?? { enemiesDefeatedToday: 0, completed: false };
    this.schedulerPosition = config.schedulerPosition ?? 0;
    this.schedulerRevision = config.schedulerRevision ?? 1;
    this.lastCriticalDuePosition = config.lastCriticalDuePosition ?? null;
    this.firstPassQueue = config.firstPassQueue ?? null;
    this.hasAchievedFullMastery = config.hasAchievedFullMastery ?? false;
    this.postMasteryShuffleBag = config.postMasteryShuffleBag ?? null;
    this.refreshMasteryUnlock();
  }

  get position(): number {
    return this.schedulerPosition;
  }

  get revision(): number {
    return this.schedulerRevision;
  }

  get queue(): readonly string[] | null {
    return this.firstPassQueue;
  }

  get criticalDuePosition(): number | null {
    return this.lastCriticalDuePosition;
  }

  get fullMasteryUnlocked(): boolean {
    return this.hasAchievedFullMastery;
  }

  get masteredCount(): number {
    return this.getAllCards().filter((card) => card.cardStatus === "LEARNED").length;
  }

  get shuffleBag(): readonly string[] | null {
    return this.postMasteryShuffleBag;
  }

  /** Section 3 of the Phase 7 brief: recomputes the monotonic historical unlock from the live card set's current LEARNED count via computeHasAchievedFullMastery (unchanged) -- never any other way. Called once at construction (so a fixture that is already 100% LEARNED unlocks immediately, without requiring the test to also pass hasAchievedFullMastery:true by hand) and again at the end of every step(). */
  private refreshMasteryUnlock(): void {
    this.hasAchievedFullMastery = computeHasAchievedFullMastery({
      currentlyUnlocked: this.hasAchievedFullMastery,
      masteredCount: this.masteredCount,
      totalCards: this.cards.size,
    });
  }

  getCard(cardId: string): SchedulableCardRow {
    const card = this.cards.get(cardId);
    invariant(card !== undefined, `unknown card id: ${cardId}`);
    return card;
  }

  getAllCards(): readonly SchedulableCardRow[] {
    return [...this.cards.values()];
  }

  /** Test-only escape hatch: directly inserts/replaces a card in the live simulation state, bypassing admission/transition flow entirely. Useful for precisely staging a scenario (e.g. "a repair hard-cap interrupt becomes reachable at exactly this position") that would otherwise require many extra scripted steps to arrive at naturally. Never used by step() itself. */
  injectCard(card: SchedulableCardRow): void {
    this.setCard(card.cardId, card);
  }

  /** The exact DeckSchedulerSnapshot the NEXT step() would feed to chooseNextCard, without actually advancing anything -- useful for fixed-snapshot distribution tests that want the harness's convenient card-fixture bookkeeping without ever calling step(). */
  snapshot(): DeckSchedulerSnapshot {
    return this.buildSnapshot();
  }

  private buildSnapshot(): DeckSchedulerSnapshot {
    return {
      userId: "sim-user",
      deckId: "sim-deck",
      now: this.now,
      deckState: {
        desiredRetention: this.desiredRetention,
        policyVersion: this.policyVersion,
        hasAchievedFullMastery: this.hasAchievedFullMastery,
        masteredCount: this.masteredCount,
        schedulerPosition: this.schedulerPosition,
        lastCriticalDuePosition: this.lastCriticalDuePosition,
        schedulerRevision: this.schedulerRevision,
        firstPassQueue: this.firstPassQueue,
        postMasteryShuffleBag: this.postMasteryShuffleBag,
      },
      dailyGoal: this.dailyGoal,
      cards: this.getAllCards(),
    };
  }

  private setCard(cardId: string, next: SchedulableCardRow): void {
    this.cards.set(cardId, next);
  }

  /**
   * Runs exactly one chooseNextCard() decision and applies the minimum
   * commit-layer bookkeeping described in this module's header. `answer`
   * (default: true/Correct) is the SCRIPTED outcome for whichever card
   * this decision actually selects -- ignored entirely for a
   * `no_card_all_unavailable` decision, which answered nothing. May also
   * be a callback receiving the just-computed NextCardDecision, for a
   * caller that needs to answer differently depending on which reason/
   * source this particular draw resolved to (e.g. "always Correct on a
   * repair retry, sometimes Wrong on ordinary Active").
   */
  step(answer: boolean | ((decision: NextCardDecision) => boolean) = true): NextCardDecision {
    const snapshotBefore = this.buildSnapshot();
    const decision = chooseNextCard(snapshotBefore, this.random);
    this.decisions.push(decision);
    const resolvedAnswer = typeof answer === "function" ? answer(decision) : answer;

    // 1. Virtual admissions, applied for real in the simulation.
    for (const cardId of decision.admittedCardIds) {
      const card = this.getCard(cardId);
      this.setCard(cardId, { ...card, poolStatus: "ACTIVE" });
    }

    // 2. First-pass queue / Post-Mastery shuffle-bag transitions.
    this.firstPassQueue = decision.firstPassQueueAfter;
    this.postMasteryShuffleBag = decision.postMasteryShuffleBagAfter;

    // 3. A commit always advances the optimistic-concurrency revision,
    // even when no card was ultimately presented.
    this.schedulerRevision += 1;

    if (decision.cardId === null) {
      this.refreshMasteryUnlock();
      return decision;
    }

    // 4. Position advances only for an actually-answered question.
    const positionAtDrawTime = this.schedulerPosition;
    this.schedulerPosition += 1;
    const newPosition = this.schedulerPosition;

    // 5. Critical Due presentation bookkeeping (presentation-gated, not
    // correctness-gated).
    if (decision.selectionReason === "critical_due_interrupt") {
      this.lastCriticalDuePosition = newPosition;
    }

    // 6. Active-source aging, using the ordinary-candidate set exactly as
    // chooseNextCard itself saw it this draw (positionAtDrawTime, the
    // post-refill card view).
    if (decision.source === "ACTIVE") {
      const ordinary = selectOrdinaryActiveCandidates(this.getAllCards(), positionAtDrawTime);
      const counterInputs: ActiveDrawCounterCard[] = ordinary.map((candidate) => ({
        cardId: candidate.card.cardId,
        activeDrawsSinceEligible: candidate.card.activeDrawsSinceEligible,
        eligible: true,
      }));
      const updates = advanceActiveDrawCounters(counterInputs, decision.cardId);
      for (const [cardId, value] of updates) {
        const card = this.getCard(cardId);
        this.setCard(cardId, { ...card, activeDrawsSinceEligible: value });
      }
    }

    // 7. Apply the scripted answer through existing pure transition/FSRS/
    // repair helpers -- never reimplemented here.
    this.applyScriptedAnswer(decision, resolvedAnswer, positionAtDrawTime);

    // 8. Section 3 of the Phase 7 brief: re-evaluate the historical unlock
    // after whatever this answer just changed (e.g. a qualifying FSRS
    // Correct that just promoted the deck's last ACQUIRED card to LEARNED).
    this.refreshMasteryUnlock();

    return decision;
  }

  /**
   * Convenience for stress runs: executes `count` steps, scripting each
   * one's answer via `answerFor(decision, index)` (default: always
   * Correct). Returns every decision, in order.
   */
  runSteps(count: number, answerFor: (decision: NextCardDecision, index: number) => boolean = () => true): NextCardDecision[] {
    const results: NextCardDecision[] = [];
    for (let i = 0; i < count; i += 1) {
      results.push(this.step((decision) => answerFor(decision, i)));
    }
    return results;
  }

  private applyScriptedAnswer(decision: NextCardDecision, correct: boolean, presentationPosition: number): void {
    const cardId = decision.cardId!;
    const card = this.getCard(cardId);
    const reason = decision.selectionReason;

    if (
      reason === "active_first_pass" ||
      reason === "active_starvation" ||
      reason === "active_weighted_selection" ||
      reason === "emergency_cooldown_relaxation"
    ) {
      this.applyOrdinaryActiveAnswer(card, correct, presentationPosition);
      return;
    }

    if (reason === "repair_target" || reason === "repair_hard_cap") {
      if (correct) {
        this.applyRepairRetryCorrect(card, presentationPosition);
      } else {
        this.applyRepairRetryWrong(card, presentationPosition);
      }
      return;
    }

    if (reason === "spaced_confirmation") {
      if (correct) {
        this.applySpacedConfirmationCorrect(card);
      } else {
        this.applySpacedConfirmationWrongAnswer(card, presentationPosition);
      }
      return;
    }

    // Approved RC-F small-deck audit follow-up: the Repair liveness
    // fallback (scheduler/next-card.ts) releases a governed card before
    // its own normal gate opens, but the card's underlying shape is
    // unchanged -- route to whichever existing handler that shape already
    // uses, same as prepare-answer.ts's own dispatch.
    if (reason === "emergency_repair_relaxation") {
      if (card.relearningPhase === "SPACED_CONFIRMATION_PENDING") {
        if (correct) {
          this.applySpacedConfirmationCorrect(card);
        } else {
          this.applySpacedConfirmationWrongAnswer(card, presentationPosition);
        }
      } else if (correct) {
        this.applyRepairRetryCorrect(card, presentationPosition);
      } else {
        this.applyRepairRetryWrong(card, presentationPosition);
      }
      return;
    }

    if (reason === "due_weighted_selection" || reason === "critical_due_interrupt") {
      this.applyFsrsDueAnswer(card, correct, presentationPosition);
      return;
    }

    if (reason === "near_due_weighted_selection") {
      this.applyNearDueAnswer(card, correct, presentationPosition);
      return;
    }

    if (reason === "random_mastered_shuffle_bag") {
      this.applyRandomMasteredAnswer(card, correct, presentationPosition);
      return;
    }

    invariant(false, `applyScriptedAnswer: unreachable selectionReason ${reason} (cardId is non-null, so no_card_all_unavailable cannot occur here)`);
  }

  /**
   * Position-semantics fix (Stage 0 audit, mirrors
   * lib/learning-engine/runtime/prepare-answer.ts's own
   * `presentationPosition`): gate arithmetic (Repair wrongPosition/
   * target/hard-cap, Correct cooldown-until) uses `presentationPosition`
   * -- the PRE-answer position this draw's claim actually occupies
   * (`positionAtDrawTime` from `step()`), matching the canonical
   * convention "a card claimed at scheduler_position = N is presented/
   * answered AT N for gate arithmetic" -- never the POST-answer
   * `newPosition` this harness also tracks for OTHER, genuinely
   * post-increment concepts (e.g. `lastCriticalDuePosition`).
   */
  private applyOrdinaryActiveAnswer(card: SchedulableCardRow, correct: boolean, presentationPosition: number): void {
    const presentedState = card.cardStatus === "NEW" ? applyFirstPresentation(card) : card;

    if (correct) {
      const cardState = applyNormalCorrect(presentedState);
      this.setCard(card.cardId, { ...card, ...cardState, correctCooldownUntilPosition: applyCorrectCooldown(presentationPosition) });
      return;
    }

    const cardState = applyWrong(presentedState);
    const obligation = createRepairObligation({ cardId: card.cardId, wrongPosition: presentationPosition, random: this.random });
    this.setCard(card.cardId, { ...card, ...cardState, repairObligation: obligation });
  }

  private applyRepairRetryCorrect(card: SchedulableCardRow, presentationPosition: number): void {
    const result =
      card.cardStatus === "FORGOTTEN" ? resolveRelearningRepairCorrect(card, presentationPosition) : resolveOrdinaryRepairCorrect(card, presentationPosition);
    this.setCard(card.cardId, {
      ...card,
      ...result.cardState,
      // Merge clearedRepairFields explicitly -- applyRelearningRepairCorrect
      // alone does not clear repairPending (see that function's own doc
      // comment); without this merge a FORGOTTEN card would reach
      // SPACED_CONFIRMATION_PENDING with a stale repairPending = true,
      // violating the snapshot-mapper's universal invariant (bug fixed
      // alongside the RC-C spec-gap correction -- resolveOrdinaryRepairCorrect's
      // own applyRepairCorrect already clears it directly, so this merge is
      // a harmless no-op on that path).
      ...result.clearedRepairFields,
      repairObligation: null,
      correctCooldownUntilPosition: result.nextCorrectCooldownUntilPosition,
    });
  }

  private applySpacedConfirmationCorrect(card: SchedulableCardRow): void {
    const cardState = applySpacedCorrect(card);
    this.setCard(card.cardId, { ...card, ...cardState, correctCooldownUntilPosition: null });
  }

  /**
   * RC-C spec-gap correction (now-normative, sections 12.2/13): a Wrong on
   * an already-pending repair retry replaces the old obligation with a
   * fresh one anchored at the current Wrong position -- never advances or
   * regresses the acquisition stage (ordinary) and never advances to
   * SPACED_CONFIRMATION_PENDING (relearning).
   */
  private applyRepairRetryWrong(card: SchedulableCardRow, presentationPosition: number): void {
    const result =
      card.cardStatus === "FORGOTTEN"
        ? resolveRelearningRepairWrong({ cardState: card, cardId: card.cardId, wrongPosition: presentationPosition, random: this.random })
        : resolveOrdinaryRepairWrong({ cardState: card, cardId: card.cardId, wrongPosition: presentationPosition, random: this.random });
    this.setCard(card.cardId, { ...card, ...result.cardState, repairObligation: result.repairObligation });
  }

  /**
   * RC-C spec-gap correction (now-normative, section 13): a Wrong on the
   * mandatory Spaced Confirmation retry falls back to REPAIR_PENDING with
   * a fresh obligation -- the card must complete Repair -> 5-card-gap ->
   * Spaced Correct again from scratch, never straight into another Spaced
   * Confirmation.
   */
  private applySpacedConfirmationWrongAnswer(card: SchedulableCardRow, presentationPosition: number): void {
    const result = resolveSpacedConfirmationWrong({ cardState: card, cardId: card.cardId, wrongPosition: presentationPosition, random: this.random });
    this.setCard(card.cardId, { ...card, ...result.cardState, repairObligation: result.repairObligation, correctCooldownUntilPosition: null });
  }

  private applyFsrsDueAnswer(card: SchedulableCardRow, correct: boolean, presentationPosition: number): void {
    if (correct) {
      const result = resolveQualifyingFsrsCorrect({ card: card.fsrsCard, cardState: card, now: this.now, desiredRetention: this.desiredRetention });
      const nextFsrsCard = progressToFsrsCard(result.fsrsUpdate, this.now);
      this.setCard(card.cardId, { ...card, ...result.cardState, fsrsCard: nextFsrsCard });
      return;
    }

    const result = resolveLongTermWrong({ card: card.fsrsCard, cardState: card, now: this.now, desiredRetention: this.desiredRetention });
    const nextFsrsCard = progressToFsrsCard(result.fsrsUpdate, this.now);
    const obligation = createRepairObligation({ cardId: card.cardId, wrongPosition: presentationPosition, random: this.random });
    this.setCard(card.cardId, { ...card, ...result.cardState, fsrsCard: nextFsrsCard, repairObligation: obligation });
  }

  private applyNearDueAnswer(card: SchedulableCardRow, correct: boolean, presentationPosition: number): void {
    if (correct) {
      const result = resolveNearDueCorrect({ card: card.fsrsCard, cardState: card, now: this.now, desiredRetention: this.desiredRetention });
      const nextFsrsCard = progressToFsrsCard(result.fsrsUpdate, this.now);
      this.setCard(card.cardId, { ...card, ...result.cardState, fsrsCard: nextFsrsCard });
      return;
    }

    const result = resolveLongTermWrong({ card: card.fsrsCard, cardState: card, now: this.now, desiredRetention: this.desiredRetention });
    const nextFsrsCard = progressToFsrsCard(result.fsrsUpdate, this.now);
    const obligation = createRepairObligation({ cardId: card.cardId, wrongPosition: presentationPosition, random: this.random });
    this.setCard(card.cardId, { ...card, ...result.cardState, fsrsCard: nextFsrsCard, repairObligation: obligation });
  }

  /**
   * Phase 7 brief sections 14-15 (reviewed corrections) -- see this
   * module's header. Correct: an early/optional FSRS review via
   * resolveRandomMasteredCorrect (FSRS Good, mastery counters and
   * cardState otherwise untouched -- never routed through
   * applyQualifyingFsrsCorrect). Wrong: the full long-term lapse via
   * resolveRandomMasteredWrong, identical severity to an ordinary Due/
   * Near-Due Wrong -- never a second, lighter free-play-specific failure
   * state machine.
   */
  private applyRandomMasteredAnswer(card: SchedulableCardRow, correct: boolean, presentationPosition: number): void {
    if (correct) {
      const result = resolveRandomMasteredCorrect({ card: card.fsrsCard, cardState: card, now: this.now, desiredRetention: this.desiredRetention });
      const nextFsrsCard = progressToFsrsCard(result.fsrsUpdate, this.now);
      this.setCard(card.cardId, { ...card, ...result.cardState, fsrsCard: nextFsrsCard });
      return;
    }

    const result = resolveRandomMasteredWrong({ card: card.fsrsCard, cardState: card, now: this.now, desiredRetention: this.desiredRetention });
    const nextFsrsCard = progressToFsrsCard(result.fsrsUpdate, this.now);
    const obligation = createRepairObligation({ cardId: card.cardId, wrongPosition: presentationPosition, random: this.random });
    this.setCard(card.cardId, { ...card, ...result.cardState, fsrsCard: nextFsrsCard, repairObligation: obligation });
  }
}

// =============================================================================
// Shared test-only card fixtures (same shapes already used across the
// Phase 6C-6E unit test files -- centralized here rather than duplicated
// per Phase 6F test file, per the brief's own file-organization guidance)
// =============================================================================

export const FIXTURE_NOW = new Date("2026-01-01T00:00:00.000Z");
const FIXTURE_DAY_MS = 24 * 60 * 60 * 1000;

export function makeActiveCard(cardId: string, overrides: Partial<SchedulableCardRow> = {}): SchedulableCardRow {
  return {
    cardId,
    cardStatus: "LEARNING",
    learningStage: "FRESH",
    poolStatus: "ACTIVE",
    relearningPhase: null,
    hasEverBeenMastered: false,
    repairPending: false,
    fsrsReviewCorrectCount: 0,
    fsrsReviewCorrectStreak: 0,
    correctCooldownUntilPosition: null,
    activeDrawsSinceEligible: 0,
    repairObligation: null,
    fsrsCard: createEmptyCard(FIXTURE_NOW),
    ...overrides,
  };
}

/** Already admitted to ACTIVE, never presented -- a first-pass batch candidate. */
export function makeNeverPresentedCard(cardId: string, overrides: Partial<SchedulableCardRow> = {}): SchedulableCardRow {
  return makeActiveCard(cardId, { cardStatus: "NEW", learningStage: null, ...overrides });
}

/** Still in the NEW reservoir -- not yet admitted to Active (pool_status null). */
export function makeReservoirCard(cardId: string): SchedulableCardRow {
  return makeActiveCard(cardId, { poolStatus: null, cardStatus: "NEW", learningStage: null });
}

export function makeRepairObligation(cardId: string, wrongPosition: number, hardCapPosition: number): RepairObligation {
  return { cardId, wrongPosition, targetPosition: wrongPosition + 4, hardCapPosition };
}

export function makeRepairGovernedCard(cardId: string, obligation: RepairObligation, overrides: Partial<SchedulableCardRow> = {}): SchedulableCardRow {
  return makeActiveCard(cardId, { repairPending: true, repairObligation: obligation, ...overrides });
}

export function makeSpacedConfirmationCard(cardId: string, gatePosition: number): SchedulableCardRow {
  return makeActiveCard(cardId, {
    cardStatus: "FORGOTTEN",
    learningStage: null,
    relearningPhase: "SPACED_CONFIRMATION_PENDING",
    correctCooldownUntilPosition: gatePosition,
  });
}

/** poolStatus OUTSIDE, FSRS_DUE by default at FIXTURE_NOW (10-day stability/schedule, elapsed exactly 10 days -> progress 1.0). */
export function makeOutsideCard(cardId: string, overrides: Partial<SchedulableCardRow> = {}, fsrsOverrides: Partial<Card> = {}): SchedulableCardRow {
  return {
    cardId,
    cardStatus: "ACQUIRED",
    learningStage: null,
    poolStatus: "OUTSIDE",
    relearningPhase: null,
    hasEverBeenMastered: false,
    repairPending: false,
    fsrsReviewCorrectCount: 1,
    fsrsReviewCorrectStreak: 1,
    correctCooldownUntilPosition: null,
    activeDrawsSinceEligible: 0,
    repairObligation: null,
    fsrsCard: {
      ...createEmptyCard(FIXTURE_NOW),
      stability: 10,
      difficulty: 5,
      scheduled_days: 10,
      state: 2,
      last_review: new Date(FIXTURE_NOW.getTime() - 10 * FIXTURE_DAY_MS),
      ...fsrsOverrides,
    },
    ...overrides,
  };
}

/** progress ~0.8 -> NEAR_DUE at FIXTURE_NOW. */
export function makeNearDueCard(cardId: string): SchedulableCardRow {
  return makeOutsideCard(cardId, {}, { last_review: new Date(FIXTURE_NOW.getTime() - 8 * FIXTURE_DAY_MS) });
}

/** A strong-Mastered RANDOM_MASTERED candidate by default: LEARNED, has_ever_been_mastered, OUTSIDE, progress ~0 (well under 0.75 -> STRONG_OUTSIDE, not Due/Near-Due). */
export function makeMasteredCard(cardId: string, overrides: Partial<SchedulableCardRow> = {}): SchedulableCardRow {
  return makeOutsideCard(
    cardId,
    { cardStatus: "LEARNED", hasEverBeenMastered: true, fsrsReviewCorrectCount: 3, fsrsReviewCorrectStreak: 2, ...overrides },
    { last_review: FIXTURE_NOW },
  );
}

export function makeDueCards(count: number, prefix = "due"): SchedulableCardRow[] {
  return Array.from({ length: count }, (_, i) => makeOutsideCard(`${prefix}-${i}`));
}

/**
 * Binary-searches `stability` (at the fixed 10-day elapsed window) so the
 * card's real deriveRetrievability lands at/below `targetR` -- same
 * technique as learning-engine-scheduler-interrupts.test.ts, reused here
 * so Phase 6F's Critical Due simulations exercise the real FSRS
 * computation rather than a stubbed R.
 */
export function makeCriticallyDueCard(cardId: string, targetR = 0.3): SchedulableCardRow {
  let lo = 0.01;
  let hi = 50;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    const probe: Card = {
      ...createEmptyCard(FIXTURE_NOW),
      stability: mid,
      difficulty: 5,
      scheduled_days: 10,
      state: 2,
      last_review: new Date(FIXTURE_NOW.getTime() - 10 * FIXTURE_DAY_MS),
    };
    const r = deriveRetrievability(probe, FIXTURE_NOW);
    if (r > targetR) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return makeOutsideCard(cardId, {}, { stability: lo });
}
