/**
 * Learning Engine v1 -- the top-level pure scheduler orchestrator (Phase
 * 6E of the implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections 23
 * ("Next-card selection pipeline") and 24 ("Scheduler pseudocode"), as
 * refined by the Phase 6E brief.
 *
 * `chooseNextCard` composes, but never duplicates, every already-reviewed
 * Phase 1-6D primitive:
 *   - Phase 3's computeActiveAdmissions (lib/learning-engine/active-pool.ts)
 *     for the virtual Active refill;
 *   - Phase 6D's findGlobalInterrupt (lib/learning-engine/scheduler/
 *     interrupts.ts) for the Repair hard-cap / Critical Due global gate;
 *   - Phase 6D's selectActiveInternalCard (lib/learning-engine/scheduler/
 *     active-internal-selection.ts) for ACTIVE-source internal priority;
 *   - Phase 6C's chooseDueCard/chooseNearDueCard (lib/learning-engine/
 *     scheduler/due-selection.ts, near-due-selection.ts) for the other two
 *     ordinary sources;
 *   - Phase 6B's computeSourceWeights/renormalizeSourceWeights
 *     (lib/learning-engine/scheduler/source-policy.ts, renormalize.ts) for
 *     the Dynamic Source Weight regime;
 *   - Phase 6A's weightedRandomChoice (lib/learning-engine/scheduler/
 *     weighted-random.ts) for the top-level source draw.
 *
 * Pure and deterministic throughout: no database access, no clock reads
 * (the caller supplies `now` on the snapshot), no hidden Math.random()
 * call anywhere in this module or anything it calls. The only randomness
 * is the injected RandomSource, wrapped once (see `createRecordingRandom`
 * below) so every value it ever produces during one decision is captured,
 * in consumption order, for the trace's `randomDraws` (Phase 6D brief
 * section 20: "Phase 6F will require seeded reproducibility").
 *
 * ---------------------------------------------------------------------
 * The first-pass queue tier (first-pass clarification review)
 * ---------------------------------------------------------------------
 * Section 9's "randomized no-repeat first-pass order" turned out to need
 * more than a one-shot shuffle (Phase 3's buildFirstPassOrder, which is
 * otherwise reused unchanged here): once a card from an initial batch of
 * simultaneously-admitted, never-presented ACTIVE+NEW cards is presented
 * and transitions NEW -> LEARNING, it must NOT re-enter ordinary Active
 * selection until every other member of that SAME batch has also been
 * presented at least once. Ordinary Correct-cooldown (5 intervening
 * cards) is not long enough to guarantee this on its own, and Phase 1-6D
 * has no persisted concept of "which batch a card belongs to" at all --
 * see this module's audit note below and the Phase 6E first-pass-
 * clarification report for the full reasoning.
 *
 * This is implemented as a THIRD priority tier, strictly below the two
 * GLOBAL interrupts (Repair hard cap, Critical Due) and strictly above
 * ordinary source selection: while a first-pass batch has any unserved
 * member, EVERY decision (other than one a global interrupt preempts)
 * serves the next queue member and returns immediately -- Due, Near-Due,
 * and every ACTIVE-internal mechanism (starvation, target-reached Repair,
 * Spaced Confirmation, ordinary weighted Active) are simply never reached
 * during that span. This is what makes the lockout hold structurally,
 * without needing a second "which cards are currently locked out" set:
 * the ONLY path that could ever re-select an already-served batch member
 * (ordinary Active weighting) never executes until the batch's `remaining`
 * list is fully empty. See lib/learning-engine/scheduler/snapshot.ts's
 * `DeckSchedulerState.firstPassQueue` for the new persisted-state field
 * this requires, and this module's own first-pass helpers below.
 *
 * ---------------------------------------------------------------------
 * Isolation (Phase 6E brief section 1)
 * ---------------------------------------------------------------------
 * This module computes a decision only. It NEVER persists anything, never
 * mutates `snapshot` or any card/obligation object reachable from it, and
 * is not wired into get_next_session_card(), commit_answer_transaction(),
 * start_or_resume_session(), app/session/*, or any live Server Action.
 * Runtime cutover (claiming/presenting/committing a NextCardDecision) is
 * explicitly out of scope and happens later as one coordinated change.
 *
 * ---------------------------------------------------------------------
 * Deliberate ordering choice (flagged, not a cognitive-rule change)
 * ---------------------------------------------------------------------
 * The spec's own pipeline (section 23) lists "check Repair interrupt",
 * "check Critical Due interrupt" (steps 3-4) BEFORE "derive ordinary
 * source candidates" / "compute source weights" (steps 6-9). This module
 * preserves that order for every RNG-CONSUMING operation: the two global
 * interrupts are evaluated, and may short-circuit the whole decision,
 * strictly before any ordinary-source weighted draw ever runs (Phase 6D
 * brief section 6: a firing interrupt must not "perform Critical Due
 * selection" / "perform source weighted selection"). However, the pure,
 * non-random CANDIDATE-COUNTING step (how many ACTIVE/FSRS_DUE/NEAR_DUE
 * candidates currently exist, and the resulting nominal/renormalized
 * weights and scheduler mode) is computed once, up front, and reused by
 * every return path -- including an interrupt short-circuit. This is
 * necessary because Phase 6D brief section 18 requires a complete trace
 * (dueCount, schedulerMode, sourceWeightsRaw/Normalized, candidateCounts)
 * on every decision, interrupts included, and none of that computation
 * consumes randomness or has any side effect -- so computing it earlier
 * than the spec's own step numbering changes no observable behavior, only
 * where in the source file the (identical, RNG-free) arithmetic happens.
 */

