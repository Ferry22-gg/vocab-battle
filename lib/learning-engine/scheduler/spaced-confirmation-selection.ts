/**
 * Learning Engine v1 -- spaced-confirmation candidate selection (Phase
 * 6C of the implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 13
 * ("Repair of long-term failures / Relearning"), via Phase 4's
 * isSpacedConfirmationDue (lib/learning-engine/repair-scheduler.ts).
 *
 * This channel is kept conceptually distinct from ACTIVE/FSRS_DUE/
 * NEAR_DUE, per the Phase 6C brief: a SPACED_CONFIRMATION_PENDING card
 * is never folded into lib/learning-engine/scheduler/active-selection.ts
 * (it has no learningStage and is already excluded there by
 * isGovernedByRepairObligation), and no new global source-weight
 * percentage is invented for it -- the spec gives none, and it is not
 * reached by the top-level Dynamic Source Weight draw at all. It is
 * reached only via the approved ACTIVE-source internal ordering
 * documented in lib/learning-engine/scheduler/active-selection.ts's
 * module header (step 3, below the Active starvation guarantee and a
 * target-reached Repair candidate, above an ordinary weighted Active
 * candidate) -- wiring that ordering is Phase 6D/6E's job, not this
 * module's.
 *
 * ---------------------------------------------------------------------
 * Resolved in review: priority among multiple simultaneously-due spaced
 * confirmations
 * ---------------------------------------------------------------------
 * Approved rule (review decision, not independently derived from the
 * spec -- section 13 only ever describes one card's relearning episode
 * in isolation, and unlike repair collisions, section 35.2's "oldest
 * Wrong / earliest hard cap first" does not apply here, since a spaced
 * confirmation has no "Wrong position" or hard cap of its own):
 *   - the candidate with the smallest correctCooldownUntilPosition wins
 *     -- i.e. whichever card's 5-intervening-card gate opened earliest;
 *   - injected RandomSource tie-break ONLY for an exact tie (the same
 *     "random tie-break only when priority is genuinely equal" principle
 *     lib/learning-engine/repair-scheduler.ts's selectRepairCandidate
 *     already follows for repairs -- the same shape of rule, re-derived
 *     here rather than literally sharing code with that function, since
 *     the two operate on structurally different inputs
 *     (correctCooldownUntilPosition here vs. wrongPosition there) and
 *     Phase 6C's brief does not ask for a cross-module refactor of
 *     already-reviewed Phase 4 code).
 * This is NOT weighted-random selection -- no probability is involved,
 * only a deterministic priority with a tie-break, exactly like repair
 * collision resolution.
 */

import { isSpacedConfirmationDue } from "@/lib/learning-engine/repair-scheduler";
import type { RandomSource } from "@/lib/learning-engine/scheduler/weighted-random";
import type { SchedulableCardRow } from "@/lib/learning-engine/scheduler/snapshot";

export interface SpacedConfirmationCandidate {
  readonly cardId: string;
  readonly correctCooldownUntilPosition: number;
}

function toSpacedConfirmationCandidate(card: SchedulableCardRow, schedulerPosition: number): SpacedConfirmationCandidate | null {
  if (!isSpacedConfirmationDue(card, schedulerPosition)) {
    return null;
  }
  // isSpacedConfirmationDue being true means isEligibleForNormalSelection
  // was true for this card, which alone permits correctCooldownUntilPosition
  // to be null (no cooldown ever set) as well as "position reached" --
  // but a card that is genuinely relearningPhase === SPACED_CONFIRMATION_PENDING
  // only ever reaches that phase via resolveRelearningRepairCorrect
  // (lib/learning-engine/repair-scheduler.ts), which always sets this
  // field via applyCorrectCooldown (never null). Asserted explicitly
  // rather than silently treated as "no priority information" -- a null
  // value here would mean that invariant was violated upstream.
  if (card.correctCooldownUntilPosition === null) {
    throw new Error(
      `spaced-confirmation-selection: card ${card.cardId} is due for spaced confirmation but has no correctCooldownUntilPosition -- invariant violation`,
    );
  }
  return { cardId: card.cardId, correctCooldownUntilPosition: card.correctCooldownUntilPosition };
}

/**
 * Every card currently due for its mandatory Spaced Correct (section
 * 13's "at least 5 intervening cards -> Spaced Correct", already gated
 * by Phase 4's isSpacedConfirmationDue). Exported alongside
 * selectDueSpacedConfirmationCard so a caller that only needs the raw
 * set (e.g. for a candidate count in a future decision trace) is not
 * forced to also resolve a winner.
 */
export function selectSpacedConfirmationCandidates(
  cards: readonly SchedulableCardRow[],
  schedulerPosition: number,
): readonly SpacedConfirmationCandidate[] {
  const candidates: SpacedConfirmationCandidate[] = [];
  for (const card of cards) {
    const candidate = toSpacedConfirmationCandidate(card, schedulerPosition);
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * Resolves exactly one winner among every currently-due spaced
 * confirmation, per this module's approved priority rule (above):
 * smallest correctCooldownUntilPosition first, injected RNG tie-break
 * only on an exact match. Returns `null` for a genuinely empty candidate
 * set, never throws (Phase 6C brief section 9's "prefer null" rule,
 * applied uniformly across every selector in this phase).
 */
export function selectDueSpacedConfirmationCard(
  cards: readonly SchedulableCardRow[],
  schedulerPosition: number,
  random: RandomSource,
): SpacedConfirmationCandidate | null {
  const candidates = selectSpacedConfirmationCandidates(cards, schedulerPosition);
  if (candidates.length === 0) {
    return null;
  }

  const earliestGatePosition = Math.min(...candidates.map((candidate) => candidate.correctCooldownUntilPosition));
  const earliest = candidates.filter((candidate) => candidate.correctCooldownUntilPosition === earliestGatePosition);

  if (earliest.length === 1) {
    return earliest[0];
  }

  const index = Math.min(Math.floor(random() * earliest.length), earliest.length - 1);
  return earliest[index];
}
