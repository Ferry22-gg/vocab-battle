/**
 * Provisions one tester through the REAL trusted onboarding/session paths
 * (duplicate_starter_deck(), start_or_resume_session()) using the
 * tester's own authenticated client -- never the admin client -- so
 * fixture setup exercises the same RPCs/RLS a real tester would. The
 * admin client is used only to look up an official starter deck id
 * (a read any tester could also make; done here via admin purely for
 * fixture-setup convenience/reliability) and, by callers of this module,
 * for direct pre-state preparation where the scenario needs it (see each
 * scenario file).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../admin-client";
import { createTesterClient } from "../tester-client";
import type { TesterIdentity } from "./identities";

export interface ProvisionedTester {
  readonly identity: TesterIdentity;
  readonly userId: string;
  readonly client: SupabaseClient;
  readonly deckId: string;
  /** One card from the duplicated deck, chosen deterministically (lowest sort_order). */
  readonly cardId: string;
}

async function getAnyOfficialStarterDeckId(admin: SupabaseClient): Promise<string> {
  const { data, error } = await admin
    .from("decks")
    .select("id")
    .eq("is_template", true)
    .eq("is_official", true)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (error) throw error;
  if (!data) {
    throw new Error(
      "getAnyOfficialStarterDeckId: no official starter template deck found -- has " +
        "20260923220000_official_starter_deck_data.sql been applied to this local stack?",
    );
  }
  return data.id;
}

/**
 * Signs in as `identity`, duplicates an official starter deck through the
 * real `duplicate_starter_deck()` RPC (idempotent -- reuses an existing
 * copy if one is already selected), and picks one deterministic card from
 * it. Callers needing a session on top of this call
 * startOrResumeSessionFor() separately.
 */
export async function provisionTesterWithDeck(identity: TesterIdentity): Promise<ProvisionedTester> {
  const admin = createAdminClient();
  const client = await createTesterClient(identity.email, identity.password);

  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) {
    throw new Error(`provisionTesterWithDeck: failed to resolve authenticated user for ${identity.email}`, {
      cause: userError,
    });
  }
  const userId = userData.user.id;

  const starterDeckId = await getAnyOfficialStarterDeckId(admin);

  const { data: duplicatedDeck, error: duplicateError } = await client.rpc("duplicate_starter_deck", {
    p_source_deck_id: starterDeckId,
  });
  if (duplicateError) {
    throw new Error(`provisionTesterWithDeck: duplicate_starter_deck failed for ${identity.email}`, {
      cause: duplicateError,
    });
  }
  const deckId = (duplicatedDeck as { id: string }).id;

  const { data: cardRow, error: cardError } = await client
    .from("cards")
    .select("id")
    .eq("deck_id", deckId)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (cardError || !cardRow) {
    throw new Error(`provisionTesterWithDeck: failed to read a card from deck ${deckId}`, { cause: cardError });
  }

  return { identity, userId, client, deckId, cardId: cardRow.id };
}

/**
 * Fetches `count` distinct card ids from `deckId`, ordered deterministically
 * by `sort_order`, for scenarios that need more than one card from the
 * same tester's deck (e.g. a correct-answer card and a separate
 * wrong-answer card, so mutations to one never affect the other).
 */
export async function pickCards(
  tester: Pick<ProvisionedTester, "client" | "deckId">,
  count: number,
): Promise<readonly string[]> {
  const { data, error } = await tester.client
    .from("cards")
    .select("id")
    .eq("deck_id", tester.deckId)
    .order("sort_order", { ascending: true })
    .limit(count);
  if (error) throw error;
  if (!data || data.length < count) {
    throw new Error(`pickCards: deck ${tester.deckId} does not have ${count} cards`);
  }
  return data.map((row: { id: string }) => row.id);
}

/** Starts (or resumes) a session for an already-provisioned tester via the real start_or_resume_session() RPC. */
export async function startOrResumeSessionFor(
  tester: Pick<ProvisionedTester, "client" | "deckId">,
): Promise<{ id: string }> {
  const { data, error } = await tester.client.rpc("start_or_resume_session", {
    p_deck_id: tester.deckId,
  });
  if (error) {
    throw new Error("startOrResumeSessionFor: start_or_resume_session failed", { cause: error });
  }
  return data as { id: string };
}
