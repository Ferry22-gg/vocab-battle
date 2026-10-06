# Learning Engine v1 -- Runtime Cutover TODO

Tracked gaps that Phase 8 (telemetry persistence) deliberately left open
for a future runtime-cutover phase. Phase 8 built persistence capability
only -- none of these are implemented yet, and none may be assumed solved
by anything that exists today.

## `cards_since_last_seen` -- CLOSED (RC-C)

- Formula: `max(0, currentPresentationSchedulerPosition -
  previousPresentationSchedulerPosition - 1)`, where
  `currentPresentationSchedulerPosition` is the COMMITTED (post-increment)
  scheduler_position this answer itself occupies (the locked pre-answer
  deck `scheduler_position` + 1) -- matching every other "N intervening
  cards" rule in the engine (e.g. `active-priority.ts`'s
  `applyCorrectCooldown`), never the pre-answer `SelectionTrace` echo
  stored on `ReviewEventPosition.schedulerPosition`/`answer_events.
  scheduler_position` (which remains unchanged, selection-time-scoped, and
  still cross-checked against its linked trace by
  `insert_learning_engine_review_event`).
- `previousPresentationSchedulerPosition` is read from
  `user_card_progress.last_presented_scheduler_position` BEFORE the answer
  overwrites it with the committed position; `NULL` means no prior v1
  presentation exists (never approximated with `session_position`).
- Implementation: `lib/learning-engine/telemetry/review-event.ts`'s
  exported `deriveCardsSinceLastSeen`, fed from the new
  `ReviewEventExposureContext.currentPresentationSchedulerPosition` field
  (deliberately separate from `ReviewEventPosition.schedulerPosition`, so
  that field never has to mean two different things). See that module's
  header for the full before/after rationale, including the confirmed
  off-by-one the pre-RC-C wiring would have produced the first time this
  field was ever exercised with a real non-null previous position.

## `session_position` -- CLOSED (RC-C, confirmed RC-F)

- Source from authoritative live session state -- never trust it from
  arbitrary client telemetry.
- Original concern (Phase 8, still the correct description of the
  pre-cutover state at the time it was written): unlike
  `scheduler_position`/`scheduler_revision` (already cross-checked against
  the linked `SelectionTrace` by `insert_learning_engine_review_event`),
  `session_position` had no mechanism tying it to live session state --
  no live caller existed yet, only tests constructed the value.
- Current status: RC-C's `commit_learning_engine_v1_answer()` closes this
  by construction rather than by cross-check -- the live caller
  (`lib/learning-engine/runtime/commit-answer.ts`) sets
  `sessionPosition: context.session.totalAnswersBefore + 1`, where
  `totalAnswersBefore` is `v_session.total_answers` read from the locked
  `sessions` row inside the trusted transaction
  (`supabase/migrations/20261013000000_learning_engine_v1_runtime_cutover_rc_c_answer_commit.sql`).
  No client-supplied `session_position` is ever accepted on this path --
  there is nothing to cross-check because the value is never taken from
  the caller in the first place, which satisfies this requirement more
  directly than a cross-check would. `lib/learning-engine/telemetry/
  review-event.ts`'s `ReviewEventPosition` doc comment still describes the
  pre-RC-C state and should be read as historical context for why this
  field exists, not as an open item.

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

## Deck Progress live rendering -- CLOSED (RC-E)

- Runtime Cutover RC-E wired `computeDeckProgress()` live, gated on v1
  rollout enrollment (`learning_engine_v1_rollout` existing for the
  caller, read via `lib/learning-engine/progress/dal.ts`'s
  `isCurrentUserEnrolledInLearningEngineV1()`) -- never for a
  not-yet-enrolled legacy user, who continues to see only the
  authoritative Mastered count, matching this section's own "no legacy
  approximation anywhere in the read path" requirement below.
- Enrollment itself already normalizes every one of a user's
  `user_card_progress` rows (including soft-deleted cards', per
  `lib/learning-engine/cutover/prepare-normalization.ts`'s
  `readLegacyCardRowsForNormalization()`, which applies no
  `cards.deleted_at` filter) to a v1-valid `card_status`/`learning_stage`
  shape before any rollout row commits -- so the `incomplete` gap this
  section describes below can no longer occur for an enrolled user's live
  cards; `classifyDeckProgressState()`'s `incomplete` result remains in
  place as the data-authoritativeness guard, now simply never triggered
  in practice for a correctly-enrolled user.
- Wired into: Deck Detail (`app/decks/[deckId]/page.tsx`), the Decks list
  (`app/decks/page.tsx`/`deck-row.tsx`, one batched
  `getDeckProgressByDeck()` query for every owned deck -- never one query
  per row), and Home's Session Context card (`app/page.tsx`/
  `session-context-card.tsx`, the one selected deck only). Presentation:
  `app/decks/deck-progress-bar.tsx`.
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

## Mastery notification live triggers -- CLOSED (RC-E)

- Runtime Cutover RC-E wired both toasts into
  `app/session/session-screen.tsx`'s `handleGrade()`, exactly as this
  section anticipated: scheduled from the authoritative
  `cardMasteredJustNow`/`fullMasteryJustAchieved` result fields RC-D
  already plumbed through `submitAnswerForEngine()` (never inferred
  client-side), gated on `!data.isReplay` so a genuine
  same-`client_event_id` replay never re-shows a transient toast for a
  historically-true flag. Both can fire on the same answer (the final
  card of a deck both masters itself and completes the deck) -- each has
  its own independent fx slot and fixed vertical position in
  `app/session/battle-scene.tsx` (alongside the existing Daily Goal
  badge), so neither suppresses the other and neither blocks
  `refetchCard()`.
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

## Selection claim idempotency -- CLOSED (RC-B, confirmed RC-F)

- Define the behavior for "DB commit succeeded but the response was
  lost" for a future trusted selection-claim transaction.
- Prevent a retry from creating a second logical selection/claim.
- Decide whether a retry returns the existing claim/trace.
- Original status (Phase 8, still the correct description of the
  pre-cutover state at the time it was written): `insert_learning_engine_selection_trace`
  treated a retried trace id as a hard duplicate-key rejection (23505),
  not an idempotent replay -- safe for Phase 8 (trace ids are
  server-minted, never client-supplied), but a future selection-CLAIM
  transaction was a different operation whose own retry/response-loss
  semantics had not yet been designed.
- Current status: RC-B's `claim_next_learning_engine_card()`
  (`supabase/migrations/20261009000000_learning_engine_v1_runtime_cutover_rc_b_selection_claim.sql`,
  corrected further in `20261011000000_learning_engine_v1_runtime_cutover_rc_b_active_draw_counters.sql`)
  answers all three questions above directly: a partial unique index
  (`selection_claims_one_open_per_session_idx`) enforces at most one OPEN
  claim per session; the function's own first step after locking the
  session row is an OPEN-claim fast path that returns the existing claim
  unchanged (`reused: true`) without re-deriving or re-persisting any
  claim-time state (admissions, first-pass queue, shuffle bag,
  `active_draws_since_eligible` deltas, `scheduler_revision`); a genuinely
  new selection only proceeds when no OPEN claim exists. Covered by pgTAP
  `supabase/tests/019_learning_engine_v1_runtime_cutover_rc_b_test.sql`.
  Live-wired via `lib/learning-engine/runtime/claim-next-card.ts` ->
  `claim-dal.ts`, called from `app/actions/sessions.ts`.