import {
  buildFirstPassOrder,
  computeActiveAdmissions,
  type DeckActivePoolCard,
} from "@/lib/learning-engine/active-pool";
import { isGovernedByRepairObligation, isRepairHardCapReached, isRepairTargetReached } from "@/lib/learning-engine/repair-scheduler";
import { computeDueWeight } from "@/lib/learning-engine/fsrs/priority";
import { selectActiveInternalCard } from "@/lib/learning-engine/scheduler/active-internal-selection";
import { selectOrdinaryActiveCandidates } from "@/lib/learning-engine/scheduler/active-selection";
import { chooseDueCard, selectDueCandidates } from "@/lib/learning-engine/scheduler/due-selection";
import { findGlobalInterrupt } from "@/lib/learning-engine/scheduler/interrupts";
import { chooseNearDueCard, selectNearDueCandidates } from "@/lib/learning-engine/scheduler/near-due-selection";
import { renormalizeSourceWeights, type SourceAvailability } from "@/lib/learning-engine/scheduler/renormalize";
import { computeSourceWeights, type SchedulerMode, type SourceWeights } from "@/lib/learning-engine/scheduler/source-policy";
import { selectSpacedConfirmationCandidates } from "@/lib/learning-engine/scheduler/spaced-confirmation-selection";
import { weightedRandomChoice, type RandomSource } from "@/lib/learning-engine/scheduler/weighted-random";
import type { DeckSchedulerSnapshot, SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

export type { RandomSource };

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`next-card: ${message}`);
  }
}

// =============================================================================
// Section 16-17 of the Phase 6E brief: the public result shape
// =============================================================================

/** The ordinary v1 source set (section 8 of the brief) plus `null` for the two no-card-selected outcomes (an all-sources-unavailable emergency failure). RANDOM_MASTERED does not exist yet -- Phase 7. */
export type NextCardSource = "ACTIVE" | "FSRS_DUE" | "NEAR_DUE" | null;

/** Section 17: every reason this pipeline can produce. Not persisted by this module (section 22) -- a future Phase 8 telemetry write is the only consumer of the string value itself. */
export type SelectionReason =
  | "repair_hard_cap"
  | "critical_due_interrupt"
  | "active_first_pass"
  | "active_starvation"
  | "repair_target"
  | "spaced_confirmation"
  | "active_weighted_selection"
  | "due_weighted_selection"
  | "near_due_weighted_selection"
  | "emergency_cooldown_relaxation"
  | "no_card_all_unavailable";

