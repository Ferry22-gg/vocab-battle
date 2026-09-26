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
