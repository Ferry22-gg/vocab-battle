/**
 * Deterministic E2E-only test identities. All public_user_id values are in
 * the 8xx range, deliberately outside 001-030 and 999 -- the real Beta
 * account range (lib/auth/constants.ts's PUBLIC_USER_ID_PATTERN just
 * requires 3 digits, so 8xx is a format-valid but Beta-range-disjoint
 * block reserved for this suite). Nothing here provisions or touches a
 * real Beta account.
 */

import {
  isValidPublicUserIdFormat,
  toSyntheticEmail,
} from "../../../lib/auth/constants";

export const E2E_PASSWORD = "E2E-Test-Passw0rd-1";

export type ProfileFixture = {
  publicUserId: string;
  email: string;
  password: string;
  role: "tester" | "admin";
  accountStatus: "active" | "disabled";
  nickname: string | null;
  onboardingCompleted: boolean;
};

function tester(
  publicUserId: string,
  overrides: Partial<ProfileFixture> = {}
): ProfileFixture {
  return {
    publicUserId,
    email: toSyntheticEmail(publicUserId),
    password: E2E_PASSWORD,
    role: "tester",
    accountStatus: "active",
    nickname: null,
    onboardingCompleted: false,
    ...overrides,
  };
}

// Fresh active tester: no nickname, no deck. Drives the full
// login -> nickname -> deck -> Home happy path (scenario C).
export const FRESH_TESTER = tester("801");

// Already has a nickname set, so it can serve as the "taken" nickname
// this suite tries to collide with -- independent of scenario C's own
// runtime nickname choice, so scenario D doesn't depend on scenario C
// having run first.
export const NICKNAME_HOLDER = tester("802", { nickname: "E2ENickname" });

// Attempts a case-insensitive duplicate of NICKNAME_HOLDER's nickname
// (scenario D).
export const DUPLICATE_NICKNAME_TESTER = tester("803");

// Active Auth session, but account_status = 'disabled' (scenario E).
export const DISABLED_TESTER = tester("804", { accountStatus: "disabled" });

// role = 'admin' (scenario F).
export const ADMIN = tester("805", { role: "admin" });

// Learning Engine v1 Runtime Cutover RC-D browser smoke test: enrolled in
// the v1 rollout (by the test itself, via the real enrollment path,
// AFTER onboarding creates their deck) -- drives the live v1 Session
// routing flow through the actual UI.
export const RC_D_V1_SMOKE_TESTER = tester("807");

// RC-D browser smoke test: never enrolled -- proves the legacy flow is
// completely unchanged.
export const RC_D_LEGACY_SMOKE_TESTER = tester("808");

// Auth user only -- deliberately no matching profiles row (scenario G).
export const MISSING_PROFILE_USER = {
  publicUserId: "806",
  email: toSyntheticEmail("806"),
  password: E2E_PASSWORD,
};

export const PROFILE_FIXTURES: ProfileFixture[] = [
  FRESH_TESTER,
  NICKNAME_HOLDER,
  DUPLICATE_NICKNAME_TESTER,
  DISABLED_TESTER,
  ADMIN,
  RC_D_V1_SMOKE_TESTER,
  RC_D_LEGACY_SMOKE_TESTER,
];

export const ALL_E2E_PUBLIC_USER_IDS = [
  ...PROFILE_FIXTURES.map((f) => f.publicUserId),
  MISSING_PROFILE_USER.publicUserId,
];

const BETA_RANGE_PATTERN = /^(0[0-3][0-9]|999)$/;

for (const id of ALL_E2E_PUBLIC_USER_IDS) {
  if (!isValidPublicUserIdFormat(id)) {
    throw new Error(`E2E fixture id "${id}" is not a valid public_user_id format.`);
  }
  if (BETA_RANGE_PATTERN.test(id)) {
    throw new Error(
      `E2E fixture id "${id}" collides with the reserved Beta account range ` +
        `(001-030, 999) -- refusing to load fixtures.`
    );
  }
}