/** Section 9 of the brief: ACTIVE's count already folds in starvation/repair-target/spaced-confirmation candidates, not just the ordinary weighted subset -- see computeActiveCandidateCount below. */
export interface SourceCandidateCounts {
  readonly active: number;
  readonly due: number;
  readonly near: number;
}

/**
 * Section 18 of the brief: the full in-memory decision record, rich
 * enough for a future Phase 8 to persist without recomputation. Every
 * field here is populated on EVERY decision (interrupt, ordinary,
 * emergency, or no-card) -- see this module's header for why computing
 * the descriptive (non-random) fields is safe to do uniformly.
 */
export interface SelectionTrace {
  readonly cardId: string | null;
  readonly source: NextCardSource;
  readonly selectionReason: SelectionReason;
  readonly schedulerMode: SchedulerMode;
  readonly schedulerPosition: number;
  readonly schedulerRevision: number;
  readonly dueCount: number;
  readonly dailyGoalCompleteBefore: boolean;
  readonly sourceWeightsRaw: SourceWeights;
  readonly sourceWeightsNormalized: SourceWeights;
  readonly candidateCounts: SourceCandidateCounts;
  /** The weight the winning card was drawn with, where selection was weighted-random (active_weighted_selection, due_weighted_selection, near_due_weighted_selection, critical_due_interrupt). `null` for every deterministic-priority reason (repair_hard_cap, active_starvation, repair_target, spaced_confirmation, emergency_cooldown_relaxation, no_card_all_unavailable). */
  readonly cardPriorityWeight: number | null;
  /** Populated only for due_weighted_selection and critical_due_interrupt (section 18's "retrievability for Due/Critical selections"). */
  readonly retrievability: number | null;
  /** Populated only for near_due_weighted_selection (section 18's "intervalProgress for Near-Due"). */
  readonly intervalProgress: number | null;
  readonly admittedCardIds: readonly string[];
  readonly policyVersion: string;
  /** Section 15 of the brief: "the decision trace must clearly mark that an invariant fallback occurred." True for BOTH emergency outcomes (a relaxed selection succeeded, or none could even be found) -- both mean ordinary scheduling broke down and this draw needed the emergency branch at all. */
  readonly emergencyFallbackApplied: boolean;
  /** The first-pass queue state this decision READ (DeckSchedulerState.firstPassQueue, normalized: an empty array is reported as null). Null means no batch was in flight when this decision started. */
  readonly firstPassQueueBefore: readonly string[] | null;
  /** The first-pass queue state a future trusted commit should persist as the new DeckSchedulerState.firstPassQueue. Unchanged from `firstPassQueueBefore` on every path except a first-pass serve (which removes the served head, or creates a brand new batch and immediately removes its own served head) -- in particular, a global interrupt NEVER changes this (section PREEMPTION: "these interrupts do not destroy or reorder the remaining first-pass queue"). */
  readonly firstPassQueueAfter: readonly string[] | null;
  /** Section 20: every value the injected RandomSource produced during this decision, in consumption order -- sufficient for Phase 6F to replay/debug a decision given the same snapshot and the same RNG seed. */
  readonly randomDraws: readonly number[];
}

/** Section 16 of the brief: the pure return type of chooseNextCard. */
export interface NextCardDecision {
  readonly cardId: string | null;
  readonly source: NextCardSource;
  readonly selectionReason: SelectionReason;
  /** Section 4: NEW cards virtually admitted to ACTIVE during this decision, for a future trusted claim path to apply atomically. Never persisted here (section 22). */
  readonly admittedCardIds: readonly string[];
  /** The first-pass queue state a future trusted commit should persist as the new DeckSchedulerState.firstPassQueue -- see SelectionTrace.firstPassQueueAfter for the full semantics (duplicated here, like admittedCardIds, because it is actionable output for that future commit, not merely diagnostic). */
  readonly firstPassQueueAfter: readonly string[] | null;
  readonly schedulerPosition: number;
  readonly schedulerRevision: number;
  readonly trace: SelectionTrace;
}

