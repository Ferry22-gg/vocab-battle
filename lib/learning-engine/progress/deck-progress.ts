/**
 * Pure Deck Progress classification/contribution/aggregation (spec section
 * 28.2). UX process weights only -- NOT FSRS retrievability, recall
 * probability, or mastery probability (spec section 28.2's own caveat). A
 * lapse (LEARNED -> FORGOTTEN) may reduce Deck Progress; that is allowed.
 *
 * Phase 9 decision (docs/LEARNING_ENGINE_V1_RUNTIME_CUTOVER_TODO.md, "Deck
 * Progress live rendering"): this module is complete and fully unit-tested
 * now, but no page wires computeDeckProgress() into a rendered
 * percentage/bar yet. Every live user_card_progress row with card_status =
 * 'LEARNING' currently has learning_stage = NULL -- the legacy runtime
 * never wrote it, and the v1 Active Pool admission logic that would is not
 * live yet (supabase/migrations/20261001000000_learning_engine_v1_additive_schema.sql's
 * own backfill comment: "Populating these now would mean guessing Active
 * Pool membership before Phase 3's admission logic ... exists at all").
 * classifyDeckProgressState() returns an explicit `incomplete` result for
 * that exact shape rather than guessing a stage -- see
 * ClassifyDeckProgressResult's doc comment for why no fallback/average/
 * inferred value is used instead. This is a data-authoritativeness
 * boundary, not an unfinished metric definition.
 */

import { DECK_PROGRESS_CONTRIBUTION } from "@/lib/learning-engine/config";
import type { CardStatus, LearningStage } from "@/lib/learning-engine/state";

/** Every bucket the Deck Progress contribution table (spec section 28.2) assigns a weight to. */
export type DeckProgressBucket = keyof typeof DECK_PROGRESS_CONTRIBUTION;

export function cardProgressContribution(bucket: DeckProgressBucket): number {
  return DECK_PROGRESS_CONTRIBUTION[bucket];
}

/**
 * The minimal per-card shape classifyDeckProgressState() needs -- a subset
 * of LearningEngineCardState (state.ts), not the whole thing, since Deck
 * Progress is explicitly NOT derived from pool membership or FSRS values.
 */
export interface DeckProgressCardInput {
  readonly cardStatus: CardStatus;
  readonly learningStage: LearningStage;
}

export type ClassifyDeckProgressResult =
  | { readonly kind: "classified"; readonly bucket: DeckProgressBucket }
  /**
   * `cardStatus === "LEARNING"` with `learningStage === null`: a correct v1
   * implementation never produces this combination (spec section 5.1 /
   * state.ts's own `LearningStage` doc comment: "Only meaningful while
   * cardStatus === 'LEARNING'; null otherwise" implies it is always
   * non-null there) -- but every live legacy row in this exact shape has
   * it today, because the v1 Active Pool admission logic that assigns a
   * real stage has not shipped yet. This result exists so that gap can
   * never silently become a numeric contribution -- see the module header
   * and computeDeckProgress() below. Deliberately not a thrown error: a
   * real pre-cutover legacy row in this shape is an expected, not
   * exceptional, input.
   */
  | { readonly kind: "incomplete" };

/**
 * Classifies one card's v1 progress state into exactly one Deck Progress
 * bucket (spec section 28.2), or `incomplete` when the input cannot be
 * classified under the v1 state model (see ClassifyDeckProgressResult's
 * `incomplete` case doc comment).
 *
 * Deliberately takes ONLY cardStatus/learningStage -- never poolStatus. A
 * `NEW` card may already have `pool_status = 'ACTIVE'` (occupying Fresh
 * capacity) while still backend-NEW (spec section 3.1: "Entering Active
 * does not change NEW -> LEARNING"); Deck Progress is a learner-state
 * metric, not a scheduler-capacity metric, so pool_status must never
 * influence this classification.
 */
export function classifyDeckProgressState(card: DeckProgressCardInput): ClassifyDeckProgressResult {
  switch (card.cardStatus) {
    case "NEW":
      return { kind: "classified", bucket: "NEW" };
    case "ACQUIRED":
      return { kind: "classified", bucket: "ACQUIRED" };
    case "LEARNED":
      return { kind: "classified", bucket: "LEARNED" };
    case "FORGOTTEN":
      return { kind: "classified", bucket: "FORGOTTEN" };
    case "LEARNING":
      switch (card.learningStage) {
        case "FRESH":
          return { kind: "classified", bucket: "FRESH" };
        case "LEARNING_1":
          return { kind: "classified", bucket: "LEARNING_1" };
        case "LEARNING_2":
          return { kind: "classified", bucket: "LEARNING_2" };
        case null:
          return { kind: "incomplete" };
      }
  }
}

export type DeckProgressResult =
  | { readonly kind: "empty" }
  | { readonly kind: "incomplete" }
  | { readonly kind: "ok"; readonly progress: number };

/**
 * Deck Progress = sum(card contribution) / total_cards (spec section
 * 28.2). Returns `empty` for a zero-card deck (division by zero is never
 * attempted) and `incomplete` the moment any single card cannot be
 * classified -- never a partial/averaged-over-the-classifiable-subset
 * number. This is the invariant the Phase 9 decision requires: "never
 * silently skip an unclassifiable LEARNING card and still claim an
 * authoritative percentage."
 */
export function computeDeckProgress(cards: readonly DeckProgressCardInput[]): DeckProgressResult {
  if (cards.length === 0) {
    return { kind: "empty" };
  }

  let total = 0;
  for (const card of cards) {
    const classified = classifyDeckProgressState(card);
    if (classified.kind === "incomplete") {
      return { kind: "incomplete" };
    }
    total += cardProgressContribution(classified.bucket);
  }

  return { kind: "ok", progress: total / cards.length };
}
