/**
 * Learning Engine v1 -- Runtime Cutover RC-A: one-time legacy-state
 * normalization script.
 *
 * NOT part of the live application. Never imported by any Server
 * Action, API route, or Session UI code path -- this is an operational
 * tool an operator runs once, manually, against the local/staging
 * Supabase stack, using the service-role key. Requires a TypeScript-
 * capable runner (e.g. `pnpm dlx tsx scripts/learning-engine-v1-cutover-normalize.ts`)
 * -- this project has no such runner wired into package.json yet; adding
 * one is an operational decision for whoever actually executes the
 * one-time cutover, deliberately left open here since RC-A explicitly
 * does not perform a live cutover (approved plan section 17/19).
 *
 * What this script does, in order, for every (user, deck) pair that has
 * at least one `user_card_progress` row:
 *   1. Reads every card's current legacy card_status (NEW/LEARNING/
 *      LEARNED/FORGOTTEN).
 *   2. For the deck's FORGOTTEN cards only, assigns stable synthetic
 *      ordinals (ascending card_id) via assignForgottenOrdinals().
 *   3. Computes each card's complete v1-normalized target state via the
 *      pure lib/learning-engine/cutover/normalize-legacy-state.ts
 *      module (NEW is a no-op and is skipped; LEARNING/LEARNED/FORGOTTEN
 *      are persisted via normalizeCardProgress()).
 *   4. Once every card in a deck has been normalized, recomputes that
 *      deck's mastered_count/has_achieved_full_mastery via
 *      recomputeUserDeckLearningState().
 *
 * Idempotent: re-running this script is safe. normalizeCardProgress()'s
 * expected-legacy-card_status check means a card ALREADY normalized to
 * its v1 target (card_status unchanged for LEARNING/LEARNED/FORGOTTEN --
 * only learning_stage/pool_status/etc. change) will simply be
 * re-written with the identical target state the deterministic RNG
 * reproduces -- not silently skipped, not double-applied.
 *
 * Does NOT touch sessions.engine_version, learning_engine_v1_rollout,
 * selection_claims, or user_card_progress.last_presented_scheduler_position
 * -- those are live-runtime concerns for RC-B/RC-C/RC-D, out of RC-A's
 * normalization scope.
 */

import { getServiceRoleClient } from "@/lib/supabase/service-role";
import {
  assignForgottenOrdinals,
  computeNormalizedCardProgress,
  type LegacyCardStatus,
} from "@/lib/learning-engine/cutover/normalize-legacy-state";
import { createDeterministicRandom, buildNormalizationSeed } from "@/lib/learning-engine/cutover/deterministic-random";
import { normalizeCardProgress, recomputeUserDeckLearningState } from "@/lib/learning-engine/cutover/dal";
import { LEARNING_ENGINE_POLICY_VERSION } from "@/lib/learning-engine/config";

/**
 * This script's own normalization-run version -- distinct from (but, by
 * convention, derived from) LEARNING_ENGINE_POLICY_VERSION. Bumping this
 * deliberately changes every FORGOTTEN card's deterministic seed (see
 * deterministic-random.ts's buildNormalizationSeed), which is the
 * documented escape hatch for a future corrective re-run that must
 * sample different repair targets on purpose -- never bumped casually.
 */
const NORMALIZATION_VERSION = `${LEARNING_ENGINE_POLICY_VERSION}-cutover-rc-a.1`;

const PAGE_SIZE = 1000;

interface LegacyCardRow {
  readonly user_id: string;
  readonly card_id: string;
  readonly card_status: LegacyCardStatus;
  readonly deck_id: string;
}

