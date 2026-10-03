# Learning Engine v1 -- Runtime Cutover TODO

Tracked gaps that Phase 8 (telemetry persistence) deliberately left open
for a future runtime-cutover phase. Phase 8 built persistence capability
only -- none of these are implemented yet, and none may be assumed solved
by anything that exists today.

## `cards_since_last_seen`

- Derive from the authoritative previous deck-global Learning Engine
  presentation position (per-user-deck `scheduler_position`), not from
  anything session-local.
- Never approximate with `session_position`.
- Current status and full rationale: `lib/learning-engine/telemetry/review-event.ts`
  (module header, "`cardsSinceLastSeen`: a reported gap, not an invented
  semantic"). The field is `NULL` for every real caller today -- no column
  stores a card's previous presentation's `scheduler_position`.

## `session_position`

- Source from authoritative live session state -- never trust it from
  arbitrary client telemetry.
- Current status: `lib/learning-engine/telemetry/review-event.ts`'s
  `ReviewEventPosition` doc comment ("RUNTIME-CUTOVER ACCEPTANCE
  REQUIREMENT"). Unlike `scheduler_position`/`scheduler_revision` (already
  cross-checked against the linked `SelectionTrace` by
  `insert_learning_engine_review_event`), `session_position` has no
  cross-check against live session state anywhere today.

## Daily Goal / Streak display semantics (Phase 9 acceptance requirement)

- Final v1 product rule (see spec section 26): Daily Goal = 5 enemy
  defeats per Asia/Tokyo calendar day; a streak day is earned only on the
  first transition from `enemies_defeated < 5` to `enemies_defeated >= 5`
  that day. There is no separate streak-minimum threshold -- Daily Goal
  completion IS streak-day qualification.
- The displayed streak must reflect the authoritative persisted streak
  (`profiles.current_streak`), whose day is earned only by Daily Goal
  completion -- never a client-side or UI-local approximation.
- Phase 9 / Runtime Cutover must NOT: show a streak increment at enemy 1;
  imply "streak secured" at enemies 1-4; or show separate streak-minimum
  progress anywhere in the UI.
- UI may show "Daily Goal: X / 5 enemies" and the current streak. There is
  no separate "Streak goal: 1 enemy" surface in v1.
- Current status: the legacy Alpha `commit_answer_transaction()` streak
  increment (`supabase/migrations/20260927000000_learning_wrong_reappearance_floor.sql`)
  already implements this correctly today -- the entire streak-update
  block is gated on `v_daily_goal_now_completed`. This requirement exists
  to prevent a future v1 cutover from regressing that behavior, not
  because a discrepancy exists today.

## Deck Progress live rendering (Phase 9 decision)

- Deck Progress's metric *definition* is complete and fully unit-tested as
  of Phase 9: `lib/learning-engine/progress/deck-progress.ts`
  (`classifyDeckProgressState`, `cardProgressContribution`,
  `computeDeckProgress`). This is NOT a deferral of the metric itself.
- Only *live rendering* of a Deck Progress percentage/bar is deferred. No
  page (Home, Deck list, Deck detail, Stats, Session) wires
  `computeDeckProgress()` into a rendered number yet.
- Reason: every live `user_card_progress` row with `card_status =
  'LEARNING'` has `learning_stage = NULL` today -- the legacy runtime never
  wrote it, and the v1 Active Pool admission logic that would (Phase 3) is
  not live yet. `classifyDeckProgressState()` returns an explicit
  `{ kind: "incomplete" }` for that shape rather than guessing a stage
  (never interpreted as FRESH, never averaged/approximated, never inferred
  from legacy seen-count/streak counters) -- see that function's own doc
  comment. `computeDeckProgress()` propagates that as `{ kind: "incomplete"
  }` for the whole deck rather than silently producing a partial
  percentage. This is a data-authoritativeness boundary, not an unfinished
  metric definition.
- Live Deck Progress rendering may be enabled only after the v1 runtime
  authoritatively maintains, for every live `LEARNING` row that
  participates in Deck Progress:
  1. a real `learning_stage` (`FRESH` / `LEARNING_1` / `LEARNING_2`);
  2. the `ACQUIRED` lifecycle state (written by the v1 lifecycle, not
     backfilled/inferred);
  3. no legacy approximation anywhere in the read path.
- At that point, wire the already-tested
  `lib/learning-engine/progress/deck-progress.ts` helpers directly into the
  UI without changing their semantics -- do not re-derive the formula or
  contribution table a second time.

## Mastery notification live triggers (Phase 9 decision)

- `lib/learning-engine/progress/notifications.ts`
  (`shouldShowCardMasteredToast`, `shouldShowFullMasteryToast`) and their
  presentation components (`app/session/mastery-toast.tsx`'s
  `CardMasteredToast`/`FullMasteryToast`) are implemented and unit-tested,
  but neither is wired into `app/session/session-screen.tsx` yet.
- `shouldShowCardMasteredToast` needs an authoritative per-answer
  before/after `card_status` pair showing the ACQUIRED -> LEARNED
  transition. Today's live `commit_answer_transaction()` never writes
  `ACQUIRED` at all (legacy 4-value enum), so this transition cannot occur
  live yet.
- `shouldShowFullMasteryToast` needs an authoritative live
  `has_achieved_full_mastery` false -> true transition.
  `user_deck_learning_state.has_achieved_full_mastery` is a write-once
  column today (set only by the Phase 1 additive-schema migration's
  backfill); no trigger or trusted function updates it on any live answer,
  so it can never genuinely flip live pre-cutover. See "Stale
  `user_deck_learning_state`" immediately below.
- Wire both the same way `DailyGoalFx` is wired in `session-screen.tsx`
  today: once a trusted v1 answer-commit path supplies real before/after
  values from a single transaction, schedule the matching toast in
  `handleGrade()`'s success branch.

## Stale `user_deck_learning_state`

- `user_deck_learning_state.mastered_count` and `.has_achieved_full_mastery`
  are populated exactly once, by
  `supabase/migrations/20261001000000_learning_engine_v1_additive_schema.sql`'s
  backfill `INSERT ... ON CONFLICT (user_id, deck_id) DO NOTHING`. No
  trigger or trusted function has updated either column since -- they are
  stale the moment a tester answers another card after that migration ran.
- Phase 9 does not read either column for any live UI. Current (not
  historical) Mastered counts are instead computed live from
  `user_card_progress.card_status = 'LEARNED'` (see
  `lib/decks/dal.ts`'s `getMasteredCountsByDeck()` and
  `lib/stats/dal.ts`'s `getMasteredCardCount()`).
- A future Runtime Cutover that wires a live `user_deck_learning_state`
  updater must not assume the current backfilled values are accurate for
  any user who has answered a card since the Phase 1 migration ran.

## Selection claim idempotency

- Define the behavior for "DB commit succeeded but the response was
  lost" for a future trusted selection-claim transaction.
- Prevent a retry from creating a second logical selection/claim.
- Decide whether a retry returns the existing claim/trace.
- Current status: `insert_learning_engine_selection_trace`
  (`supabase/migrations/20261005000000_learning_engine_v1_telemetry_functions.sql`)
  treats a retried trace id as a hard duplicate-key rejection (23505), not
  an idempotent replay -- safe for Phase 8 (trace ids are server-minted,
  never client-supplied), but a future selection-CLAIM transaction is a
  different operation with its own retry/response-loss semantics that
  have not yet been designed.
