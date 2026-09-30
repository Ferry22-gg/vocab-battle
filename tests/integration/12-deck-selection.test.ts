import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetTesterLearnerData } from "./fixtures/setup";
import { provisionTesterWithDeck, type ProvisionedTester } from "./fixtures/provision";
import { DECK_SELECTION_TESTER } from "./fixtures/identities";
import { setRlsClient, clearRlsClient } from "./rls-client-context";
import { getProfileAdmin, getSessionByIdAdmin, getUserCardProgressAdmin } from "./db-assertions";
import { createAdminClient } from "./admin-client";

const { getOwnedDecksWithCardCounts, selectDeck } = await import("@/lib/decks/dal");
const { startOrResumeSession, getActiveSessionById, finishSession } = await import("@/lib/sessions/dal");

/**
 * P3 Decks: select_deck() and its interaction with session/progress state,
 * exercised through the real production DAL against real Postgres RLS and
 * the real select_deck()/start_or_resume_session() RPCs -- see
 * DATABASE_SCHEMA.md 10.8 and supabase/tests/004_select_deck_test.sql for
 * the underlying trusted-function contract this scenario builds on top of.
 */
describe("P3 Decks: select_deck() and session/deck consistency (real Postgres)", () => {
  let tester: ProvisionedTester;
  let secondDeckId: string;

  beforeAll(async () => {
    await resetTesterLearnerData(DECK_SELECTION_TESTER);
    tester = await provisionTesterWithDeck(DECK_SELECTION_TESTER);

    // Duplicate the *other* official starter template so this tester owns
    // two independent decks -- duplicate_starter_deck() is idempotent per
    // source deck, and re-selects (rather than re-duplicates) if already
    // owned, so this also re-points selected_deck_id at the second deck as
    // a side effect; tests below explicitly re-select as needed.
    const admin = createAdminClient();
    const { data: templates, error } = await admin
      .from("decks")
      .select("id")
      .eq("is_template", true)
      .eq("is_official", true)
      .is("deleted_at", null)
      .order("id", { ascending: true });
    if (error) throw error;
    if (!templates || templates.length < 2) {
      throw new Error("12-deck-selection: expected at least 2 official starter templates to be seeded");
    }
    const otherTemplateId = (templates as { id: string }[]).find((t) => t.id !== tester.deckId
      // tester.deckId is a *duplicated copy*'s id, never a template id, so
      // this filter is defensive only -- in practice both template rows
      // are eligible and neither equals a copy's id.
    )?.id ?? templates[0].id;

    setRlsClient(tester.client);
    const { data: secondDeck, error: dupError } = await tester.client.rpc("duplicate_starter_deck", {
      p_source_deck_id: otherTemplateId,
    });
    if (dupError) throw dupError;
    secondDeckId = (secondDeck as { id: string }).id;

    // Re-select the original deck so each test starts from a known,
    // explicit selected_deck_id rather than whatever duplication left
    // behind.
    await selectDeck(tester.deckId);
  });

  afterAll(() => {
    clearRlsClient();
  });

  it("Decks list shows both owned decks with real, non-FSRS card counts", async () => {
    setRlsClient(tester.client);
    const decks = await getOwnedDecksWithCardCounts();

    const deckIds = decks.map((d) => d.id);
    expect(deckIds).toContain(tester.deckId);
    expect(deckIds).toContain(secondDeckId);

    for (const deck of decks) {
      expect(deck.cardCount).toBeGreaterThan(0);
    }
  });

  it("selectDeck() switches the authoritative profiles.selected_deck_id", async () => {
    setRlsClient(tester.client);

    await selectDeck(secondDeckId);

    const profile = await getProfileAdmin(tester.userId);
    expect(profile?.selected_deck_id).toBe(secondDeckId);

    // Restore for subsequent tests in this file.
    await selectDeck(tester.deckId);
  });

  it("switching the selected deck does not touch card progress on either deck", async () => {
    setRlsClient(tester.client);

    const beforeOriginal = await getUserCardProgressAdmin(tester.userId, tester.cardId);
    expect(beforeOriginal).not.toBeNull();

    await selectDeck(secondDeckId);
    await selectDeck(tester.deckId);

    const afterOriginal = await getUserCardProgressAdmin(tester.userId, tester.cardId);
    expect(afterOriginal).toMatchObject({
      card_status: beforeOriginal!.card_status,
      seen_count: beforeOriginal!.seen_count,
      correct_streak: beforeOriginal!.correct_streak,
      wrong_streak: beforeOriginal!.wrong_streak,
    });
  });

  it("an active session stays tied to its original deck when the selected deck changes; a new session (after finishing it) uses the newly selected deck", async () => {
    setRlsClient(tester.client);

    // Start fresh: no active session should exist at this point for this
    // tester (resetTesterLearnerData ran in beforeAll and nothing since
    // has started one).
    const started = await startOrResumeSession(); // resolves selected_deck_id = tester.deckId
    expect(started.deck_id).toBe(tester.deckId);

    // Switch selected deck while that session is still active.
    await selectDeck(secondDeckId);
    const profileAfterSwitch = await getProfileAdmin(tester.userId);
    expect(profileAfterSwitch?.selected_deck_id).toBe(secondDeckId);

    // The active session must be completely untouched by the switch.
    const sessionAfterSwitch = await getSessionByIdAdmin(started.id);
    expect(sessionAfterSwitch?.deck_id).toBe(tester.deckId);
    expect(sessionAfterSwitch?.status).toBe("active");

    // Resuming (no explicit deck argument) must resume the SAME session on
    // its ORIGINAL deck -- start_or_resume_session() ignores p_deck_id
    // entirely once an active session already exists.
    const resumed = await startOrResumeSession();
    expect(resumed.id).toBe(started.id);
    expect(resumed.deck_id).toBe(tester.deckId);

    const stillActive = await getActiveSessionById(started.id);
    expect(stillActive?.deck_id).toBe(tester.deckId);

    // Finish the session, then start a brand new one with no active
    // session in the way: it must use the now-selected second deck.
    await finishSession(started.id);
    const finished = await getSessionByIdAdmin(started.id);
    expect(finished?.status).toBe("completed");

    const nextSession = await startOrResumeSession();
    expect(nextSession.id).not.toBe(started.id);
    expect(nextSession.deck_id).toBe(secondDeckId);

    // Clean up: finish this session and restore the original selection so
    // later test files (if any share this tester in the future) start
    // from a known state.
    await finishSession(nextSession.id);
    await selectDeck(tester.deckId);
  });

  it("selectDeck() rejects a deck the caller does not own", async () => {
    setRlsClient(tester.client);

    const admin = createAdminClient();
    const { data: otherOfficialDeck, error } = await admin
      .from("decks")
      .select("id")
      .eq("is_template", true)
      .eq("is_official", true)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (error) throw error;

    // An official template is never owned by this tester, so select_deck()
    // (which requires ownership -- DATABASE_SCHEMA.md 10.8) must reject it.
    await expect(selectDeck(otherOfficialDeck!.id)).rejects.toThrow();

    // Rejected selection must not have changed anything.
    const profile = await getProfileAdmin(tester.userId);
    expect(profile?.selected_deck_id).toBe(tester.deckId);
  });
});
