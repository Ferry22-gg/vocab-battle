/**
 * Read-only(-ish) DB helpers for spec-level persistence assertions.
 * Node/Playwright-side only, built on the same admin client fixture setup
 * uses -- never imported by app code.
 */

import { createAdminClient } from "./admin-client";
import { toSyntheticEmail } from "../../lib/auth/constants";

type ProfileRow = {
  id: string;
  public_user_id: string;
  role: "tester" | "admin";
  account_status: "active" | "disabled";
  nickname: string | null;
  onboarding_completed: boolean;
  selected_deck_id: string | null;
};

type DeckRow = {
  id: string;
  name: string;
  owner_user_id: string | null;
  source_deck_id: string | null;
};

async function findAuthUserIdByPublicUserId(
  publicUserId: string
): Promise<string | null> {
  const admin = createAdminClient();
  const email = toSyntheticEmail(publicUserId);
  const { data, error } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (error) throw error;
  return data.users.find((u) => u.email === email)?.id ?? null;
}

export async function getProfileByPublicUserId(
  publicUserId: string
): Promise<ProfileRow | null> {
  const userId = await findAuthUserIdByPublicUserId(publicUserId);
  if (!userId) return null;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .select(
      "id, public_user_id, role, account_status, nickname, onboarding_completed, selected_deck_id"
    )
    .eq("id", userId)
    .maybeSingle<ProfileRow>();
  if (error) throw error;
  return data;
}

export async function getDecksOwnedBy(
  publicUserId: string
): Promise<DeckRow[]> {
  const userId = await findAuthUserIdByPublicUserId(publicUserId);
  if (!userId) return [];

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("decks")
    .select("id, name, owner_user_id, source_deck_id")
    .eq("owner_user_id", userId);
  if (error) throw error;
  return (data ?? []) as DeckRow[];
}
