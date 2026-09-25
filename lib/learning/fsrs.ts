/**
 * ts-fsrs 5.4.2 adapter (docs/MVP_SPEC_FOR_CLAUDE.md section 17,
 * docs/DATABASE_SCHEMA.md section 4.4). Pure conversion layer between
 * `user_card_progress`'s FSRS columns and ts-fsrs's `Card` model: no DB
 * access, no auth logic, no battle logic, no card-lifecycle/mastery
 * logic. The only randomness involved is whatever ts-fsrs itself performs
 * internally via FSRS_CONFIG.enable_fuzz -- this module never calls
 * `Math.random()` itself.
 *
 * Card lifecycle (`user_card_progress.card_status`: NEW/LEARNING/LEARNED/
 * FORGOTTEN) and FSRS state are separate concepts, and this module never
 * derives or writes `card_status`. Per MVP_SPEC_FOR_CLAUDE.md section 8, a
 * card only enters FSRS retention scheduling once it first becomes
 * LEARNED -- before that, every FSRS column stays at the DB's default
 * (see UserCardProgressFsrsRow below). This module also never resets
 * accumulated FSRS history when `card_status` later becomes FORGOTTEN --
 * it has no opinion on `card_status` at all, so there is nothing here
 * that could do so.
 */

import { createEmptyCard, fsrs, Rating } from "ts-fsrs";
import type { Card, Grade } from "ts-fsrs";

import { FSRS_CONFIG } from "@/lib/learning/config";

/** user_card_progress.fsrs_state's four valid values (ts-fsrs State.New..State.Relearning). */
export type FsrsStateValue = 0 | 1 | 2 | 3;

/**
 * The FSRS-relevant columns of one `user_card_progress` row, exactly as
 * stored (docs/DATABASE_SCHEMA.md section 4.4).
 *
 * Invariant this module assumes (maintained by commit_answer_transaction(),
 * not enforced by a cross-column DB CHECK): `fsrs_state === null` means
 * this card has never been through FSRS -- `fsrs_due_at`,
 * `fsrs_stability`, `fsrs_difficulty`, and `fsrs_last_review_at` are then
 * also null, and the NOT NULL counters (`fsrs_elapsed_days`,
 * `fsrs_scheduled_days`, `fsrs_reps`, `fsrs_lapses`,
 * `fsrs_learning_steps`) sit at their default of 0. When `fsrs_state` is
 * non-null, the card has been through at least one `FSRS.next()` call,
 * which always sets `last_review` on its result -- so the other four
 * nullable fields are expected non-null in that case too.
 */
export interface UserCardProgressFsrsRow {
  readonly fsrs_due_at: Date | null;
  readonly fsrs_stability: number | null;
  readonly fsrs_difficulty: number | null;
  readonly fsrs_elapsed_days: number;
  readonly fsrs_scheduled_days: number;
  readonly fsrs_reps: number;
  readonly fsrs_lapses: number;
  readonly fsrs_learning_steps: number;
  readonly fsrs_state: FsrsStateValue | null;
  readonly fsrs_last_review_at: Date | null;
}

/**
 * The FSRS-relevant columns to write back to `user_card_progress` after
 * one `FSRS.next()` advance -- exactly the fields the future
 * `submitAnswer()` will pass through to `commit_answer_transaction()`'s
 * `p_fsrs_*` parameters. Deliberately excludes every non-FSRS column
 * (card_status, seen_count, streaks, etc.) -- those belong to lifecycle
 * logic this module doesn't implement.
 */
export interface UserCardProgressFsrsUpdate {
  readonly fsrs_due_at: Date;
  readonly fsrs_stability: number;
  readonly fsrs_difficulty: number;
  readonly fsrs_elapsed_days: number;
  readonly fsrs_scheduled_days: number;
  readonly fsrs_reps: number;
  readonly fsrs_lapses: number;
  readonly fsrs_learning_steps: number;
  readonly fsrs_state: FsrsStateValue;
  readonly fsrs_last_review_at: Date;
}

