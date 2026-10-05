/**
 * Idempotent E2E fixture provisioning/cleanup. Runs only via
 * createAdminClient() (local-only guard enforced there and in
 * tests/e2e/env.ts), and only ever touches the deterministic identities in
 * ./identities.ts -- every delete in teardownE2eFixtures() is scoped to an
 * id looked up by one of those exact synthetic emails, never a pattern or
 * range match against the live table.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../admin-client";
import {
  ALL_E2E_PUBLIC_USER_IDS,
  MISSING_PROFILE_USER,
  PROFILE_FIXTURES,
  type ProfileFixture,
} from "./identities";
import { toSyntheticEmail } from "../../../lib/auth/constants";

async function findAuthUserIdByEmail(
  admin: SupabaseClient,
  email: string
): Promise<string | null> {
  const { data, error } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (error) throw error;
  return data.users.find((u) => u.email === email)?.id ?? null;
}

async function upsertAuthUser(
  admin: SupabaseClient,
  email: string,
  password: string
): Promise<string> {
  const existingId = await findAuthUserIdByEmail(admin, email);

  if (existingId) {
    const { error } = await admin.auth.admin.updateUserById(existingId, {
      password,
      email_confirm: true,
    });
    if (error) throw error;
    return existingId;
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  if (!data.user) {
    throw new Error(`createUser returned no user for ${email}`);
  }
  return data.user.id;
}

async function upsertProfile(
  admin: SupabaseClient,
  userId: string,
  fixture: ProfileFixture
): Promise<void> {
  const { error } = await admin.from("profiles").upsert(
    {
      id: userId,
      public_user_id: fixture.publicUserId,
      role: fixture.role,
      account_status: fixture.accountStatus,
      nickname: fixture.nickname,
      onboarding_completed: fixture.onboardingCompleted,
      selected_deck_id: null,
    },
    { onConflict: "id" }
  );
  if (error) throw error;
}

async function ensureNoProfile(
  admin: SupabaseClient,
  userId: string
): Promise<void> {
  const { error } = await admin.from("profiles").delete().eq("id", userId);
  if (error) throw error;
}

export async function setupE2eFixtures(): Promise<void> {
  const admin = createAdminClient();

  for (const fixture of PROFILE_FIXTURES) {
    const userId = await upsertAuthUser(admin, fixture.email, fixture.password);
    await upsertProfile(admin, userId, fixture);
  }

  const missingProfileUserId = await upsertAuthUser(
    admin,
    MISSING_PROFILE_USER.email,
    MISSING_PROFILE_USER.password
  );
  // Deliberately not upserted -- idempotently ensures no profile row
  // exists even if a prior run (or a bug) left one behind.
  await ensureNoProfile(admin, missingProfileUserId);
}

/**
 * Runtime Cutover RC-D addition: full teardown now also owns every
 * Learning Engine v1 trusted-state table a browser-smoke-tested v1
 * tester (RC_D_V1_SMOKE_TESTER) can leave behind -- selection_claims,
 * answer_events/learning_engine_selection_traces, xp_events,
 * daily_user_stats, sessions, user_deck_learning_state, and the
 * learning_engine_v1_rollout row itself. Mirrors
 * tests/integration/fixtures/setup.ts's deleteOwnedLearnerData() (same
 * FK-RESTRICT-respecting order, same "fullAccountDeletion" RPC for the
 * one-way-guarded rollout row) rather than re-deriving it -- this is a
 * genuine account teardown (the auth user is deleted right after this
 * returns), so the account-deletion bypass is always the correct choice
 * here, unconditionally. A no-op for every OTHER existing E2E fixture,
 * which has none of these rows.
 */
async function deleteOwnedDeckData(
  admin: SupabaseClient,
  userId: string
): Promise<void> {
  const { error: rolloutError } = await admin.rpc(
    "delete_learning_engine_v1_rollout_for_account_deletion",
    { p_user_id: userId }
  );
  if (rolloutError) throw rolloutError;

  const { error: selectionClaimsError } = await admin
    .from("selection_claims")
    .delete()
    .eq("user_id", userId);
  if (selectionClaimsError) throw selectionClaimsError;

  const { error: answerEventsError } = await admin
    .from("answer_events")
    .delete()
    .eq("user_id", userId);
  if (answerEventsError) throw answerEventsError;

  const { error: selectionTracesError } = await admin
    .from("learning_engine_selection_traces")
    .delete()
    .eq("user_id", userId);
  if (selectionTracesError) throw selectionTracesError;

  const { error: xpEventsError } = await admin
    .from("xp_events")
    .delete()
    .eq("user_id", userId);
  if (xpEventsError) throw xpEventsError;

  const { error: dailyStatsError } = await admin
    .from("daily_user_stats")
    .delete()
    .eq("user_id", userId);
  if (dailyStatsError) throw dailyStatsError;

  // session_review_cards/session_learning_queue CASCADE from sessions.
  const { error: sessionsError } = await admin
    .from("sessions")
    .delete()
    .eq("user_id", userId);
  if (sessionsError) throw sessionsError;

  const { data: decks, error: decksError } = await admin
    .from("decks")
    .select("id")
    .eq("owner_user_id", userId);
  if (decksError) throw decksError;

  const deckIds = (decks ?? []).map((d: { id: string }) => d.id);

  const { error: progressError } = await admin
    .from("user_card_progress")
    .delete()
    .eq("user_id", userId);
  if (progressError) throw progressError;

  const { error: deckLearningStateError } = await admin
    .from("user_deck_learning_state")
    .delete()
    .eq("user_id", userId);
  if (deckLearningStateError) throw deckLearningStateError;

  if (deckIds.length > 0) {
    const { error: cardsError } = await admin
      .from("cards")
      .delete()
      .in("deck_id", deckIds);
    if (cardsError) throw cardsError;

    const { error: deleteDecksError } = await admin
      .from("decks")
      .delete()
      .in("id", deckIds);
    if (deleteDecksError) throw deleteDecksError;
  }
}

export async function teardownE2eFixtures(): Promise<void> {
  const admin = createAdminClient();

  for (const publicUserId of ALL_E2E_PUBLIC_USER_IDS) {
    const email = toSyntheticEmail(publicUserId);
    const userId = await findAuthUserIdByEmail(admin, email);
    if (!userId) continue;

    await deleteOwnedDeckData(admin, userId);

    // profiles.id -> auth.users.id is ON DELETE RESTRICT (identity_and_
    // content_tables.sql), so the profile row (if any) must go before the
    // auth user. No-op if this id is the missing-profile fixture.
    const { error: profileError } = await admin
      .from("profiles")
      .delete()
      .eq("id", userId);
    if (profileError) throw profileError;

    const { error: authError } = await admin.auth.admin.deleteUser(userId);
    if (authError) throw authError;
  }
}
