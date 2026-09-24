/**
 * A Beta public_user_id (e.g. "001", "999") is not a valid Supabase Auth
 * identifier -- Supabase Auth signs in with email/phone, not an arbitrary
 * ID (DATABASE_SCHEMA.md section 6.2). This module is the single place that
 * derives a synthetic, never-shown, never-typed email from that ID, so the
 * placeholder domain can be swapped in one spot before real Beta accounts
 * (001-030, 999) are ever provisioned.
 *
 * The synthetic email must never be exposed in the UI or returned from any
 * application-facing profile data -- it exists only to satisfy Supabase
 * Auth's API shape server-side.
 */

const SYNTHETIC_EMAIL_DOMAIN = "auth.vocabbattle.invalid";

const PUBLIC_USER_ID_PATTERN = /^\d{3}$/;

export function isValidPublicUserIdFormat(value: string): boolean {
  return PUBLIC_USER_ID_PATTERN.test(value);
}

export function toSyntheticEmail(publicUserId: string): string {
  return `beta-${publicUserId}@${SYNTHETIC_EMAIL_DOMAIN}`;
}
