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