/** Reads every user_card_progress row paginated, joined to cards.deck_id. ACQUIRED rows (none should exist pre-cutover) are rejected loudly rather than silently coerced -- this script must never run against a deck that already has live v1-shaped data. */
async function readAllLegacyCardRows(
  supabase: ReturnType<typeof getServiceRoleClient>,
): Promise<readonly LegacyCardRow[]> {
  const rows: LegacyCardRow[] = [];
  let from = 0;

  for (;;) {
    const { data, error } = await supabase
      .from("user_card_progress")
      .select("user_id, card_id, card_status, cards!inner(deck_id)")
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error("learning-engine-v1-cutover-normalize: failed to read user_card_progress", { cause: error });
    }
    if (!data || data.length === 0) {
      break;
    }

    for (const row of data as unknown as Array<{
      user_id: string;
      card_id: string;
      card_status: string;
      cards: { deck_id: string };
    }>) {
      if (row.card_status === "ACQUIRED") {
        throw new Error(
          `learning-engine-v1-cutover-normalize: card ${row.card_id} for user ${row.user_id} already has ` +
            "card_status=ACQUIRED -- this script must only run against legacy (pre-cutover) data. Aborting.",
        );
      }
      rows.push({
        user_id: row.user_id,
        card_id: row.card_id,
        card_status: row.card_status as LegacyCardStatus,
        deck_id: row.cards.deck_id,
      });
    }

    if (data.length < PAGE_SIZE) {
      break;
    }
    from += PAGE_SIZE;
  }

  return rows;
}

interface NormalizationSummary {
  readonly cardsNormalized: number;
  readonly cardsSkippedNew: number;
  readonly decksRecomputed: number;
}

export async function runLearningEngineV1CutoverNormalization(): Promise<NormalizationSummary> {
  const supabase = getServiceRoleClient();
  const rows = await readAllLegacyCardRows(supabase);

  // Group by deck so FORGOTTEN ordinals are assigned per-deck, and by
  // (user, deck) so recomputeUserDeckLearningState() runs exactly once
  // per pair, after every one of that pair's cards has been normalized.
  const rowsByDeck = new Map<string, LegacyCardRow[]>();
  for (const row of rows) {
    const existing = rowsByDeck.get(row.deck_id);
    if (existing) {
      existing.push(row);
    } else {
      rowsByDeck.set(row.deck_id, [row]);
    }
  }

  let cardsNormalized = 0;
  let cardsSkippedNew = 0;
  const recomputedPairs = new Set<string>();

  for (const [deckId, deckRows] of rowsByDeck) {
    const forgottenCardIds = deckRows.filter((row) => row.card_status === "FORGOTTEN").map((row) => row.card_id);
    const ordinals = assignForgottenOrdinals(forgottenCardIds);

    for (const row of deckRows) {
      if (row.card_status === "NEW") {
        cardsSkippedNew += 1;
        continue;
      }

      const forgottenOrdinal = ordinals.get(row.card_id) ?? 0;
      const seed = buildNormalizationSeed({
        normalizationVersion: NORMALIZATION_VERSION,
        deckId,
        cardId: row.card_id,
      });
      const target = computeNormalizedCardProgress({
        legacyCardStatus: row.card_status,
        cardId: row.card_id,
        forgottenOrdinal,
        random: createDeterministicRandom(seed),
      });

      await normalizeCardProgress({
        userId: row.user_id,
        cardId: row.card_id,
        expectedLegacyCardStatus: row.card_status,
        target,
        normalizationVersion: NORMALIZATION_VERSION,
      });
      cardsNormalized += 1;
    }

    const userIds = new Set(deckRows.map((row) => row.user_id));
    for (const userId of userIds) {
      await recomputeUserDeckLearningState(userId, deckId);
      recomputedPairs.add(`${userId}:${deckId}`);
    }
  }

  return {
    cardsNormalized,
    cardsSkippedNew,
    decksRecomputed: recomputedPairs.size,
  };
}

// Deliberately no top-level self-invocation here: this project has no
// TypeScript script runner wired into package.json yet (no `tsx`/
// `ts-node` dependency), and wiring one up is an operational decision
// for whoever actually executes the one-time cutover -- out of RC-A's
// scope (approved plan: "do not perform live cutover"). An operator
// invokes runLearningEngineV1CutoverNormalization() from a small
// wrapper at that time, e.g. via `pnpm dlx tsx` or a Node REPL import.