// =============================================================================
// Section 20 of the brief: a recording RandomSource wrapper
// =============================================================================

/**
 * Wraps `random` so every value it ever returns during one chooseNextCard
 * call is captured, in order, into `draws` -- without changing the
 * sequence of values downstream pure functions receive (the wrapper is
 * transparent: callers of `recorded` get exactly what calling `random`
 * directly would have returned). This is the ONLY place in this module
 * that touches the raw injected RandomSource; every other function below
 * is handed `recorded`.
 */
function createRecordingRandom(random: RandomSource): { recorded: RandomSource; draws: number[] } {
  const draws: number[] = [];
  const recorded: RandomSource = () => {
    const value = random();
    draws.push(value);
    return value;
  };
  return { recorded, draws };
}

// =============================================================================
// Section 4 of the brief: virtual Active refill
// =============================================================================

/**
 * Section 4: "Active admission is a scheduler decision but is NOT yet
 * persisted in Phase 6E." Reuses Phase 3's computeActiveAdmissions
 * unchanged over a `DeckActivePoolCard` projection of the snapshot's own
 * cards (never re-deriving Fresh/Active sizing itself), then returns a
 * NEW array in which every admitted card's `poolStatus` is virtually
 * "ACTIVE" -- `cardStatus` stays "NEW" (section 4: "Admission is not
 * presentation... do NOT change NEW -> LEARNING"). Cards not admitted
 * this pass are returned by the SAME reference as in `cards` (no copying
 * of what did not change); `cards` itself is never mutated.
 */
function computeVirtualActiveRefill(cards: readonly SchedulableCardRow[]): {
  projectedCards: readonly SchedulableCardRow[];
  admittedCardIds: readonly string[];
} {
  const activeCards: DeckActivePoolCard[] = cards
    .filter((card) => card.poolStatus === "ACTIVE")
    .map((card) => ({ cardId: card.cardId, cardStatus: card.cardStatus, poolStatus: card.poolStatus, learningStage: card.learningStage }));

  const newReservoir: DeckActivePoolCard[] = cards
    .filter((card) => card.poolStatus === null && card.cardStatus === "NEW")
    .map((card) => ({ cardId: card.cardId, cardStatus: card.cardStatus, poolStatus: card.poolStatus, learningStage: card.learningStage }));

  const admissions = computeActiveAdmissions({ activeCards, newReservoir });
  const admittedSet = new Set(admissions.admittedCardIds);

  const projectedCards = cards.map((card) => (admittedSet.has(card.cardId) ? { ...card, poolStatus: "ACTIVE" as const } : card));

  return { projectedCards, admittedCardIds: admissions.admittedCardIds };
}

// =============================================================================
// Section 9 of the brief: ACTIVE candidate-count semantics
// =============================================================================

/**
 * Section 9: "ACTIVE must be considered NON-EMPTY if the ACTIVE internal
 * selector has ANY possible candidate through: Active starvation,
 * target-reached Repair, due Spaced Confirmation, ordinary weighted
 * Active... Do NOT determine ACTIVE emptiness from ordinary Active
 * candidates alone." Starvation candidates are always a subset of the
 * ordinary candidate set (lib/learning-engine/scheduler/
 * active-selection.ts's findActiveStarvationCandidates only ever narrows
 * selectOrdinaryActiveCandidates's own output), so they need no separate
 * term here -- a non-empty ordinary set already implies ACTIVE is
 * non-empty regardless of whether any member happens to be starved. The
 * count itself is the union of card ids reachable through any channel
 * (not a raw sum, which would double-count a card that is simultaneously
 * ordinary-eligible and, say, a target-reached repair under a hypothetical
 * future relaxation -- not reachable today under the engine's own
 * invariants, but a union is the correct definition regardless).
 */
