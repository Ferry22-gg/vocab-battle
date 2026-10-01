/**
 * Learning Engine v1 -- desired retention resolution (Phase 5 of the
 * implementation plan).
 *
 * Source of truth: docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections
 * 14.3 ("Desired retention") and 27.2 ("pain_point" onboarding mapping).
 *
 * Pure: takes the already-read preference value and returns the resolved
 * retention. Does NOT read user_learning_preferences or write
 * user_deck_learning_state.desired_retention itself -- those are DAL/
 * orchestration concerns for whichever later phase wires this into the
 * database (consistent with every other lib/learning-engine/ module
 * staying DB-independent). Phase 1 already created both tables this
 * resolution feeds: user_learning_preferences.pain_point is the input,
 * user_deck_learning_state.desired_retention is where a caller would
 * persist this function's output.
 */

import { DEFAULT_DESIRED_RETENTION, RETENTION_LOSS_DESIRED_RETENTION } from "@/lib/learning-engine/config";

/**
 * Mirrors user_learning_preferences.pain_point's CHECK constraint
 * (supabase/migrations/20261001000000_learning_engine_v1_additive_schema.sql):
 * 'retention_loss' | 'creation_cost' | 'boredom' | null.
 */
export type PainPoint = "retention_loss" | "creation_cost" | "boredom" | null;

/**
 * Section 14.3: "Default: 0.90. If onboarding pain_point = retention_loss:
 * 0.92. This is a preference prior, not an inference that the user has
 * poor memory." Section 27.2 is explicit that no OTHER pain_point value
 * changes this ('creation_cost'/'boredom' get "No Learning Engine
 * parameter change").
 *
 * Null-safe by construction: a missing/unset preference (the common case
 * today, since no onboarding UI writes pain_point yet -- see Phase 1's
 * migration comments) falls through to the default, exactly like every
 * other unrecognized value. This function can never throw.
 */
export function resolveDesiredRetention(painPoint: PainPoint): number {
  return painPoint === "retention_loss" ? RETENTION_LOSS_DESIRED_RETENTION : DEFAULT_DESIRED_RETENTION;
}