function requireField<T>(value: T | null, field: string): T {
  if (value === null) {
    throw new Error(
      `fsrs adapter: expected ${field} to be non-null for an already-initialized FSRS row/card, but it was null`,
    );
  }
  return value;
}

/**
 * The only nullable `fsrs_*` columns in `user_card_progress` besides
 * `fsrs_state` itself (confirmed against the table DDL in
 * supabase/migrations/20260922034033_learning_and_session_tables.sql --
 * `fsrs_elapsed_days`/`fsrs_scheduled_days`/`fsrs_reps`/`fsrs_lapses`/
 * `fsrs_learning_steps` are all NOT NULL with a default of 0, independent
 * of `fsrs_state`'s nullability, so they are deliberately not part of
 * this check -- see assertCanonicalUninitializedRow).
 */
const NULLABLE_WHEN_UNINITIALIZED_FIELDS = [
  "fsrs_due_at",
  "fsrs_stability",
  "fsrs_difficulty",
  "fsrs_last_review_at",
] as const satisfies readonly (keyof UserCardProgressFsrsRow)[];

/**
 * Guards the `fsrs_state === null` branch of progressToFsrsCard against a
 * partially-populated row. Confirmed against every current write path
 * (both `duplicate_starter_deck()` and `add_card_to_deck()` insert
 * `user_card_progress` rows without naming any `fsrs_*` column, so all
 * five nullable ones -- fsrs_due_at/stability/difficulty/state/
 * last_review_at -- land on their column default of NULL together; only
 * `commit_answer_transaction()` ever writes a non-null value, and it sets
 * all ten `fsrs_*` columns in one UPDATE, never a subset) that a row with
 * `fsrs_state === null` is never expected to have any of
 * NULLABLE_WHEN_UNINITIALIZED_FIELDS populated. No current path can
 * produce a violation, but this is defense-in-depth against a future bug
 * or direct DB tampering feeding this adapter a corrupted row -- it must
 * fail loudly rather than silently discarding the unexpected data as a
 * clean NEW card.
 *
 * Deliberately does NOT check fsrs_elapsed_days/scheduled_days/reps/
 * lapses/learning_steps: the schema places no invariant tying those NOT
 * NULL, independently-defaulted counters to fsrs_state's nullability, so
 * requiring them to be exactly 0 here would be a stricter invariant than
 * the schema actually supports.
 */
function assertCanonicalUninitializedRow(row: UserCardProgressFsrsRow): void {
  const unexpectedlyPopulated = NULLABLE_WHEN_UNINITIALIZED_FIELDS.filter(
    (field) => row[field] !== null,
  );

  if (unexpectedlyPopulated.length > 0) {
    throw new Error(
      `progressToFsrsCard: fsrs_state is null (uninitialized) but ${unexpectedlyPopulated.join(", ")} ` +
        `${unexpectedlyPopulated.length === 1 ? "is" : "are"} unexpectedly non-null -- refusing to ` +
        "discard this partial FSRS state as a clean NEW card",
    );
  }
}

/**
 * Converts one `user_card_progress` row's FSRS columns into a ts-fsrs
 * `Card`.
 *
 * `fsrs_state === null` means the row has never been through FSRS --
 * returns `createEmptyCard(now)` (ts-fsrs's own representation of a
 * zero-review card: State.New, stability/difficulty 0, due = now,
 * last_review undefined) rather than attempting to map absent data. This
 * never fabricates historical review data: it is ts-fsrs's documented
 * empty-card shape, not a guess. The DB's actual default row does NOT
 * match this shape directly (fsrs_state is NULL, not the numeric 0 for
 * State.New; fsrs_due_at is NULL, not a due Date) -- so `createEmptyCard`
 * must be called here rather than reading the row as-is. Before doing so,
 * assertCanonicalUninitializedRow verifies the row is genuinely clean --
 * see that function for exactly which fields are checked and why.
 *
 * When `fsrs_state` is non-null, throws if the invariant documented on
 * UserCardProgressFsrsRow is violated (a nullable FSRS field unexpectedly
 * null) rather than silently substituting a fabricated value.
 */
