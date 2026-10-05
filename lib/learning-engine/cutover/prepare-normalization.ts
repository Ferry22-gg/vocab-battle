import "server-only";

/**
 * Learning Engine v1 -- shared read + target-computation logic for legacy
 * normalization, factored out of scripts/learning-engine-v1-cutover-normalize.ts
 * (RC-A's one-time global cutover script) so that script and the pre-RC-E
 * atomic per-user enrollment path (lib/learning-engine/cutover/enroll.ts,
 * commit_learning_engine_v1_enrollment() in
 * supabase/migrations/20261020000000_learning_engine_v1_enrollment_atomic_commit.sql)
 * compute IDENTICAL per-card v1 targets from IDENTICAL legacy rows --
 * never two independently maintained copies of "group by deck, assign
 * FORGOTTEN ordinals, derive a deterministic seed, call
 * computeNormalizedCardProgress()." That computation is the reviewed RC-A
 * normalization policy; this module still performs no scheduling
 * decision of its own -- it only sequences calls to the real
 * computeNormalizedCardProgress()/assignForgottenOrdinals()
 * (normalize-legacy-state.ts) and createDeterministicRandom()/
 * buildNormalizationSeed() (deterministic-random.ts), exactly as the
 * script always has.
 *
 * Read-only (readLegacyCardRowsForNormalization) and pure computation
 * (computeNormalizationTargets) only -- neither function here writes
 * anything. Persistence is entirely the caller's job: the script persists
 * via its own established sequence of individual RPC calls; the
 * enrollment path hands its output wholesale to one atomic trusted
 * transaction.
 */

import { getServiceRoleClient } from "@/lib/supabase/service-role";
import {
  assignForgottenOrdinals,
  computeNormalizedCardProgress,
  type LegacyCardStatus,
  type NormalizedCardProgressTarget,
} from "@/lib/learning-engine/cutover/normalize-legacy-state";
import { createDeterministicRandom, buildNormalizationSeed } from "@/lib/learning-engine/cutover/deterministic-random";
import { LEARNING_ENGINE_POLICY_VERSION } from "@/lib/learning-engine/config";

/**
 * This normalization run's own version string -- distinct from (but, by
 * convention, derived from) LEARNING_ENGINE_POLICY_VERSION. Bumping this
 * deliberately changes every FORGOTTEN card's deterministic seed (see
 * deterministic-random.ts's buildNormalizationSeed), the documented
 * escape hatch for a future corrective re-run that must sample different
 * repair targets on purpose -- never bumped casually. Shared by BOTH the
 * one-time global cutover script and the per-user enrollment path, so a
 * card normalized by either reproduces the identical target.
 */
export const LEARNING_ENGINE_V1_CUTOVER_NORMALIZATION_VERSION = `${LEARNING_ENGINE_POLICY_VERSION}-cutover-rc-a.1`;

const PAGE_SIZE = 1000;

export interface LegacyCardRow {
  readonly user_id: string;
  readonly card_id: string;
  readonly card_status: LegacyCardStatus;
  readonly deck_id: string;
}

/**
 * Reads every user_card_progress row paginated, joined to cards.deck_id,
 * optionally filtered to one user. ACQUIRED rows (none should exist for a
 * not-yet-enrolled user) are rejected loudly rather than silently coerced
 * -- this must never run against a user/deck that already has live
 * v1-shaped data.
 */
