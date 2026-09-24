/**
 * profiles.nickname has no length check at the DB level (see
 * supabase/migrations/20260921151534_identity_and_content_tables.sql --
 * only `profiles_nickname_lower_idx`, a case-insensitive uniqueness index,
 * constrains it). This cap is an application-only MVP choice: long enough
 * for a real display name, short enough to stay readable next to other
 * testers' names in battle UI. Not backed by a DB constraint, so a future
 * migration should add a matching `check (length(nickname) <= 20)` if this
 * value is ever revisited -- until then, this is the only enforcement.
 */
export const NICKNAME_MAX_LENGTH = 20;