function computeActiveCandidateCount(cards: readonly SchedulableCardRow[], schedulerPosition: number): number {
  const candidateIds = new Set<string>();

  for (const candidate of selectOrdinaryActiveCandidates(cards, schedulerPosition)) {
    candidateIds.add(candidate.card.cardId);
  }

  for (const card of cards) {
    const obligation = card.repairObligation;
    if (obligation !== null && isRepairTargetReached(obligation, schedulerPosition) && !isRepairHardCapReached(obligation, schedulerPosition)) {
      candidateIds.add(obligation.cardId);
    }
  }

  for (const candidate of selectSpacedConfirmationCandidates(cards, schedulerPosition)) {
    candidateIds.add(candidate.cardId);
  }

  return candidateIds.size;
}

// =============================================================================
// First-pass queue tier (first-pass clarification review)
// =============================================================================

/**
 * Audit finding (first-pass clarification review): Phase 3's
 * buildFirstPassOrder is a pure Fisher-Yates shuffle with NO persisted
 * state of its own -- it is not called anywhere in the Phase 6A-6E
 * pipeline today (confirmed by repo-wide search), has no notion of
 * "remaining to serve" vs. "already served," and nothing anywhere
 * (schema, DeckSchedulerState, or any card field) tracks which cards
 * belong to an in-flight first-pass batch. The ONLY existing mechanism
 * that could prevent an immediate repeat is ordinary Correct-cooldown
 * (lib/learning-engine/active-priority.ts's 5-intervening-card gate),
 * which is both too short (a 6-card batch can easily take more than 5
 * intervening draws to finish, once Due/Near-Due/other interrupts
 * interleave) and the wrong SHAPE of rule (it expires on a fixed timer,
 * not "once every sibling has been presented"). Reusing
 * buildFirstPassOrder's shuffle algorithm unchanged, this module adds the
 * missing piece: a single `remaining` list (DeckSchedulerState.
 * firstPassQueue) that this decision consumes from the front and a future
 * trusted commit persists back -- normalizeFirstPassQueue/
 * findNeverPresentedActiveNewCardIds below.
 */
function normalizeFirstPassQueue(queue: readonly string[] | null): readonly string[] | null {
  return queue !== null && queue.length > 0 ? queue : null;
}

/**
 * Candidates for a BRAND NEW first-pass batch: every card that is
 * poolStatus ACTIVE and literally cardStatus "NEW" -- never presented at
 * all (section 3's own invariant), in the projected (post-virtual-refill)
 * view's own order. A card already cardStatus "LEARNING" with
 * learningStage "FRESH" HAS been presented at least once already (it is
 * simply awaiting its first success) and is never a first-pass candidate
 * -- it is an ordinary Active candidate instead (lib/learning-engine/
 * scheduler/active-selection.ts already handles it).
 */
function findNeverPresentedActiveNewCardIds(cards: readonly SchedulableCardRow[]): readonly string[] {
  return cards.filter((card) => card.poolStatus === "ACTIVE" && card.cardStatus === "NEW").map((card) => card.cardId);
}

/**
 * A batch of exactly one never-presented card needs no queue at all --
 * there is nothing for it to repeat against, so ordinary Active weighting
 * (which already treats a lone NEW+ACTIVE card as effective FRESH, Phase
 * 6C) handles it correctly on its own. A queue is only created once two
 * or more such cards exist simultaneously with no batch already in
 * flight -- this threshold, and the policy for what happens to a SECOND
 * wave of newly-admitted NEW cards that arrives while today's batch is
 * still in flight (they simply wait, ungrouped, until this batch empties
 * -- see this module's header), are this review's own interpretation of
 * an otherwise spec-unspecified case, flagged explicitly in the Phase 6E
 * first-pass report rather than treated as an obvious default.
 */
const MIN_FIRST_PASS_BATCH_SIZE = 2;

// =============================================================================
// Section 14-15 of the brief: the emergency all-sources-unavailable fallback
// =============================================================================

