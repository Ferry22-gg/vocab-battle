/**
 * Idempotent Phase E integration fixture provisioning/cleanup. Runs only
 * via createAdminClient() (local-only guard enforced in
 * tests/integration/env.ts), and only ever touches the deterministic
 * identities in ./identities.ts -- every delete in
 * teardownIntegrationFixtures() is scoped to an id looked up by one of
 * those exact synthetic emails, never a pattern or range match against
 * the live table.
 *
 * Deletion order respects the FK RESTRICT chain (docs/DATABASE_SCHEMA.md
 * 4): answer_events/xp_events/daily_user_stats reference profiles/
 * sessions/cards/decks with ON DELETE RESTRICT, so they must go first;
 * session_review_cards/session_learning_queue CASCADE from sessions, so
 * deleting sessions after answer_events handles those automatically;
 * cards and decks follow; profiles and finally the auth user go last.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../admin-client";
import { ALL_INTEGRATION_TESTERS, INTEGRATION_PASSWORD, type TesterIdentity } from "./identities";

async function findAuthUserIdByEmail(admin: SupabaseClient, email: string): Promise<string | null> {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) throw error;
  return data.users.find((u) => u.email === email)?.id ?? null;
}

async function upsertAuthUser(admin: SupabaseClient, email: string, password: string): Promise<string> {
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

async function upsertTesterProfile(admin: SupabaseClient, userId: string, publicUserId: string): Promise<void> {
  const { error } = await admin.from("profiles").upsert(
    {
      id: userId,
      public_user_id: publicUserId,
      role: "tester",
      account_status: "active",
      nickname: null,
      onboarding_completed: false,
      selected_deck_id: null,
    },
    { onConflict: "id" },
  );
  if (error) throw error;
}

export async function setupIntegrationFixtures(): Promise<void> {
  const admin = createAdminClient();

  for (const identity of ALL_INTEGRATION_TESTERS) {
    const userId = await upsertAuthUser(admin, identity.email, INTEGRATION_PASSWORD);
    await upsertTesterProfile(admin, userId, identity.publicUserId);
  }
}

async function deleteOwnedLearnerData(admin: SupabaseClient, userId: string): Promise<void> {
  const { error: answerEventsError } = await admin.from("answer_events").delete().eq("user_id", userId);
  if (answerEventsError) throw answerEventsError;

  const { error: xpEventsError } = await admin.from("xp_events").delete().eq("user_id", userId);
  if (xpEventsError) throw xpEventsError;

  const { error: dailyStatsError } = await admin.from("daily_user_stats").delete().eq("user_id", userId);
  if (dailyStatsError) throw dailyStatsError;

  // session_review_cards/session_learning_queue CASCADE from sessions.
  const { error: sessionsError } = await admin.from("sessions").delete().eq("user_id", userId);
  if (sessionsError) throw sessionsError;

  const { error: progressError } = await admin.from("user_card_progress").delete().eq("user_id", userId);
  if (progressError) throw progressError;

  const { data: decks, error: decksError } = await admin
    .from("decks")
    .select("id")
    .eq("owner_user_id", userId);
  if (decksError) throw decksError;

  const deckIds = (decks ?? []).map((d: { id: string }) => d.id);

  if (deckIds.length > 0) {
    const { error: cardsError } = await admin.from("cards").delete().in("deck_id", deckIds);
    if (cardsError) throw cardsError;

    const { error: deleteDecksError } = await admin.from("decks").delete().in("id", deckIds);
    if (deleteDecksError) throw deleteDecksError;
  }
}

export async function teardownIntegrationFixtures(): Promise<void> {
  const admin = createAdminClient();

  for (const identity of ALL_INTEGRATION_TESTERS) {
    const userId = await findAuthUserIdByEmail(admin, identity.email);
    if (!userId) continue;

    await deleteOwnedLearnerData(admin, userId);

    // profiles.id -> auth.users.id is ON DELETE RESTRICT, so the profile
    // row must go before the auth user.
    const { error: profileError } = await admin.from("profiles").delete().eq("id", userId);
    if (profileError) throw profileError;

    const { error: authError } = await admin.auth.admin.deleteUser(userId);
    if (authError) throw authError;
  }
}

/**
 * Resets one tester's learner data (answer_events/xp_events/
 * daily_user_stats/sessions/user_card_progress/decks/cards) without
 * deleting their auth user/profile, so a `beforeEach` can start each test
 * from a clean slate without re-provisioning identity on every test.
 */
export async function resetTesterLearnerData(identity: TesterIdentity): Promise<string> {
  const admin = createAdminClient();
  const userId = await findAuthUserIdByEmail(admin, identity.email);
  if (!userId) {
    throw new Error(`resetTesterLearnerData: no auth user for ${identity.email} -- run global setup first`);
  }
  await deleteOwnedLearnerData(admin, userId);

  // Also clear selected_deck_id/onboarding_completed so a fresh
  // duplicate_starter_deck() call behaves like a first-time onboarding,
  // not an idempotent re-selection of a deleted deck.
  const { error } = await admin
    .from("profiles")
    .update({ selected_deck_id: null, onboarding_completed: false })
    .eq("id", userId);
  if (error) throw error;

  return userId;
}