export function progressToFsrsCard(row: UserCardProgressFsrsRow, now: Date): Card {
  if (row.fsrs_state === null) {
    assertCanonicalUninitializedRow(row);
    return createEmptyCard(now);
  }

  return {
    due: requireField(row.fsrs_due_at, "fsrs_due_at"),
    stability: requireField(row.fsrs_stability, "fsrs_stability"),
    difficulty: requireField(row.fsrs_difficulty, "fsrs_difficulty"),
    // elapsed_days is deprecated upstream (ts-fsrs README: removed in
    // 6.0.0) but still required by the current DB schema/RPC. Isolated to
    // this one field mapping (and its mirror in fsrsCardToUpdate below) so
    // a future ts-fsrs 6.x migration only needs schema/adapter changes
    // here, not in every caller.
    elapsed_days: row.fsrs_elapsed_days,
    scheduled_days: row.fsrs_scheduled_days,
    learning_steps: row.fsrs_learning_steps,
    reps: row.fsrs_reps,
    lapses: row.fsrs_lapses,
    state: row.fsrs_state,
    last_review: requireField(row.fsrs_last_review_at, "fsrs_last_review_at"),
  };
}

/**
 * Converts a ts-fsrs `Card` (as returned by `advanceFsrs`/`FSRS.next()`)
 * back into the flat set of `user_card_progress` columns
 * `commit_answer_transaction()` expects. `card.last_review` is optional in
 * ts-fsrs's type only because a never-reviewed card has none; a card that
 * has just come out of `FSRS.next()` always has it set (that call always
 * assigns `last_review = now` on its result), so this throws rather than
 * silently coercing a missing value if that ever isn't true.
 */
export function fsrsCardToUpdate(card: Card): UserCardProgressFsrsUpdate {
  return {
    fsrs_due_at: card.due,
    fsrs_stability: card.stability,
    fsrs_difficulty: card.difficulty,
    // See the matching comment in progressToFsrsCard.
    fsrs_elapsed_days: card.elapsed_days,
    fsrs_scheduled_days: card.scheduled_days,
    fsrs_reps: card.reps,
    fsrs_lapses: card.lapses,
    fsrs_learning_steps: card.learning_steps,
    fsrs_state: card.state as FsrsStateValue,
    fsrs_last_review_at: requireField(card.last_review ?? null, "card.last_review (post-advance)"),
  };
}

/**
 * Single FSRS scheduler instance, configured from the approved
 * FSRS_CONFIG (request_retention 0.90, enable_fuzz true,
 * enable_short_term true) with every other FSRSParameters field left at
 * ts-fsrs's own default -- no custom weights are introduced.
 */
const scheduler = fsrs(FSRS_CONFIG);

/**
 * Advances one card by one review: converts the ts-fsrs `Card` + answer
 * timestamp + estimated Grade into the next `Card` state via
 * `FSRS.next()`, then maps that result back to `user_card_progress`
 * columns via fsrsCardToUpdate. Does not mutate `card` (verified in
 * tests/unit/fsrs.test.ts) -- ts-fsrs's own `next()` builds fresh
 * card/log objects internally rather than writing through the input.
 *
 * `grade`'s type (`Grade`, i.e. `Exclude<Rating, Rating.Manual>`) already
 * makes `Rating.Manual` a compile-time error at every call site; the
 * runtime check below is defense-in-depth only, for a caller that erases
 * that type (e.g. via `as Grade`).
 */
export function advanceFsrs(card: Card, now: Date, grade: Grade): UserCardProgressFsrsUpdate {
  if ((grade as Rating) === Rating.Manual) {
    throw new Error("advanceFsrs: Manual is not a valid application-supplied grade");
  }

  const { card: nextCard } = scheduler.next(card, now, grade);
  return fsrsCardToUpdate(nextCard);
}