/**
 * Section 14: "the ONLY constraint v1 may relax is: ordinary Active
 * Correct cooldown." Never relaxes repair minimum gap/hard cap, spaced
 * confirmation minimum gap, or repair/relearning governance -- this
 * function's own filter excludes every repair/relearning-governed card
 * via isGovernedByRepairObligation (unchanged from Phase 4), the same
 * predicate every other ordinary-selection path already uses, so a
 * FORGOTTEN or REPAIR_PENDING/SPACED_CONFIRMATION_PENDING card can never
 * reach this branch (section 15's explicit safety requirements).
 *
 * The candidate set is restricted to cards that are ONLY blocked by
 * cooldown: by construction, this function only runs when ACTIVE's own
 * candidate count (computeActiveCandidateCount, covering starvation/
 * repair-target/spaced-confirmation/ordinary) is already zero, so any
 * acquisition-stage, non-governed ACTIVE card found here that is NOT
 * presently cooldown-blocked would already have been an ordinary
 * candidate -- a contradiction. The explicit `correctCooldownUntilPosition
 * !== null && schedulerPosition < ...` check is kept anyway, both as
 * defense-in-depth and to directly identify "how much longer would this
 * card have waited" for the closest-to-eligible tie-break.
 */
function selectEmergencyCooldownRelaxationCandidate(
  cards: readonly SchedulableCardRow[],
  schedulerPosition: number,
  random: RandomSource,
): SchedulableCardRow | null {
  const candidates = cards.filter((card) => {
    if (card.poolStatus !== "ACTIVE") {
      return false;
    }
    if (isGovernedByRepairObligation(card)) {
      return false;
    }
    const isOrdinaryAcquisitionStage =
      card.cardStatus === "NEW" ||
      (card.cardStatus === "LEARNING" && (card.learningStage === "FRESH" || card.learningStage === "LEARNING_1" || card.learningStage === "LEARNING_2"));
    if (!isOrdinaryAcquisitionStage) {
      return false;
    }
    return card.correctCooldownUntilPosition !== null && schedulerPosition < card.correctCooldownUntilPosition;
  });

  if (candidates.length === 0) {
    return null;
  }

  const soonest = Math.min(...candidates.map((card) => card.correctCooldownUntilPosition!));
  const closest = candidates.filter((card) => card.correctCooldownUntilPosition === soonest);

  if (closest.length === 1) {
    return closest[0];
  }

  const index = Math.min(Math.floor(random() * closest.length), closest.length - 1);
  return closest[index];
}

// =============================================================================
// Section 3 of the brief: the top-level pipeline
// =============================================================================

/**
 * The pure Learning Engine v1 next-card orchestrator (Phase 6E). See this
 * module's header for the full isolation/ordering discussion. Never
 * throws for a well-formed snapshot; the only `invariant` calls below
 * guard states that would mean an upstream module's own documented
 * contract was violated (e.g. a source reported non-empty but its
 * selector then found nothing), not states this function expects to see
 * in practice.
 */