export async function readLegacyCardRowsForNormalization(userId?: string): Promise<readonly LegacyCardRow[]> {
  const supabase = getServiceRoleClient();
  const rows: LegacyCardRow[] = [];
  let from = 0;

  for (;;) {
    let query = supabase.from("user_card_progress").select("user_id, card_id, card_status, cards!inner(deck_id)");
    if (userId !== undefined) {
      query = query.eq("user_id", userId);
    }
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error("readLegacyCardRowsForNormalization: failed to read user_card_progress", { cause: error });
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
          `readLegacyCardRowsForNormalization: card ${row.card_id} for user ${row.user_id} already has ` +
            "card_status=ACQUIRED -- this must only run against legacy (pre-cutover) data. Aborting.",
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

/** One legacy card's complete, already-computed v1 normalization target -- everything a persistence caller needs, with no further computation required. */
export interface NormalizationTargetForCard {
  readonly userId: string;
  readonly cardId: string;
  readonly deckId: string;
  readonly expectedLegacyCardStatus: LegacyCardStatus;
  readonly target: NormalizedCardProgressTarget;
}

export interface GroupedNormalizationTargets {
  /** Every non-NEW row's computed target -- NEW is always skipped (true no-op target, see normalize-legacy-state.ts's NEW_TARGET doc comment). */
  readonly cardsToNormalize: readonly NormalizationTargetForCard[];
  readonly cardsSkippedNew: number;
  /**
   * Every distinct (user, deck) pair touched by `rows`, including a deck
   * whose rows are all NEW (skipped from cardsToNormalize above but still
   * needing its user_deck_learning_state initialized/recomputed) --
   * mirrors exactly which (user, deck) pairs the original script always
   * recomputed.
   */
  readonly deckIdsByUser: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Pure: groups `rows` by deck (so FORGOTTEN ordinals are assigned
 * per-deck, matching assignForgottenOrdinals()'s own contract), computes
 * each non-NEW row's deterministic v1 target via the real
 * computeNormalizedCardProgress(), and records every (user, deck) pair
 * seen. No database access of any kind.
 */
export function computeNormalizationTargets(
  rows: readonly LegacyCardRow[],
  normalizationVersion: string,
): GroupedNormalizationTargets {
  const rowsByDeck = new Map<string, LegacyCardRow[]>();
  for (const row of rows) {
    const existing = rowsByDeck.get(row.deck_id);
    if (existing) {
      existing.push(row);
    } else {
      rowsByDeck.set(row.deck_id, [row]);
    }
  }

  const cardsToNormalize: NormalizationTargetForCard[] = [];
  let cardsSkippedNew = 0;
  const deckIdsByUser = new Map<string, Set<string>>();

  for (const [deckId, deckRows] of rowsByDeck) {
    const forgottenCardIds = deckRows.filter((row) => row.card_status === "FORGOTTEN").map((row) => row.card_id);
    const ordinals = assignForgottenOrdinals(forgottenCardIds);

    for (const row of deckRows) {
      const userDecks = deckIdsByUser.get(row.user_id) ?? new Set<string>();
      userDecks.add(deckId);
      deckIdsByUser.set(row.user_id, userDecks);

      if (row.card_status === "NEW") {
        cardsSkippedNew += 1;
        continue;
      }

      const forgottenOrdinal = ordinals.get(row.card_id) ?? 0;
      const seed = buildNormalizationSeed({ normalizationVersion, deckId, cardId: row.card_id });
      const target = computeNormalizedCardProgress({
        legacyCardStatus: row.card_status,
        cardId: row.card_id,
        forgottenOrdinal,
        random: createDeterministicRandom(seed),
      });

      cardsToNormalize.push({
        userId: row.user_id,
        cardId: row.card_id,
        deckId,
        expectedLegacyCardStatus: row.card_status,
        target,
      });
    }
  }

  return { cardsToNormalize, cardsSkippedNew, deckIdsByUser };
}

/** One user's complete prepared normalization payload -- ready to hand to the atomic enrollment transaction (lib/learning-engine/cutover/enroll.ts), or to inspect/test directly. Never performs any write. */
export interface PreparedUserNormalization {
  readonly cardsToNormalize: readonly NormalizationTargetForCard[];
  readonly cardsSkippedNew: number;
  readonly deckIds: readonly string[];
}

/**
 * Reads this one user's legacy rows and computes their complete v1
 * normalization targets -- the PREPARE half of enroll.ts's
 * prepare-then-commit split. Performs a read, never a write; the caller
 * is responsible for persisting the result (atomically, for enrollment).
 */
export async function prepareLearningEngineV1NormalizationForUser(userId: string): Promise<PreparedUserNormalization> {
  const rows = await readLegacyCardRowsForNormalization(userId);
  const { cardsToNormalize, cardsSkippedNew, deckIdsByUser } = computeNormalizationTargets(
    rows,
    LEARNING_ENGINE_V1_CUTOVER_NORMALIZATION_VERSION,
  );

  return {
    cardsToNormalize,
    cardsSkippedNew,
    deckIds: [...(deckIdsByUser.get(userId) ?? [])],
  };
}
