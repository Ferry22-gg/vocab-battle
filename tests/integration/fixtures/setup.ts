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

interface DeleteOwnedLearnerDataOptions {
  /**
   * true only when this call is immediately followed by deleting the
   * profile and auth user too (teardownIntegrationFixtures) -- a genuine
   * full account deletion. false (default) for a mid-lifecycle reset
   * that keeps the profile/auth identity alive (resetTesterLearnerData,
   * used between individual tests) -- the one-way rollout guard
   * (supabase/migrations/20261015000000_learning_engine_v1_rollout_one_way_guard.sql)
   * must keep protecting a permanent row for as long as the user still
   * exists, so a mid-lifecycle reset must NEVER erase one (that would be
   * exactly the "live user falls back to legacy" hole the guard exists
   * to close) -- it leaves a permanent row in place and simply no-ops.
   */
  readonly fullAccountDeletion?: boolean;
}

async function deleteOwnedLearnerData(admin: SupabaseClient, userId: string, options: DeleteOwnedLearnerDataOptions = {}): Promise<void> {
  // learning_engine_v1_rollout (Runtime Cutover RC-A) references
  // profiles with ON DELETE RESTRICT -- must go before any eventual
  // profile delete (teardownIntegrationFixtures below). No other table
  // references INTO it, so deleting it first/independently is always safe.
  if (options.fullAccountDeletion) {
    // The one sanctioned bypass (supabase/migrations/
    // 20261016000000_learning_engine_v1_rollout_account_deletion.sql):
    // removes the row even when first_v1_answer_at is set, since this
    // call is part of a genuine full account deletion (the profile and
    // auth user are deleted right after this returns, below). A no-op if
    // the user has no rollout row at all.
    const { error: rolloutDeletionError } = await admin.rpc("delete_learning_engine_v1_rollout_for_account_deletion", {
      p_user_id: userId,
    });
    if (rolloutDeletionError) throw rolloutDeletionError;
  } else {
    // Mid-lifecycle reset: only a row still at first_v1_answer_at IS NULL
    // may be removed -- a permanent row is left completely untouched,
    // exactly the one-way guard's own live-user protection.
    const { error: rolloutError } = await admin
      .from("learning_engine_v1_rollout")
      .delete()
      .eq("user_id", userId)
      .is("first_v1_answer_at", null);
    if (rolloutError) throw rolloutError;
  }

  // selection_claims (Runtime Cutover RC-B) MUST be deleted first, before
  // anything it references with ON DELETE RESTRICT -- sessions, decks,
  // cards, and learning_engine_selection_traces all reject a delete while
  // a claim still points to them. Nothing else references INTO
  // selection_claims, so deleting it first is always safe.
  const { error: selectionClaimsError } = await admin.from("selection_claims").delete().eq("user_id", userId);
  if (selectionClaimsError) throw selectionClaimsError;

  // answer_events MUST be deleted before learning_engine_selection_traces
  // (Phase 8): a v1 answer_events row's selection_trace_id references a
  // trace with ON DELETE RESTRICT, so deleting the trace first while an
  // answer_event still points to it is rejected. Deleting the REFERENCING
  // row (answer_events) first is always safe; only then is the
  // (now-unreferenced) trace safe to delete -- which in turn must still
  // happen before sessions/cards/decks below, since the trace itself
  // references those three with RESTRICT too.
  const { error: answerEventsError } = await admin.from("answer_events").delete().eq("user_id", userId);
  if (answerEventsError) throw answerEventsError;

  const { error: selectionTracesError } = await admin
    .from("learning_engine_selection_traces")
    .delete()
    .eq("user_id", userId);
  if (selectionTracesError) throw selectionTracesError;

  const { error: xpEventsError } = await admin.from("xp_events").delete().eq("user_id", userId);
  if (xpEventsError) throw xpEventsError;

  const { error: dailyStatsError } = await admin.from("daily_user_stats").delete().eq("user_id", userId);
  if (dailyStatsError) throw dailyStatsError;

  // session_review_cards/session_learning_queue CASCADE from sessions.
  const { error: sessionsError } = await admin.from("sessions").delete().eq("user_id", userId);
  if (sessionsError) throw sessionsError;

  const { error: progressError } = await admin.from("user_card_progress").delete().eq("user_id", userId);
  if (progressError) throw progressError;

  // user_deck_learning_state (Runtime Cutover RC-B) references decks with
  // ON DELETE RESTRICT, so it must go before the decks delete below.
  const { error: deckLearningStateError } = await admin.from("user_deck_learning_state").delete().eq("user_id", userId);
  if (deckLearningStateError) throw deckLearningStateError;

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

/**
 * The project's one existing full account-deletion sequence (there is no
 * separate production "delete my account" RPC to defer to -- confirmed
 * by audit before the one-way rollout guard was added): every owned
 * table in FK-RESTRICT order, including the sanctioned rollout-row
 * bypass (20261016000000_learning_engine_v1_rollout_account_deletion.sql)
 * for a user who has entered the one-way v1 zone, then the profile, then
 * the real auth identity via the Admin API. Exported so both
 * teardownIntegrationFixtures() and a test proving this sequence itself
 * (tests/integration/16-learning-engine-v1-rc-c-answer-commit.test.ts)
 * share the identical ordering rather than a second copy of it.
 */
export async function deleteTesterAccount(admin: SupabaseClient, userId: string): Promise<void> {
  // fullAccountDeletion: true -- this IS the genuine full account
  // deletion (profile and auth user are removed right below), so the
  // one sanctioned bypass (20261016000000) removes even a permanent
  // rollout row here. No workaround needed: the one-way guard protects
  // a LIVE user, not account deletion itself (see deleteOwnedLearnerData's
  // own doc comment).
  await deleteOwnedLearnerData(admin, userId, { fullAccountDeletion: true });

  // profiles.id -> auth.users.id is ON DELETE RESTRICT, so the profile
  // row must go before the auth user.
  const { error: profileError } = await admin.from("profiles").delete().eq("id", userId);
  if (profileError) throw profileError;

  const { error: authError } = await admin.auth.admin.deleteUser(userId);
  if (authError) throw authError;
}

export async function teardownIntegrationFixtures(): Promise<void> {
  const admin = createAdminClient();

  for (const identity of ALL_INTEGRATION_TESTERS) {
    const userId = await findAuthUserIdByEmail(admin, identity.email);
    if (!userId) continue;

    await deleteTesterAccount(admin, userId);
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