export function chooseNextCard(snapshot: DeckSchedulerSnapshot, random: RandomSource): NextCardDecision {
  const { recorded, draws } = createRecordingRandom(random);

  const schedulerPosition = snapshot.deckState.schedulerPosition;
  const schedulerRevision = snapshot.deckState.schedulerRevision;
  const desiredRetention = snapshot.deckState.desiredRetention;
  const policyVersion = snapshot.deckState.policyVersion;
  const now = snapshot.now;

  // Steps 1-3: refresh/refill. Virtual only -- see computeVirtualActiveRefill.
  const { projectedCards, admittedCardIds } = computeVirtualActiveRefill(snapshot.cards);

  // Pure, RNG-free descriptive bookkeeping, computed once and reused by
  // every return path (including an interrupt short-circuit) -- see this
  // module's header for why this is safe ahead of the interrupt gate.
  const dueCandidateCount = selectDueCandidates(projectedCards, now).length;
  const nearDueCandidateCount = selectNearDueCandidates(projectedCards, now).length;
  const activeCandidateCount = computeActiveCandidateCount(projectedCards, schedulerPosition);

  const availability: SourceAvailability = {
    active: activeCandidateCount > 0,
    due: dueCandidateCount > 0,
    near: nearDueCandidateCount > 0,
  };

  const { mode, weights: sourceWeightsRaw } = computeSourceWeights(dueCandidateCount, snapshot.dailyGoal.completed);
  const sourceWeightsNormalized = renormalizeSourceWeights(sourceWeightsRaw, availability);

  const firstPassQueueBefore = normalizeFirstPassQueue(snapshot.deckState.firstPassQueue);

  function finalize(result: {
    cardId: string | null;
    source: NextCardSource;
    selectionReason: SelectionReason;
    cardPriorityWeight: number | null;
    retrievability: number | null;
    intervalProgress: number | null;
    emergencyFallbackApplied: boolean;
    firstPassQueueAfter: readonly string[] | null;
  }): NextCardDecision {
    const trace: SelectionTrace = {
      cardId: result.cardId,
      source: result.source,
      selectionReason: result.selectionReason,
      schedulerMode: mode,
      schedulerPosition,
      schedulerRevision,
      dueCount: dueCandidateCount,
      dailyGoalCompleteBefore: snapshot.dailyGoal.completed,
      sourceWeightsRaw,
      sourceWeightsNormalized,
      candidateCounts: { active: activeCandidateCount, due: dueCandidateCount, near: nearDueCandidateCount },
      cardPriorityWeight: result.cardPriorityWeight,
      retrievability: result.retrievability,
      intervalProgress: result.intervalProgress,
      admittedCardIds,
      policyVersion,
      emergencyFallbackApplied: result.emergencyFallbackApplied,
      firstPassQueueBefore,
      firstPassQueueAfter: result.firstPassQueueAfter,
      randomDraws: [...draws],
    };

    return {
      cardId: result.cardId,
      source: result.source,
      selectionReason: result.selectionReason,
      admittedCardIds,
      firstPassQueueAfter: result.firstPassQueueAfter,
      schedulerPosition,
      schedulerRevision,
      trace,
    };
  }

  // Steps 4-5 (section 6 of the brief): the GLOBAL interrupt gate. Fires
  // (and short-circuits -- no ordinary-source RNG is ever consumed) before
  // any source weighting/sampling.
  const globalInterrupt = findGlobalInterrupt({
    cards: projectedCards,
    schedulerPosition,
    now,
    desiredRetention,
    lastCriticalDuePosition: snapshot.deckState.lastCriticalDuePosition,
    random: recorded,
  });

  if (globalInterrupt !== null) {
    // PREEMPTION: a global interrupt never touches the first-pass queue --
    // it is reported back completely unchanged, whether null or non-null.
    const isCritical = globalInterrupt.reason === "critical_due_interrupt";
    return finalize({
      cardId: globalInterrupt.cardId,
      source: globalInterrupt.source,
      selectionReason: globalInterrupt.reason,
      cardPriorityWeight: isCritical ? computeDueWeight(globalInterrupt.retrievability, desiredRetention) : null,
      retrievability: isCritical ? globalInterrupt.retrievability : null,
      intervalProgress: null,
      emergencyFallbackApplied: false,
      firstPassQueueAfter: firstPassQueueBefore,
    });
  }

  // First-pass queue tier: strictly below the two global interrupts, strictly
  // above ordinary source selection. See this module's header for why no
  // other ordinary mechanism can ever run while a batch has unserved members.
  if (firstPassQueueBefore !== null) {
    const [servedCardId, ...remaining] = firstPassQueueBefore;
    return finalize({
      cardId: servedCardId,
      source: "ACTIVE",
      selectionReason: "active_first_pass",
      cardPriorityWeight: null,
      retrievability: null,
      intervalProgress: null,
      emergencyFallbackApplied: false,
      firstPassQueueAfter: remaining.length > 0 ? remaining : null,
    });
  }

  const creatableFirstPassBatch = findNeverPresentedActiveNewCardIds(projectedCards);
  if (creatableFirstPassBatch.length >= MIN_FIRST_PASS_BATCH_SIZE) {
    const shuffledBatch = buildFirstPassOrder(creatableFirstPassBatch, recorded);
    const [servedCardId, ...remaining] = shuffledBatch;
    return finalize({
      cardId: servedCardId,
      source: "ACTIVE",
      selectionReason: "active_first_pass",
      cardPriorityWeight: null,
      retrievability: null,
      intervalProgress: null,
      emergencyFallbackApplied: false,
      firstPassQueueAfter: remaining.length > 0 ? remaining : null,
    });
  }

  // Steps 6-10: ordinary source selection.
  const sourceEntries: { source: "ACTIVE" | "FSRS_DUE" | "NEAR_DUE"; weight: number }[] = [];
  if (availability.active) {
    sourceEntries.push({ source: "ACTIVE", weight: sourceWeightsNormalized.active });
  }
  if (availability.due) {
    sourceEntries.push({ source: "FSRS_DUE", weight: sourceWeightsNormalized.due });
  }
  if (availability.near) {
    sourceEntries.push({ source: "NEAR_DUE", weight: sourceWeightsNormalized.near });
  }

  // Step 12 (section 14 of the brief): all three ordinary sources are
  // empty -- the emergency fallback, never the ordinary weighted draw.
  if (sourceEntries.length === 0) {
    const relaxed = selectEmergencyCooldownRelaxationCandidate(projectedCards, schedulerPosition, recorded);
    if (relaxed === null) {
      return finalize({
        cardId: null,
        source: null,
        selectionReason: "no_card_all_unavailable",
        cardPriorityWeight: null,
        retrievability: null,
        intervalProgress: null,
        emergencyFallbackApplied: true,
        firstPassQueueAfter: firstPassQueueBefore,
      });
    }
    return finalize({
      cardId: relaxed.cardId,
      source: "ACTIVE",
      selectionReason: "emergency_cooldown_relaxation",
      cardPriorityWeight: null,
      retrievability: null,
      intervalProgress: null,
      emergencyFallbackApplied: true,
      firstPassQueueAfter: firstPassQueueBefore,
    });
  }

  const chosenSource = weightedRandomChoice(
    sourceEntries.map((entry) => ({ item: entry.source, weight: entry.weight })),
    recorded,
  );

  // Steps 11-13: select within the chosen source.
  if (chosenSource === "ACTIVE") {
    const selection = selectActiveInternalCard(projectedCards, schedulerPosition, recorded);
    invariant(selection !== null, "ACTIVE was chosen as the source but selectActiveInternalCard returned null despite a positive candidate count");

    return finalize({
      cardId: selection.cardId,
      source: "ACTIVE",
      selectionReason: selection.reason,
      cardPriorityWeight: selection.reason === "active_weighted_selection" ? selection.weight : null,
      retrievability: null,
      intervalProgress: null,
      emergencyFallbackApplied: false,
      firstPassQueueAfter: firstPassQueueBefore,
    });
  }

  if (chosenSource === "FSRS_DUE") {
    const selection = chooseDueCard(projectedCards, now, desiredRetention, recorded);
    invariant(selection !== null, "FSRS_DUE was chosen as the source but chooseDueCard returned null despite a positive candidate count");

    return finalize({
      cardId: selection.cardId,
      source: "FSRS_DUE",
      selectionReason: "due_weighted_selection",
      cardPriorityWeight: selection.weight,
      retrievability: selection.retrievability,
      intervalProgress: null,
      emergencyFallbackApplied: false,
      firstPassQueueAfter: firstPassQueueBefore,
    });
  }

  const selection = chooseNearDueCard(projectedCards, now, recorded);
  invariant(selection !== null, "NEAR_DUE was chosen as the source but chooseNearDueCard returned null despite a positive candidate count");

  return finalize({
    cardId: selection.cardId,
    source: "NEAR_DUE",
    selectionReason: "near_due_weighted_selection",
    cardPriorityWeight: selection.weight,
    retrievability: null,
    intervalProgress: selection.intervalProgress,
    emergencyFallbackApplied: false,
    firstPassQueueAfter: firstPassQueueBefore,
  });
}
