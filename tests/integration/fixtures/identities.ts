/**
 * Deterministic Phase E integration-test-only tester identities. All
 * public_user_id values are in the 9xx range, deliberately outside
 * 001-030/999 (the real Beta account range) and outside 8xx (the existing
 * Playwright E2E suite's range, tests/e2e/fixtures/identities.ts) --
 * separate ranges so the two suites can never collide on fixture data even
 * if run against the same local stack at overlapping times.
 */

import { isValidPublicUserIdFormat, toSyntheticEmail } from "../../../lib/auth/constants";

export const INTEGRATION_PASSWORD = "Integration-Test-Passw0rd-1";

export interface TesterIdentity {
  readonly publicUserId: string;
  readonly email: string;
  readonly password: string;
}

function tester(publicUserId: string): TesterIdentity {
  return {
    publicUserId,
    email: toSyntheticEmail(publicUserId),
    password: INTEGRATION_PASSWORD,
  };
}

// One tester per scenario group, so scenarios never share mutable
// session/progress state and can run in any order.
export const CORE_ANSWER_TESTER = tester("901"); // scenarios 5-6: correct/wrong answer
export const REPLAY_TESTER = tester("902"); // scenario 7-8: idempotent replay, misuse
export const STALE_TESTER = tester("903"); // scenario 9: stale snapshot / concurrency
export const ENEMY_DEFEAT_TESTER = tester("904"); // scenario 10: enemy defeat/respawn
export const QUEUE_TESTER = tester("905"); // scenario 11: review/learning queue transition
export const LIFECYCLE_TESTER = tester("906"); // scenario 12: card lifecycle
export const DAILY_GOAL_TESTER = tester("907"); // scenario 13: Daily Goal/streak
export const TIMESTAMP_TESTER = tester("908"); // scenario 15: timestamp round-trip
export const RLS_TESTER_A = tester("909"); // scenario 14: RLS isolation
export const RLS_TESTER_B = tester("910"); // scenario 14: RLS isolation
export const NEXT_CARD_TESTER = tester("911"); // scenario 16: get_next_session_card()
export const WRONG_FLOOR_TESTER = tester("912"); // scenario 17: Learning Wrong reappearance floor
export const DECK_SELECTION_TESTER = tester("913"); // P3 Decks: select_deck() / deck-switch session behavior
export const STATS_TESTER_A = tester("914"); // P3 Stats: aggregation across daily_user_stats/profiles/user_card_progress
export const STATS_TESTER_B = tester("915"); // P3 Stats: cross-tester isolation
export const TELEMETRY_TESTER_A = tester("916"); // Learning Engine v1 Phase 8: telemetry persistence
export const TELEMETRY_TESTER_B = tester("917"); // Learning Engine v1 Phase 8: telemetry cross-entity rejection
export const RC_B_CLAIM_TESTER_A = tester("918"); // Learning Engine v1 Runtime Cutover RC-B: selection claim transaction
export const RC_B_CLAIM_TESTER_B = tester("919"); // Learning Engine v1 Runtime Cutover RC-B: cross-user isolation
export const RC_C_ANSWER_TESTER_A = tester("920"); // Learning Engine v1 Runtime Cutover RC-C: answer commit transaction
export const RC_C_ANSWER_TESTER_B = tester("921"); // Learning Engine v1 Runtime Cutover RC-C: concurrent claim/answer convergence
export const RC_C_ANSWER_TESTER_C = tester("922"); // Learning Engine v1 Runtime Cutover RC-C: rollout-invariant rejection (deliberately never enrolled)
export const RC_C_ANSWER_TESTER_D = tester("923"); // Learning Engine v1 Runtime Cutover RC-C: full account deletion of a one-way-zone user
export const RC_D_V1_ROUTING_TESTER = tester("924"); // Learning Engine v1 Runtime Cutover RC-D: enrolled user, full live v1 routing flow
export const RC_D_LEGACY_ROUTING_TESTER = tester("925"); // Learning Engine v1 Runtime Cutover RC-D: never-enrolled user, legacy routing stays unchanged
export const RC_F_CROSS_SESSION_POSITION_TESTER = tester("926"); // Runtime Cutover RC-F acceptance: deck-global scheduler_position continuity across a real finish-then-resume Session boundary, vs. Session-local session_position restarting
export const POSITION_SEMANTICS_TESTER = tester("927"); // Stage 0 audit follow-up: real claim+commit pipeline proof of the Repair-timing/Correct-cooldown position-semantics fix

export const ALL_INTEGRATION_TESTERS: readonly TesterIdentity[] = [
  CORE_ANSWER_TESTER,
  REPLAY_TESTER,
  STALE_TESTER,
  ENEMY_DEFEAT_TESTER,
  QUEUE_TESTER,
  LIFECYCLE_TESTER,
  DAILY_GOAL_TESTER,
  TIMESTAMP_TESTER,
  RLS_TESTER_A,
  RLS_TESTER_B,
  NEXT_CARD_TESTER,
  WRONG_FLOOR_TESTER,
  DECK_SELECTION_TESTER,
  STATS_TESTER_A,
  STATS_TESTER_B,
  TELEMETRY_TESTER_A,
  TELEMETRY_TESTER_B,
  RC_B_CLAIM_TESTER_A,
  RC_B_CLAIM_TESTER_B,
  RC_C_ANSWER_TESTER_A,
  RC_C_ANSWER_TESTER_B,
  RC_C_ANSWER_TESTER_C,
  RC_C_ANSWER_TESTER_D,
  RC_D_V1_ROUTING_TESTER,
  RC_D_LEGACY_ROUTING_TESTER,
  RC_F_CROSS_SESSION_POSITION_TESTER,
  POSITION_SEMANTICS_TESTER,
];

const BETA_OR_E2E_RANGE_PATTERN = /^(0[0-3][0-9]|999|8\d\d)$/;

for (const { publicUserId } of ALL_INTEGRATION_TESTERS) {
  if (!isValidPublicUserIdFormat(publicUserId)) {
    throw new Error(`Integration fixture id "${publicUserId}" is not a valid public_user_id format.`);
  }
  if (BETA_OR_E2E_RANGE_PATTERN.test(publicUserId)) {
    throw new Error(
      `Integration fixture id "${publicUserId}" collides with the reserved Beta account range ` +
        `(001-030, 999) or the E2E suite's range (8xx) -- refusing to load fixtures.`,
    );
  }
}
