# Continuous Learning Engine v1 — Implementation Specification for Claude Code

**Status:** v1 implementation specification  
**Purpose:** normative engineering handoff for implementing the learning engine in a gamified memorization application  
**Primary audience:** Claude Code / software engineers  
**Product context:** a new learning application that combines continuous battle-style play with evidence-informed retrieval practice and FSRS-based long-term scheduling  
**UI language:** English by default  
**Primary card direction in MVP:** English → Japanese, while the engine itself must remain content-domain agnostic

---

## 0. How to use this document

This document is the **implementation source of truth for Learning Engine v1**. It is intentionally more prescriptive than the design paper.

When implementing:

- **MUST** means required for v1 behavior.
- **SHOULD** means strongly preferred unless an existing architectural constraint makes it impractical.
- **MAY** means optional or future-compatible.
- Do **not** silently replace the rules below with default Anki behavior, default FSRS UI behavior, or a conventional “review session” model.
- Do **not** add a Pre-Active pool.
- Do **not** expose Again / Hard / Good / Easy to the learner in v1.
- Do **not** make Daily Goal completion terminate a session.
- Do **not** equate same-day acquisition with long-term mastery.

Where an implementation detail was not scientifically established, this specification chooses an explicit v1 default so the system is testable. Those choices must remain configurable and logged by policy version.

---

# 1. Core product and learning principles

## 1.1 Continuous voluntary-exit learning

The session has **no hard endpoint**.

The core behavioral principle is:

> **A psychological stopping point exists; a physical stopping point does not.**

The user may continue indefinitely after completing the Daily Goal. The app must never require a “Continue?” action after the Daily Goal or Full Mastery notification.

## 1.2 One unified card stream

Do not create separate user-facing “Learn” and “Review” sessions.

All of the following must be integrated into a single battle stream:

- within-day acquisition;
- FSRS due reviews;
- optional near-due reviews;
- repair retries after Wrong answers;
- post-mastery maintenance/free play.

The user should normally experience these as one continuous flow.

## 1.3 Learning engine and battle engine are separate systems

The Learning Engine decides:

- which card should appear next;
- when a card is eligible;
- memory-state transitions;
- FSRS updates;
- priority and safety guarantees.

The Battle Engine decides:

- enemy HP;
- player damage;
- combo effects;
- critical hits;
- XP;
- world progression;
- animations;
- rewards.

**Do not make memory-state transitions depend on damage, enemy HP, or XP.**

## 1.4 Binary learner input

The learner-facing answer quality in v1 is only:

- `WRONG`
- `CORRECT`

The UX must not require Again / Hard / Good / Easy self-rating after every card.

For FSRS integration in v1:

```text
WRONG   -> Again
CORRECT -> Good
```

Raw behavior must still be logged for future inference of latent retrieval quality.

---

# 2. Terminology and state separation

The engine must keep the following concepts separate:

1. **Backend memory status** — broad learning state.
2. **Within-day learning stage** — progress inside acquisition.
3. **Pool / scheduler membership** — where the card can be selected from.
4. **FSRS memory state** — D/S/R and schedule.
5. **User-facing status label** — simplified display language.
6. **Position counters** — see below. Do not collapse these either.

Do not collapse these into one enum.

## 2.1 `scheduler_position` vs `session_position` (Approved Clarification 10)

The engine uses two distinct position counters, never conflated:

```text
scheduler_position
  scope:      per (user, deck)
  behavior:   monotonically increasing
  lifetime:   never reset between Sessions
  governs:    Correct cooldown windows, Repair target/hard-cap windows,
              Spaced Confirmation gaps, Critical Due spacing (section
              22.2), Active starvation draw counting (section 22.3), and
              every other "N intervening cards" rule in this document.

session_position
  scope:      local to one app Session
  behavior:   restarts in a later Session
  governs:    nothing described in this document — it exists only as a
              user-facing/telemetry position within the current Session,
              distinct from the scheduler's own counters above.
```

Wherever this document says "intervening cards," "global questions," or
a bare "position," it means `scheduler_position` unless explicitly
stated otherwise. A future trusted implementation must not substitute
`session_position` for `scheduler_position` in any of the above rules,
and must not derive `scheduler_position` from session-local state.

---

# 3. Backend card states

## 3.1 `card_status`

Allowed values:

```text
NEW
LEARNING
ACQUIRED
LEARNED
FORGOTTEN
```

### `NEW`

The card has not yet been meaningfully entered into the user's learning history.

Important:

- A card may already be placed in `ACTIVE` while still `NEW`.
- **Entering Active does not change NEW → LEARNING.**
- The transition occurs on **first actual presentation in a session**.

### `LEARNING`

The card has been encountered and is currently in the within-day acquisition process.

### `ACQUIRED`

The card has completed the within-day acquisition criterion.

Meaning:

> “The learner demonstrated sufficient same-day retrieval success to leave concentrated short-term acquisition.”

It does **not** mean long-term mastery.

### `LEARNED`

The card has met the engine's long-term mastery criterion.

User-facing label: `MASTERED`.

This is **reversible**. A future failure can move the card to `FORGOTTEN`.

### `FORGOTTEN`

A long-term or near-due retrieval failure has provided evidence that the card requires short-term repair/relearning.

User-facing label: `RELEARNING`.

---

# 4. User-facing status mapping

Do not persist a second independent display-state machine. Derive the label from backend state.

| Backend `card_status` | User-facing label |
|---|---|
| `NEW` | `NEW` |
| `LEARNING` | `LEARNING` |
| `ACQUIRED` | `LEARNED` |
| `LEARNED` | `MASTERED` |
| `FORGOTTEN` | `RELEARNING` |

Rationale:

- `ACQUIRED` is useful internally but not intuitive enough for learner-facing UI.
- `FORGOTTEN` should not be shown as a punitive static label; `RELEARNING` communicates an active recovery process.

---

# 5. Within-day learning stages

## 5.1 `learning_stage`

For ordinary acquisition:

```text
FRESH
LEARNING_1
LEARNING_2
null
```

### Implementation normalization

The design paper occasionally uses a relearning label inside `learning_stage`. To avoid overloading the acquisition enum, v1 implementation SHOULD use a separate field:

```text
relearning_phase = null | REPAIR_PENDING | SPACED_CONFIRMATION_PENDING
```

This normalization does not change behavior.

---

# 6. Pool model

## 6.1 No Pre-Active pool

The old Pre-Active concept is removed.

Do not implement:

```text
NEW -> PRE_ACTIVE -> ACTIVE
```

Use:

```text
NEW reservoir -> ACTIVE directly when Fresh capacity exists
```

## 6.2 `pool_status`

Allowed persisted values:

```text
ACTIVE
OUTSIDE
null
```

Interpretation:

- `ACTIVE`: concentrated within-day acquisition/relearning area.
- `OUTSIDE`: long-term memory side managed by FSRS / near-due logic.
- `null`: NEW card still in the general deck reservoir and not yet admitted to Active.

---

# 7. Core v1 parameters

```yaml
active_pool_target: 20
fresh_card_limit: 6
fresh_exit_success_count: 1
active_graduation_success_count: 3

correct_min_gap: 5
wrong_retry_min_gap: 3
wrong_retry_hard_cap: 6

fresh_stage_weight: 1.00
learning_1_stage_weight: 1.20
learning_2_stage_weight: 1.10

desired_retention_default: 0.90
desired_retention_retention_loss: 0.92

near_due_start_progress: 0.75
near_due_end_progress: 1.00

mastery_correct_count_required: 3
mastery_correct_streak_required: 2

critical_due_R_threshold: 0.60
critical_due_max_global_gap: 5

active_starvation_max_active_source_draws: 40

daily_goal_enemy_defeats: 5
```

All policy values MUST be versioned.

Recommended:

```text
policy_version = "learning-engine-v1.0"
```

---

# 8. Active Pool lifecycle

## 8.1 Target size

The saturated Active Pool target is:

```text
20 cards
```

This is a target, not a requirement that the pool instantly contain 20 cards.

## 8.2 Fresh limit

At most:

```text
6 cards
```

may simultaneously be Fresh.

`FRESH` means the card has not yet achieved its first successful retrieval.

## 8.3 New deck startup behavior

For a completely new deck:

```text
Active = min(6, available NEW cards)
Fresh = Active
```

As Fresh cards receive their first Correct:

1. the card leaves Fresh and becomes `LEARNING_1`;
2. one Fresh slot opens;
3. the engine may admit another NEW card from the reservoir;
4. Active grows gradually toward 20.

Example:

```text
Start:        Active 6  / Fresh 6
A first OK:   Active 7  / Fresh 6
B first OK:   Active 8  / Fresh 6
...
Eventually:   Active 20 / Fresh <= 6
```

This creates adaptive new-card throughput without a separate `new_cards_per_day` rule.

## 8.4 Active refill

Pseudo-rule:

```text
while active_count < 20
  and fresh_count < 6
  and NEW reservoir is non-empty:
    admit next NEW card to ACTIVE
    keep card_status = NEW until first presentation
```

### Admission decision vs. admission persistence (Approved Clarification 14)

These are two different moments, deliberately kept separate:

```text
DECIDE   (pure):   the scheduler decides, as part of computing one
                    next-card decision, which NEW cards this decision
                    virtually admits. These admitted card ids are part
                    of that decision's trusted trace (section 30) —
                    not yet durable state.

PERSIST  (trusted): a future trusted selection-claim transaction is the
                    only thing that durably commits an admission. In
                    one atomic transaction it persists, together:
                      - the claimed card selection itself;
                      - the Active admissions decided above;
                      - the resulting scheduler_position/
                        scheduler_revision (section 2.1);
                      - any first-pass queue change (section 9.1/9.2);
                      - any other claim-time scheduler state change.
```

The trusted claim transaction MUST validate `scheduler_revision` (or an
equivalent optimistic-concurrency token) against the snapshot the
decision was computed from, and reject/retry rather than commit when
the deck's scheduler state has moved on — otherwise a stale snapshot
could durably commit a duplicate or conflicting admission. This
specification does not itself define that transaction's implementation
(see docs/LEARNING_ENGINE_V1_RUNTIME_CUTOVER_TODO.md); it only requires
that whatever implements it preserve this decide/persist separation and
this validation.

---

# 9. First encounters

When several Active cards are `NEW` and never presented, the engine SHOULD use a randomized no-repeat first-pass order.

Example for six initial cards:

```text
D, A, F, B, C, E
```

not:

```text
A, A, B, A, C, ...
```

This rule prevents monotonous startup behavior.

## 9.1 Formal first-pass rule (Approved Clarification 1)

```text
At first-pass BATCH creation time:
  snapshot the currently ACTIVE + NEW + never-presented cards
  randomly shuffle that finite snapshot
  serve the resulting finite queue without replacement
```

- A card already served from that queue does NOT re-enter ordinary
  weighted Active selection until the queue is exhausted — even though
  its state has already changed from `NEW`/`FRESH` to `LEARNING`/`FRESH`
  on first presentation (section 3 "NEW").
- Ordinary Due, Near-Due, a sampled repair target reached, and a due
  Spaced Confirmation do **not** preempt the first-pass queue.
- Only the two global interrupts may preempt it:
  - Repair hard cap (section 22.1);
  - Critical Due (section 22.2).
- After such an interrupt, the scheduler resumes the SAME remaining
  queue, in the same order, without reshuffling.

## 9.2 Admission during an active first-pass batch (Approved Clarification 2)

- A NEW card admitted to Active (section 8.4) while a first-pass batch
  is already in flight is **not** appended to that running queue.
- It waits until the current finite batch is exhausted.
- Once exhausted:
  - if several never-presented ACTIVE+NEW cards exist, create a new
    finite randomized first-pass batch (section 9.1) from exactly those
    cards;
  - if only one such card exists, no dedicated first-pass batch is
    required for it — it may participate as an ordinary Active
    candidate through the normal weighted-selection path instead.

Repair hard caps and critical safety interrupts may still preempt the first-pass ordering (section 9.1).

---

# 10. Within-day acquisition progression

The normative acquisition path is:

```text
FRESH
  -> first CORRECT
LEARNING_1
  -> at least 5 intervening cards + normal CORRECT
LEARNING_2
  -> at least 5 intervening cards + normal CORRECT
ACQUIRED
```

Equivalent success structure:

```text
Successful retrieval #1 -> L1
Successful retrieval #2 -> L2
Successful retrieval #3 -> ACQUIRED
```

The second and third successes must be normal spaced retrievals, not repair confirmations.

---

# 11. Correct handling

## 11.1 Normal Correct

After a normal stage-advancing Correct:

```text
card is ineligible for the next 5 intervening cards
```

After five intervening cards, the card becomes eligible again.

It is **not guaranteed** to appear immediately on card 6. It returns to weighted selection.

## 11.2 Stage transitions

```text
FRESH + normal Correct       -> LEARNING_1
LEARNING_1 + normal Correct  -> LEARNING_2
LEARNING_2 + normal Correct  -> ACQUIRED + OUTSIDE
```

When moving to ACQUIRED:

```text
learning_stage = null
pool_status = OUTSIDE
```

FSRS becomes responsible for long-term timing.

---

# 12. Wrong / Repair logic

## 12.1 Immediate response to Wrong

On every Wrong:

1. show immediate corrective feedback;
2. record raw Wrong event;
3. create a repair obligation;
4. do not immediately repeat the same card.

## 12.2 Repair window

Normative rule:

```text
minimum gap: 3 intervening cards
hard cap:    6 intervening cards
```

The repair must occur somewhere in the 3–6 window.

### Implementation default for randomness inside the window

The scientifically important rule is the bounded 3–6 window, not a specific probability distribution. For an executable v1:

- sample a target repair offset uniformly from `{3,4,5,6}`;
- if multiple repair targets collide, resolve by oldest Wrong first with random tie-break;
- a target may be moved earlier only by explicit safety logic;
- never move it later than the 6-card hard cap;
- the hard-cap repair has priority over Critical Due.

Keep the target-gap sampling strategy configurable so beta data can replace the uniform default later.

### Repair target reached vs. repair hard cap reached (Approved Clarification 3)

These are two different events with two different scopes, in ordinary (non-Post-Mastery) mode:

```text
sampled repair TARGET reached (scheduler_position >= targetPosition)
  -> does NOT force the next global question
  -> it is serviced with priority at the next ACTIVE source slot
     (section 19.2's internal Active-source ordering)

repair HARD CAP reached (scheduler_position >= hardCapPosition)
  -> IS a global interrupt (section 22.1/23)
  -> remains above Critical Due in interrupt priority
```

A repair target becoming eligible is a change in *priority within the
Active source*, not a change in *which source is drawn*. Only the hard
cap forces a card onto the current global question regardless of
source.

### Repair collisions: selection-time only, never stored-position shifting (Approved Clarification 6)

- Each repair obligation keeps its own, independently sampled
  `targetPosition` and `hardCapPosition` (section 29.1), computed once
  from its own `wrongPosition` and never recomputed.
- Two repairs' positions are allowed to collide (share the same
  absolute `scheduler_position` value). The engine does **not** mutate
  or shift a stored `targetPosition`/`hardCapPosition` to avoid such a
  collision.
- Collisions are resolved at **selection time** only: whichever repair
  is actually due is prioritized oldest-`wrongPosition`-first, exact-tie
  broken by RNG (section 35.2). A non-winning repair is never discarded
  — it is simply reconsidered on the next draw, with its own positions
  unchanged.
- This is explicitly **not** the legacy SRS behavior of shifting a
  queue position forward to resolve a collision (the reappearance-floor
  collision-shift some earlier/legacy scheduling code used). v1's repair
  scheduler never shifts a stored position for this reason.

## 12.3 Repair Correct does not normally advance acquisition stage

For `LEARNING_1` or `LEARNING_2`:

```text
Wrong
-> Repair Correct
-> remain at same learning stage
-> start normal 5-card Correct cooldown
```

Reason: the repair success demonstrates that the immediate error was repaired, not that a normally spaced new success has been demonstrated.

## 12.4 Fresh exception

For `FRESH`, the first successful retrieval is enough to leave Fresh even if it occurs on a Repair Retry.

```text
FRESH
-> Wrong
-> corrective feedback
-> Repair Correct in 3–6 window
-> LEARNING_1
```

This avoids an asymmetric Fresh rule where an initial first-try Correct would graduate Fresh but an actual successful repair retrieval would not.

## 12.5 Repair-retry Wrong (RC-C locked correction)

Normative rule, locked during the v1 Runtime Cutover (RC-C) to close a gap
this specification originally left unaddressed: a Wrong answer on an
already-pending within-day Repair retry (i.e. the card was presented via
the repair target or repair hard cap, section 12.2).

```text
FRESH / LEARNING_1 / LEARNING_2
-> repair-pending card presented again
-> Wrong (again)
-> stage NEITHER advances NOR regresses
-> card remains ACTIVE, remains repair-governed
-> the OLD RepairObligation is replaced by a brand-new one,
   anchored at the CURRENT Wrong position, sampled via the same
   {3,4,5,6} target window / fixed 6-card hard cap as every other Wrong
```

Rationale: the repair retry presentation itself satisfied the OLD
obligation's requirement to present the card within its window. Failing
that retrieval again is new evidence that creates a NEW obligation — it
does not mean the repair mechanism itself failed or should be abandoned.
This is a direct reading of section 12.1's "on every Wrong... create a
repair obligation" applied uniformly, including to a Wrong that happens to
occur on an existing repair retry.

```text
Wrong A
-> repair presented within A's 3–6 window
-> Repair Wrong B
-> a NEW repair window opens from B (3–6 intervening cards from B)
-> Repair Wrong C
-> a NEW repair window opens from C
-> ...
```

Each new Wrong starts a fresh, bounded repair obligation. This does not
violate the previous obligation's hard cap — that obligation was serviced
(the card was presented within its window); it simply failed again.

This does **not** apply another FSRS Again update — Repair is a within-day
mechanism, never a second long-term FSRS failure for the same underlying
lapse (see section 16.3's own long-term Wrong, which is the only event
that applies FSRS Again for a given lapse). It does not increment or
decrement `fsrs_review_correct_count`/`fsrs_review_correct_streak`.

---

# 13. Repair of long-term failures / Relearning

A long-term or Near-Due failure that enters Relearning triggers:

```text
card_status = FORGOTTEN
pool_status = ACTIVE
relearning_phase = REPAIR_PENDING
UI = RELEARNING
```

Then:

```text
Wrong
-> corrective feedback
-> Repair Correct within 3–6 cards
-> relearning_phase = SPACED_CONFIRMATION_PENDING
-> at least 5 intervening cards
-> Spaced Correct
-> relearning complete
```

The first Repair Correct alone is not enough to complete relearning.

## 13.1 Pool membership during and after Relearning (Approved Clarification 13)

`pool_status = ACTIVE` here means exactly what section 6.2 defines it to
mean: the short-term acquisition/relearning area, not long-term FSRS
scheduling. A `FORGOTTEN` card is, for scheduling purposes, governed the
same way a within-day repair is — eligible through the repair/
Spaced-Confirmation channels (sections 12.2/13), not through ordinary
ACTIVE weighted selection (section 19.2).

On relearning completion, `pool_status` returns to `OUTSIDE` (long-term
FSRS scheduling resumes), branching only on prior mastery history
(section 25.2):

```text
never previously mastered (has_ever_been_mastered = false)
  -> card_status = ACQUIRED, pool_status = OUTSIDE

previously mastered (has_ever_been_mastered = true)
  -> card_status = LEARNED, pool_status = OUTSIDE  (MASTERED RESTORED)
```

## 13.2 Relearning Repair Wrong and Spaced Confirmation Wrong (RC-C locked correction)

Normative rule, locked during the v1 Runtime Cutover (RC-C) to close a gap
this specification originally left unaddressed, extending section 12.5's
rule to the relearning side of the lifecycle.

### Relearning Repair Wrong

A Wrong on an already-pending RELEARNING repair retry (`card_status =
FORGOTTEN`, `relearning_phase = REPAIR_PENDING`):

```text
FORGOTTEN / REPAIR_PENDING
-> repair-pending card presented again
-> Wrong (again)
-> remains FORGOTTEN
-> remains REPAIR_PENDING (does NOT advance to SPACED_CONFIRMATION_PENDING
   -- only a Repair Correct may do that)
-> remains ACTIVE
-> has_ever_been_mastered is preserved, untouched
-> the OLD RepairObligation is replaced by a brand-new one, anchored at
   the CURRENT Wrong position, via the same construction as every other
   Wrong (section 12.5)
```

### Spaced Confirmation Wrong

A Wrong on the mandatory Spaced Confirmation retry (`card_status =
FORGOTTEN`, `relearning_phase = SPACED_CONFIRMATION_PENDING`) means the
earlier repair was not durably retained:

```text
FORGOTTEN / SPACED_CONFIRMATION_PENDING
-> Spaced Confirmation Wrong
-> falls BACK to REPAIR_PENDING (never directly to another Spaced
   Confirmation)
-> remains ACTIVE
-> has_ever_been_mastered is preserved, untouched
-> a brand-new RepairObligation is created, anchored at the CURRENT
   Wrong position
-> the card must complete the full sequence again from scratch:
   new Repair Correct -> SPACED_CONFIRMATION_PENDING -> at least 5
   intervening cards -> new Spaced Confirmation Correct -> relearning
   complete
```

Neither case applies a second long-term FSRS Again update — the original
qualifying long-term/Near-Due Wrong (section 16.3) already applied FSRS
Again and reset `fsrs_review_correct_streak` to 0 for this lapse; Repair
and Spaced Confirmation are within-day/custom-engine mechanics layered on
top of that single long-term failure, not additional long-term failures.
Neither case increments or decrements `fsrs_review_correct_count`/
`fsrs_review_correct_streak`.

---

# 14. FSRS integration

## 14.1 FSRS version

Use an FSRS-6-compatible implementation.

FSRS parameters (`w0...w20`) are **model-level parameters**, not card-level state.

Card-level FSRS state includes at least:

```text
D = Difficulty
S = Stability
R = Retrievability (derived / current)
last_review_at
scheduled_due_at
scheduled_interval
```

## 14.2 FSRS ownership boundary

FSRS is responsible for **long-term scheduling after ACQUIRED**.

The custom within-day engine is responsible for:

- Fresh gating;
- acquisition progression;
- repair windows;
- five-card spaced confirmation;
- continuous source mixing.

Do not use FSRS to replace the within-day Active acquisition rules.

## 14.3 Desired retention

Default:

```text
0.90
```

If onboarding `pain_point = retention_loss`:

```text
0.92
```

This is a preference prior, not an inference that the user has poor memory.

---

# 15. First-time Mastery / `ACQUIRED -> LEARNED`

First-time long-term mastery requires both:

```text
fsrs_review_correct_count >= 3
AND
fsrs_review_correct_streak >= 2
```

Only **qualifying scheduled FSRS long-term reviews** increment these counters.

Do not increment mastery counters for:

- same-day Active Corrects;
- repair Corrects;
- optional Near-Due Corrects;
- Random Mastered free-play Corrects.

## 15.1 Counter behavior

On qualifying scheduled FSRS Correct:

```text
correct_count  += 1
correct_streak += 1
```

On qualifying FSRS Wrong:

```text
correct_count  remains unchanged
correct_streak = 0
```

The count represents cumulative long-term evidence. The streak represents recent stability.

## 15.2 Mastery transition

When both thresholds are satisfied:

```text
card_status = LEARNED
has_ever_been_mastered = true
```

UI:

```text
MASTERED
```

---

# 16. Near-Due layer

Near-Due is an app-level layer added on top of FSRS to support continuous play.

## 16.1 Eligibility

Let:

```text
interval_progress = elapsed_time_since_last_long_term_review / scheduled_interval
```

Then:

```text
progress < 0.75        -> STRONG_OUTSIDE, not ordinarily selectable
0.75 <= progress < 1.0 -> NEAR_DUE
progress >= 1.0        -> FSRS_DUE
```

## 16.2 Near-Due Correct

On Near-Due Correct:

- update FSRS using the early Correct / Good event;
- do **not** increment `fsrs_review_correct_count`;
- do **not** increment `fsrs_review_correct_streak`;
- keep current mastery status unless FSRS update changes schedule only.

The early success is treated as weaker mastery evidence than a scheduled long-term success.

## 16.3 Near-Due Wrong

Near-Due Wrong is treated as strong diagnostic evidence.

On Near-Due Wrong:

```text
FSRS -> Again
card_status -> FORGOTTEN
pool_status -> ACTIVE
relearning_phase -> REPAIR_PENDING
fsrs_review_correct_streak -> 0
fsrs_review_correct_count -> preserve
start Relearning repair path
```

(Pool-membership semantics for `pool_status = ACTIVE` here and the post-relearning outcome: section 13.1.)

---

# 17. Due card priority

When the selected source is `FSRS_DUE`, card priority is based primarily on Retrievability.

Let:

- `R_i` = current Retrievability of card i;
- `r_d` = desired retention.

Use:

```text
w_due(i) = min(3.0, sqrt((1 - R_i) / (1 - r_d)))
```

Then sample using weighted random:

```text
P(i) = w_due(i) / sum(w_due)
```

Do not separately multiply by days overdue in v1. R already reflects elapsed-time risk relative to Stability.

Log days overdue for analytics.

---

# 18. Near-Due card priority

Let:

```text
p = interval_progress, where 0.75 <= p < 1.0
x = (p - 0.75) / 0.25
w_near = 1 + 0.5 * x
```

Therefore approximately:

| Interval progress | Weight |
|---:|---:|
| 75% | 1.00 |
| 80% | 1.10 |
| 85% | 1.20 |
| 90% | 1.30 |
| 95% | 1.40 |
| ~100% | 1.50 |

Use weighted random inside the Near-Due source.

R must still be logged but is not multiplied into Near-Due priority in v1 to avoid double-counting the same forgetting progression.

---

# 19. Active card priority

Only normally eligible Active cards participate.

Base stage weights:

```text
FRESH      = 1.00
LEARNING_1 = 1.20
LEARNING_2 = 1.10
```

Then:

```text
active_weight = stage_base_weight * aging_multiplier
```

## 19.1 v1 aging multiplier

Use Active-source selections since the card became eligible:

```text
0–4   draws -> 1.00
5–9   draws -> 1.10
10–14 draws -> 1.20
15–19 draws -> 1.30
20+   draws -> 1.40
```

The aging multiplier is a soft preference only. The hard starvation rule below is authoritative.

## 19.2 Internal Active-source ordering (Approved Clarification 4)

When an ACTIVE source slot occurs (section 23), candidates within that
slot are considered in this fixed priority order — only the first tier
with an eligible candidate is used:

```text
1. Active starvation (section 22.3)
2. target-reached Repair (section 12.2's target, not the hard cap)
3. due Spaced Confirmation (section 13)
4. ordinary stage-weighted Active (sections 19, 19.1)
```

Rationale, kept concise:

- starvation is a guaranteed presentation on the next Active slot — it
  cannot be deferred further without violating section 22.3;
- a target-reached repair has a hard deadline (the hard cap, section
  12.2) it must not be allowed to drift toward unnecessarily;
- a due Spaced Confirmation has a minimum gap but no maximum, so it may
  safely wait behind the two tiers above;
- ordinary weighted Active has neither a starvation guarantee nor a
  deadline, so it is the fallback tier.

### Multiple Spaced Confirmations ready at once (Approved Clarification 5)

When more than one card's Spaced Confirmation gate (tier 3 above) is
open simultaneously:

- the card whose `correct_cooldown_until_position` is smallest wins —
  equivalently, whichever gate opened earliest is served first;
- RNG is used only to break an exact tie.

---

# 20. Dynamic Source Weight v1

Ordinary source set:

```text
ACTIVE
FSRS_DUE
NEAR_DUE
```

Compute:

```text
due_pressure = due_count / active_pool_target
             = due_count / 20
```

Re-evaluate before every ordinary card selection.

## 20.1 Before Daily Goal completion

### Active Focus

Condition:

```text
due_count == 0
```

Weights:

```text
ACTIVE    0.90
FSRS_DUE  0.00
NEAR_DUE  0.10
```

### Balanced

Condition:

```text
0 < due_count / 20 < 0.5
```

Equivalent with target 20:

```text
1–9 Due cards
```

Weights:

```text
ACTIVE    0.70
FSRS_DUE  0.25
NEAR_DUE  0.05
```

### Review Pressure

Condition:

```text
due_count / 20 >= 0.5
```

Equivalent:

```text
10+ Due cards
```

Weights:

```text
ACTIVE    0.50
FSRS_DUE  0.48
NEAR_DUE  0.02
```

## 20.2 After Daily Goal completion

### Post-goal Active Focus

```text
ACTIVE    0.80
FSRS_DUE  0.00
NEAR_DUE  0.20
```

### Post-goal Balanced

```text
ACTIVE    0.75
FSRS_DUE  0.15
NEAR_DUE  0.10
```

### Post-goal Review Pressure

Unchanged:

```text
ACTIVE    0.50
FSRS_DUE  0.48
NEAR_DUE  0.02
```

The goal overlay must never suppress a genuinely large review backlog.

---

# 21. Empty-source renormalization

Before drawing a source:

1. remove any source with zero eligible cards;
2. renormalize remaining weights to sum to 1;
3. sample from the normalized distribution.

Example:

Nominal:

```text
ACTIVE 0.90 / NEAR 0.10
```

If Near-Due is empty:

```text
ACTIVE -> 1.00
```

Never attempt to draw from an empty source.

---

# 22. Interrupt and starvation layer

Interrupt logic is evaluated **before ordinary source selection**.

Priority:

```text
1. Repair hard cap
2. Critical Due guarantee
3. Active starvation guarantee at the next Active slot
4. Normal scheduler
```

Item 3 here is not a third GLOBAL interrupt of the same kind as items 1
and 2 — as section 22.3 itself notes, it does not force the next global
question to become Active. It is listed in this priority order only to
show that, once the normal scheduler has already chosen `ACTIVE` as the
source, starvation is the first thing checked within it. The full
internal ordering within an Active-source slot (starvation, then
target-reached Repair, then due Spaced Confirmation, then ordinary
weighted Active) is section 19.2.

## 22.1 Repair hard cap

A repair target may never be delayed beyond 6 intervening cards.

If several hard caps collide:

- oldest hard cap first;
- random tie-break if equal.

## 22.2 Critical Due

Critical Due definition:

```text
R <= 0.60
```

If at least one Critical Due card exists and no Critical Due card has been presented in the last 5 **global questions**, force one Critical Due card.

Within the critical set, use the normal Due weight formula.

### Exact five-question boundary (Approved Clarification 11)

"Global questions" here means `scheduler_position` steps (section 2.1).
If a Critical Due card is presented at `scheduler_position = P`
(persisted as `last_critical_due_position = P`):

```text
positions P+1 through P+5: another Critical Due is NOT forced by this
                            guarantee (a different interrupt/tier may
                            still present one, e.g. the normal Due draw)
scheduler_position reaches P+5: the guarantee's 5-question window has
                                 fully elapsed
position P+6: the next question MAY force Critical Due again, if at
              least one Critical Due card still exists
```

A single persisted `last_critical_due_position` value is sufficient to
implement this guarantee exactly — no separate rolling window or
per-question history is required.

## 22.3 Active starvation

If an eligible Active card has survived:

```text
40 Active-source selections
```

without being selected, guarantee it on the **next Active source slot**.

Important:

- This does not necessarily force the entire next global question to become Active.
- It prevents starvation inside the Active source without destroying Review Pressure mode.

### Multiple starvation candidates (Approved Clarification 8)

If more than one eligible Active card simultaneously satisfies the
40-draw threshold:

- select the card with the greatest `active_draws_since_eligible`;
- break an exact tie with RNG.

This selects the card that has survived the greatest number of
legitimate Active selection opportunities.

### `active_draws_since_eligible` counter semantics (Approved Clarification 9)

```text
increment by 1 only when ALL of the following hold for one ACTIVE
source slot:
  - the card was genuinely eligible for ordinary weighted Active
    selection (section 19) at that slot;
  - an ACTIVE source slot actually occurred;
  - a DIFFERENT card was the one selected.

freeze (do not increment) while:
  - the card's Correct cooldown (section 11.1) is active;
  - Repair/Relearning governance makes the card unavailable for
    ordinary Active selection (sections 12, 13).

reset to 0 whenever the card is actually presented, through ANY
applicable path (ordinary weighted Active, starvation itself, a
serviced repair target/hard cap, or a Spaced Confirmation).
```

Do not count elapsed time or global questions for which the card was
never a legitimate ordinary-Active candidate in the first place — doing
so would make an ineligible card appear to be starving when it was
simply unavailable.

## 22.4 Near-Due starvation

No hard guarantee.

If Near-Due is skipped long enough, it naturally becomes formally Due.

---

# 23. Next-card selection pipeline

The scheduler must follow this conceptual pipeline:

```text
refresh time-dependent state
    ↓
refill Active if Fresh capacity exists
    ↓
check hard Repair interrupt (hard cap ONLY — section 12.2/22.1)
    ↓
check Critical Due interrupt
    ↓
[Post-Mastery mode only: pre-draw relearning-servicing tier —
 target-reached Repair / due Spaced Confirmation, section 25.3]
    ↓
choose ordinary mode/source weights
    ↓
remove empty sources and renormalize
    ↓
choose source
    ↓
if source == ACTIVE and a first-pass batch is in flight (section 9.1):
    serve the batch's next card (preempted only by the two interrupts
    above, never reshuffled)
else if source == ACTIVE:
    within-source internal ordering (section 19.2):
      1. Active starvation
      2. target-reached Repair
      3. due Spaced Confirmation
      4. ordinary stage-weighted Active
    ↓
choose card by source-specific weighted random
    ↓
emit decision trace
    ↓
present card
```

---

# 24. Scheduler pseudocode

```pseudo
function choose_next_card(user, deck, session, now):
    refresh_time_dependent_states(deck, now)
    refill_active_if_needed(deck)

    # 1. Mandatory repair safety -- the HARD CAP only. A merely
    #    target-reached repair is NOT a global interrupt (section 12.2's
    #    "Repair target reached vs. repair hard cap reached"); it is
    #    serviced inside the Active-source-internal ordering below.
    repair = choose_repair_hard_cap(deck, session)
    if repair != NONE:
        return Selection(repair, reason="repair_hard_cap")

    # 2. Critical long-term memory safety
    critical = choose_critical_due_interrupt(deck, session)
    if critical != NONE:
        return Selection(critical, reason="critical_due_interrupt")

    # 2b. Post-Mastery mode has no ACTIVE source to service a
    #     target-reached repair or due Spaced Confirmation through, so
    #     this pre-draw tier checks for them before the ordinary weighted
    #     draw (section 25.3's "Repair/Spaced Confirmation servicing in
    #     pure Post-Mastery mode").
    if should_use_post_mastery_free_play(deck):
        relearning = choose_post_mastery_relearning_servicing(deck, session)
        if relearning != NONE:
            return Selection(relearning, reason=relearning.reason)  # "repair_target" or "spaced_confirmation"

    # 3. Mode selection
    if should_use_post_mastery_free_play(deck):
        weights = post_mastery_source_weights(deck, user)
    else:
        weights = ordinary_source_weights(deck, user)

    weights = remove_empty_sources_and_renormalize(weights, deck)
    source = weighted_random_source(weights)

    # 4. Source-internal selection
    if source == ACTIVE:
        # First-pass batch in flight (section 9.1): served without
        # reshuffling, preempted only by steps 1-2 above -- never by an
        # ordinary Due/Near-Due/repair-target/Spaced-Confirmation check.
        first_pass_card = serve_first_pass_batch_if_in_flight(deck)
        if first_pass_card != NONE:
            card = first_pass_card
            reason = "active_first_pass"
        else:
            # Internal Active-source ordering (section 19.2): starvation
            # > target-reached repair > due Spaced Confirmation > ordinary.
            starvation = active_starvation_candidate(deck)
            repair_target = repair_target_reached_candidate(deck, session)
            spaced_confirmation = due_spaced_confirmation_candidate(deck, session)
            if starvation != NONE:
                card = starvation
                reason = "active_starvation"
            else if repair_target != NONE:
                card = repair_target
                reason = "repair_target"
            else if spaced_confirmation != NONE:
                card = spaced_confirmation
                reason = "spaced_confirmation"
            else:
                card = choose_active_card(deck)
                reason = "active_weighted_selection"

    else if source == FSRS_DUE:
        card = choose_due_card(deck, user.desired_retention)
        reason = "due_weighted_selection"

    else if source == NEAR_DUE:
        card = choose_near_due_card(deck)
        reason = "near_due_weighted_selection"

    else if source == RANDOM_MASTERED:
        card = draw_from_mastered_shuffle_bag(deck)
        reason = "random_mastered_shuffle_bag"

    else:
        raise SchedulerInvariantError

    emit_selection_trace(...)
    return Selection(card, reason)
```

---

# 25. Post-Mastery Mode

## 25.1 Persistent deck unlock

When:

```text
mastered_count == total_cards
```

set:

```text
has_achieved_full_mastery = true
```

This deck-level flag is persistent.

The first time this occurs, show a salient **non-blocking** achievement notification.

If the deck later drops from 500/500 to 499/500, do not clear the flag.

## 25.2 Card-level historical mastery

Each card has:

```text
has_ever_been_mastered
```

This flag controls the short restoration route.

### Never-mastered card after long-term failure

```text
RELEARNING complete -> ACQUIRED, pool_status = OUTSIDE
```

Then it must again satisfy first-time long-term mastery requirements. (Pool-membership detail: section 13.1.)

### Previously mastered card after lapse

```text
MASTERED
-> Wrong
-> FORGOTTEN / RELEARNING
-> Repair Correct
-> 5-card minimum gap
-> Spaced Correct
-> MASTERED RESTORED, pool_status = OUTSIDE
```

Do not erase the FSRS lapse history.

The UI state can recover faster because long-term mastery had already been demonstrated historically.

## 25.3 Post-Mastery source set

When a deck is in pure maintenance/free-play state with no new acquisition work, use:

```text
RANDOM_MASTERED
FSRS_DUE
NEAR_DUE
```

### No Due cards

```text
RANDOM_MASTERED  0.80
FSRS_DUE         0.00
NEAR_DUE         0.20
```

### 1–9 Due cards

```text
RANDOM_MASTERED  0.45
FSRS_DUE         0.40
NEAR_DUE         0.15
```

### 10+ Due cards

```text
RANDOM_MASTERED  0.30
FSRS_DUE         0.60
NEAR_DUE         0.10
```

### After Daily Goal, 1–9 Due

```text
RANDOM_MASTERED  0.55
FSRS_DUE         0.25
NEAR_DUE         0.20
```

### After Daily Goal, 10+ Due

Keep:

```text
0.30 / 0.60 / 0.10
```

### Repair/Spaced Confirmation servicing in pure Post-Mastery mode (Approved Clarification 3)

Pure Post-Mastery mode (this section's three-source set) has **no**
`ACTIVE` weighted source to service a target-reached repair or a due
Spaced Confirmation through (section 19.2's tier 2/3 assume an ACTIVE
source exists). A target-reached Repair or a due Spaced Confirmation
can still legitimately arise in Post-Mastery mode (e.g. a
previously-mastered card lapses, section 25.2). These are therefore
serviced through the **pre-draw Post-Mastery relearning tier** — i.e.
checked and serviced before the ordinary `RANDOM_MASTERED`/`FSRS_DUE`/
`NEAR_DUE` weighted draw runs, the same way the repair hard cap and
Critical Due interrupts (section 22/23) are checked before the
ordinary-mode weighted draw. The repair hard cap remains a true global
interrupt in Post-Mastery mode exactly as in ordinary mode (section 3
of this document's clarifications).

## 25.4 Random Mastered sampling

Do not use independent sampling with replacement.

Use a **shuffle bag**:

1. gather eligible strong Mastered cards;
2. shuffle;
3. consume without replacement where practical;
4. reshuffle after broad coverage;
5. Due / Near-Due / repair interrupts may interleave.

## 25.5 New cards added after Full Mastery — implementation normalization

The design requires that newly added cards can enter acquisition while the deck-level Post-Mastery unlock persists.

To avoid an undefined four-source hybrid in v1:

- keep `has_achieved_full_mastery = true`;
- if the deck contains any newly added cards that require ordinary Active acquisition, temporarily use the **ordinary Learning Mode source policy** for Active / Due / Near-Due;
- preserve all Post-Mastery presentation state and card-level `has_ever_been_mastered` history;
- once no ordinary acquisition cards remain, return to the Post-Mastery source policy.

This is a specification-level normalization of the design-paper edge case; it does not change memory-state semantics.

---

# 26. Daily Goal and Streak

## 26.1 Daily Goal

```text
5 enemy defeats per Asia/Tokyo calendar day
```

Daily Goal is displayed in enemy units, not card-count units.

There is no separate streak-minimum threshold in v1. Daily Goal completion
IS streak-day qualification -- not two thresholds that happen to share the
same number:

- a day counts toward the streak only when the Daily Goal (5 enemy
  defeats) is completed;
- on the first transition that day from `enemies_defeated < 5` to
  `enemies_defeated >= 5`, Daily Goal becomes complete AND the streak day
  is earned, in the same instant -- exactly once;
- defeating 1-4 enemies does not earn, preserve, or increment the streak
  for that day;
- defeating 6, 7, 8... enemies later that same day does not increment the
  streak a second time -- Daily Goal is already complete;
- starting another Session on the same day must not reset Daily Goal
  progress, and must not increment the streak again if it was already
  earned that day.

## 26.2 No hard stop

On 5th enemy defeat:

- mark Daily Goal complete;
- earn the streak day (exactly once);
- show brief non-blocking feedback;
- apply post-goal scheduler overlay;
- continue the session immediately.

Do not show a modal requiring the user to continue. Daily Goal completion
does not end the Session.

## 26.3 Enemy defeat is not a fixed learning-volume unit

Do not force:

```text
1 enemy = N cards
```

Enemy HP, player damage, world progression, criticals, combo bonuses, etc. may vary.

The Learning Engine guarantees card quality; the Battle Engine controls defeat pacing.

---

# 27. Onboarding parameter mapping

Onboarding is a **weak preference prior**, not a cognitive test.

Do not change core learning rules from self-report unless explicitly listed below.

## 27.1 `primary_goal`

### `deadline_exam`

Core v1 memory rules: unchanged.

Behavior:

- mark user as exam-oriented;
- enable optional deadline-aware planning if `exam_date` is later supplied.

`exam_date` MUST be optional.

```text
exam_date = null
```

must never break the program or scheduler.

If date becomes available, a higher-level planning layer MAY use:

- remaining days;
- remaining cards;
- current mastery;
- estimated review load;
- recommended Daily Goal / workload.

Removing the date must safely return to normal planning.

### `habit`

Core memory rules: unchanged.

UX may emphasize:

- streak;
- Daily Goal feedback;
- proximity to next enemy / goal.

### `interest`

Core memory rules: unchanged in v1.

UX may emphasize exploration and variety.

## 27.2 `pain_point`

### `retention_loss`

Set:

```text
desired_retention = 0.92
```

instead of 0.90.

Do not change Active size or Fresh Limit from this answer alone.

### `creation_cost`

No Learning Engine parameter change.

Prioritize authoring/import/AI/preset UX elsewhere.

### `boredom`

No Learning Engine parameter change in v1.

Increase presentation/game variety elsewhere instead of changing memory rules prematurely.

---

# 28. Deck Progress and Mastered display

These are separate metrics.

## 28.1 Mastered

Display as absolute count, e.g.:

```text
127 Mastered
```

or:

```text
127 / 500 Mastered
```

Mastered is not permanent and may decrease after lapse.

## 28.2 Deck Progress

Deck Progress is a weighted process percentage.

Provisional v1 contribution per card:

```text
NEW              0.00
FRESH            0.10
LEARNING_1       0.30
LEARNING_2       0.50
ACQUIRED         0.70
LEARNED/MASTERED 1.00
FORGOTTEN        0.50  # provisional UX value
```

Compute:

```text
Deck Progress = sum(card_progress_value) / total_cards
```

These numbers do **not** represent recall probabilities.

A lapse may reduce Deck Progress. That is allowed.

---

# 29. Data model requirements

Adapt names to the existing Supabase schema, but preserve these semantics.

## 29.1 Per user-card state

Recommended minimum fields:

```text
user_id
card_id
deck_id

card_status
learning_stage
pool_status
relearning_phase

has_ever_been_mastered

first_presented_at
last_seen_at
last_answer_at

same_day_seen_count
same_day_wrong_count

correct_cooldown_until_position
repair_pending
repair_wrong_position
repair_target_position
repair_hard_cap_position

active_draws_since_eligible

fsrs_d
fsrs_s
fsrs_last_review_at
fsrs_due_at
fsrs_scheduled_interval_sec

fsrs_review_correct_count
fsrs_review_correct_streak

created_at
updated_at
```

`R` may be derived at selection time rather than stored as authoritative state.

## 29.2 Per user-deck state

```text
user_id
deck_id
selected/active relationship as existing schema requires

has_achieved_full_mastery
mastered_count

desired_retention

post_mastery_shuffle_bag_state or deterministic equivalent

policy_version
parameter_set_id
```

## 29.3 User preference state

```text
primary_goal
pain_point
exam_date nullable
```

Do not make `exam_date` non-nullable.

---

# 30. Behavioral event logging

Every answered card should emit a review event rich enough to reconstruct why it appeared.

Minimum fields:

```text
event_id
user_id
deck_id
card_id
session_id
occurred_at
session_position

correct
response_time_ms
time_to_first_action_ms nullable

source
selection_reason
scheduler_mode

daily_goal_complete_before

card_status_before
learning_stage_before
card_status_after
learning_stage_after

has_ever_been_mastered
same_day_seen_count_before
same_day_wrong_count_before
cards_since_last_seen
seconds_since_last_seen

repair_pending_before
is_repair_retry
is_stage_advancing_success

fsrs_d_before
fsrs_s_before
fsrs_r_before
fsrs_d_after
fsrs_s_after
fsrs_r_after

scheduled_interval_sec
interval_progress
days_overdue

fsrs_review_correct_count_before
fsrs_review_correct_streak_before

source_weight_active
source_weight_due
source_weight_near
source_weight_random_mastered nullable

card_priority_weight
candidate_count

policy_version
fsrs_version
parameter_set_id
experiment_assignment_id nullable

selection_trace_id
```

Important: distinguish **observed data** from **policy parameters**.

---

# 31. Session logging

Recommended fields:

```text
session_id
user_id
deck_id
started_at
ended_at
questions_answered
correct_answers
enemies_defeated
daily_goal_completed_at
continued_after_goal
questions_after_goal
seconds_after_goal
voluntary_exit_position
active_pool_start
active_pool_end
due_count_start
due_count_end
repair_events
critical_due_interrupts
active_starvation_guarantees
policy_version
```

---

# 32. Binary input and future personalization

v1 must save raw behavioral data even though only Wrong/Correct is requested.

At minimum preserve:

- correctness;
- response time;
- time to first action;
- historical accuracy;
- time since last seen;
- same-day exposure count;
- repair history;
- current FSRS R/S/D;
- source and selection reason;
- session position;
- Daily Goal state.

Future versions may infer latent `Again / Hard / Good / Easy`-like information or a continuous retrieval-quality score.

Do not implement opaque ML personalization in v1.

---

# 33. Future Continuous Source Weighting

The v1 three-mode source policy is intentionally explainable and discrete.

Long-term roadmap:

```text
rule-based discrete dynamic weighting
    -> beta logging
    -> validation
    -> continuous weighting
    -> personalized continuous weighting
```

Candidate future model inputs:

```text
due_count
R distribution
review urgency
active composition
repair burden
response-time pattern
historical retention
Daily Goal state
session fatigue signals
```

Primary optimization objective must not be engagement alone.

Preferred learning objective:

> **Delayed retained knowledge per minute**

with engagement / continuation as a co-objective and safety guardrails.

---

# 34. Invariants Claude must enforce

The implementation must preserve these invariants.

## 34.1 State invariants

- `LEARNED` implies `has_ever_been_mastered = true`.
- `NEW` may be Active, but becomes `LEARNING` only when first presented.
- `ACQUIRED` is not equivalent to `LEARNED`.
- `FORGOTTEN` is not permanent; it is a relearning state.
- `FORGOTTEN` cards in the Relearning path have `pool_status = ACTIVE`.
- `has_achieved_full_mastery` never becomes false after first unlock.
- New cards added after Full Mastery start with `has_ever_been_mastered = false`.

## 34.2 Scheduling invariants

- no card is normally repeated inside Correct min gap 5;
- no repair appears before 3 intervening cards;
- no repair waits beyond 6 intervening cards;
- Near-Due cards have no starvation guarantee;
- Critical Due safety may preempt ordinary source selection;
- Active starvation is enforced inside the next Active slot after 40 Active draws;
- empty sources are never sampled;
- source weights are re-evaluated every ordinary draw;
- Daily Goal completion never ends a session.

## 34.3 Mastery invariants

First-time Mastery requires:

```text
scheduled FSRS Correct count >= 3
AND
scheduled FSRS Correct streak >= 2
```

Near-Due Correct does not grant mastery count/streak.

Long-term / Near-Due Wrong resets mastery streak to 0 but does not erase cumulative mastery Correct count.

Previously Mastered cards may use short restoration after relearning.

---

# 35. Required edge-case behavior

## 35.1 All sources temporarily unavailable

Possible example:

- all Active cards are cooling down;
- no Due;
- no Near-Due;
- no admissible NEW because Fresh is full.

Do not crash.

Recommended fallback order (exact mechanics: Approved Clarification 7):

1. process any repair/critical safety that becomes eligible;
2. admit NEW only if Fresh capacity exists;
3. wait/advance animation only if the product supports real time between questions;
4. otherwise, relax **only** the ordinary Active Correct cooldown (section 11.1) — and nothing else:
   - **never** relax the repair minimum gap or repair hard cap (section 12.2);
   - **never** relax the Spaced Confirmation minimum gap (section 13);
   - **never** relax any other memory-safety/relearning invariant (section 34);
   - among the ordinary Active cards whose cooldown is being relaxed, choose the one closest to becoming cooldown-eligible on its own (smallest remaining gap to its `correct_cooldown_until_position`); break an exact tie with RNG;
5. never violate a repair hard cap or corrupt state.

Every emergency fallback must emit an invariant log, specifically
setting `emergency_fallback_applied = true` and recording
`selection_reason = emergency_cooldown_relaxation` (the Phase 6/7
implementation's exact field/reason names) for that decision.

## 35.2 Multiple repair collisions

Use:

```text
oldest Wrong / earliest hard cap first
```

Random tie-break for equal priority.

Selection-time-only resolution, and why this differs from legacy SRS
queue-position shifting: section 12.2's "Repair collisions" subsection
(Approved Clarification 6).

## 35.3 Due backlog of hundreds of cards

Do not attempt a “review all Due before Active” mode.

Use Review Pressure:

```text
Active 50 / Due 48 / Near 2
```

plus Critical Due protection.

## 35.4 Full Mastery lapse

At 500/500:

```text
A Wrong
-> 499/500
-> deck remains Post-Mastery unlocked
-> A enters local Relearning
```

Do not reset the entire deck to ordinary first-time state.

## 35.5 Deadline missing

`exam_date = null` must be a normal supported state.

No scheduler path may assume exam date exists.

---

# 36. Recommended implementation modules

Keep responsibilities separated.

```text
learning-engine/
  config/
    policy-v1.ts

  state/
    card-state.ts
    deck-state.ts
    transitions.ts

  active/
    active-pool.ts
    fresh-gating.ts
    active-priority.ts

  repair/
    repair-scheduler.ts
    repair-transitions.ts

  fsrs/
    fsrs-adapter.ts
    long-term-transitions.ts
    near-due.ts

  scheduler/
    next-card.ts
    source-policy.ts
    interrupts.ts
    renormalize.ts
    weighted-random.ts
    post-mastery.ts

  progress/
    deck-progress.ts
    mastery.ts

  telemetry/
    review-events.ts
    selection-trace.ts
    sessions.ts

  tests/
    ...
```

Names may be adapted to the existing Next.js/Supabase project structure.

---

# 37. Implementation order for Claude Code

Do not implement the whole engine in one giant change.

Recommended sequence:

## Phase 1 — enums and schema

Implement / migrate:

- card status;
- learning stages;
- Active/Outside membership;
- FSRS fields;
- mastery flags/counters;
- repair metadata;
- policy versioning.

Add DB constraints where appropriate.

## Phase 2 — pure transition functions

Implement deterministic pure functions for:

- first presentation;
- normal Correct;
- Wrong;
- Repair Correct;
- spaced Correct;
- acquisition graduation;
- qualifying FSRS Correct;
- long-term Wrong;
- short restoration.

Unit test before scheduler work.

## Phase 3 — Active Pool

Implement:

- target 20;
- Fresh limit 6;
- reservoir refill;
- first-encounter pass;
- eligibility / Correct cooldown;
- Active weights / aging.

## Phase 4 — repair scheduler

Implement:

- 3–6 target;
- hard cap;
- collision handling;
- stage-preserving repair behavior.

## Phase 5 — FSRS adapter

Implement:

- binary rating mapping;
- desired retention;
- D/S/R updates;
- Due / Near-Due derivation;
- mastery counters.

## Phase 6 — source scheduler

Implement:

- Dynamic Source Weight modes;
- empty-source renormalization;
- Due formula;
- Near-Due formula;
- Critical Due;
- Active starvation.

## Phase 7 — Post-Mastery

Implement:

- persistent deck unlock;
- shuffle bag;
- short restoration;
- post-mastery source ratios;
- new-card-after-mastery normalization.

## Phase 8 — telemetry

Implement review event, selection trace, and session logging before alpha testing.

## Phase 9 — UI integration

Connect:

- user-facing statuses;
- Deck Progress;
- Mastered absolute count;
- Daily Goal / Streak;
- non-blocking mastery notifications.

## Phase 10 — simulations and acceptance tests

Run deterministic seeded simulations before broad alpha.

---

# 38. Minimum acceptance test suite

Claude must create automated tests for at least the following.

## Test 1 — New deck startup

1000 NEW cards:

```text
Active starts at 6
Fresh = 6
no Pre-Active exists
```

## Test 2 — Fresh throughput

First Correct on one Fresh card:

```text
Fresh decreases by 1
card -> L1
one NEW may enter Active
Fresh returns to <= 6
```

## Test 3 — First Wrong + repair Correct

```text
Fresh Wrong
no retry before 3 intervening cards
retry by 6
repair Correct -> L1
```

## Test 4 — L1 repair does not advance

```text
L1 Wrong
Repair Correct
stage remains L1
```

## Test 5 — Normal progression

```text
Fresh Correct
5+ cards
Correct
5+ cards
Correct
-> ACQUIRED
```

## Test 6 — Correct cooldown

No normal appearance during the next 5 cards after a normal Correct.

## Test 7 — Dynamic source modes

Verify exact nominal weights for:

- Due 0;
- Due 1–9;
- Due >= 10;
- before and after Daily Goal.

## Test 8 — empty source renormalization

Weights always normalize to 1 and never draw an empty source.

## Test 9 — Due weighting

Lower R yields higher Due weight; cap never exceeds 3.0.

## Test 10 — Near-Due boundary

```text
0.7499 -> not Near-Due
0.75   -> Near-Due
0.9999 -> Near-Due
1.0    -> Due
```

## Test 11 — Near-Due Wrong

```text
Near-Due Wrong -> FORGOTTEN / RELEARNING
streak -> 0
count preserved
FSRS Again recorded
```

## Test 12 — Near-Due Correct

FSRS updates, but mastery count/streak do not increment.

## Test 13 — First-time Mastery

Verify:

```text
count=3, streak=1 -> not Mastered
count=2, streak=2 -> not Mastered
count=3, streak=2 -> Mastered
```

## Test 14 — Wrong between long-term successes

Sequence (Approved Clarification 12: this is a sequence of *qualifying
scheduled FSRS long-term review events* for the card, section 15 —
**not** five consecutive global questions; arbitrarily many Active/
repair/Near-Due/Random-Mastered events may occur between them):

```text
Correct, Correct, Wrong, Correct, Correct
```

The `Wrong` above is a qualifying long-term/Near-Due Wrong (section
16.3), so it triggers the real Relearning detour (section 13), not a
same-day repair:

```text
Correct (qualifying)  -> count 1, streak 1
Correct (qualifying)  -> count 2, streak 2
Wrong    (qualifying) -> streak resets to 0, count preserved (2);
                          card_status -> FORGOTTEN, pool_status -> ACTIVE,
                          relearning_phase -> REPAIR_PENDING (section 13.1)
  ... Repair Correct (does not increment count/streak, section 12.3) ...
  ... Spaced Correct (does not increment count/streak, section 13;
      completes relearning -> ACQUIRED or LEARNED, section 13.1) ...
Correct (qualifying, resumes the mastery sequence) -> count 3, streak 1
Correct (qualifying)                                -> count 4, streak 2
```

must end with:

```text
count = 4
streak = 2
Mastered = true
```

## Test 15 — Previously Mastered lapse

```text
MASTERED
-> Wrong
-> Relearning
-> Repair Correct
-> 5-card gap
-> Spaced Correct
-> MASTERED RESTORED
```

## Test 16 — Critical Due

If R <= 0.60 card exists and no critical card appeared in 5 global questions, force critical selection unless a repair hard cap has higher priority.

## Test 17 — Active starvation

An eligible Active card cannot survive more than 40 Active-source draws without selection.

## Test 18 — Full mastery persistence

```text
500/500 -> has_achieved_full_mastery = true
lapse -> 499/500
flag remains true
```

## Test 19 — Random Mastered shuffle bag

Large samples should show broad coverage and materially fewer immediate repeats than independent sampling with replacement.

## Test 20 — Add cards after Full Mastery

New cards:

```text
has_ever_been_mastered = false
```

must enter ordinary acquisition and cannot use short restoration until first true Mastery.

## Test 21 — Daily Goal and Streak

```text
1-4 enemies -> streak not earned
first transition to 5 enemies -> Daily Goal complete, streak earned exactly once
session continues
6+ enemies that same day -> no additional streak increment
```

## Test 22 — null exam date

Exam-oriented user with `exam_date = null` behaves normally without errors.

## Test 23 — progress calculation

Clean path contribution:

```text
0 -> 0.10 -> 0.30 -> 0.50 -> 0.70 -> 1.00
```

## Test 24 — seeded reproducibility

Given identical state + seed, scheduler decision traces are reproducible for debugging.

---

# 39. What is intentionally NOT part of v1

Do not implement these as required Learning Engine behavior yet:

- machine-learned source weighting;
- user-specific FSRS weights trained from insufficient data;
- deck-population FSRS weight optimization;
- personalized Active size;
- personalized Fresh limit;
- fatigue-adaptive scheduling;
- productive/receptive knowledge as separate mastery dimensions;
- AI-generated question types as a scheduler requirement;
- Hard/Good/Easy inference from behavior;
- social ranking effects on scheduler;
- forced card-count Daily Goals.

The architecture must remain compatible with these future extensions.

---

# 40. Future FSRS personalization architecture

The intended long-term hierarchy is:

```text
Global FSRS defaults
    -> Deck-population parameters once sufficient deck data exist
    -> User-personalized parameters once sufficient individual data exist
```

Do not store the 21 FSRS weights on each card.

Store parameter-set references at user/deck/model level as appropriate.

Future model changes must be policy-versioned and reproducible.

---

# 41. Claude Code working instructions

When using this spec for implementation:

1. **Read the existing schema and code first.** Do not create duplicate concepts if equivalent fields already exist.
2. Produce a short implementation plan before modifying code.
3. Work in small phases rather than one huge patch.
4. Keep transition logic pure where possible.
5. Keep the Battle Engine decoupled from memory-state transitions.
6. Add tests with every phase.
7. Build and run type checks after each meaningful phase.
8. Do not change accepted parameter values without explicitly flagging the change.
9. If the current DB security model prevents an update path, use a trusted function / server-side workflow rather than weakening RLS.
10. Emit decision traces so future beta analysis can reconstruct scheduler behavior.

If an ambiguity is discovered that materially changes learning behavior, **stop that portion of implementation and flag the ambiguity instead of inventing a new cognitive rule**.

---

# 42. One-page behavioral summary

The Learning Engine should feel simple to the user even though the backend is stateful:

```text
NEW cards enter gradually.

Wrong?
  Show the answer now.
  Bring the card back in 3–6 cards.

Correct?
  Give it space.
  Do not show it for at least 5 cards.

Three successful within-day retrievals?
  The card becomes ACQUIRED.

After acquisition?
  FSRS controls long-term timing.

Three qualifying long-term successes,
with at least two consecutive?
  MASTERED.

Forget a long-term card?
  RELEARNING.
  Repair it, then prove it once more after spacing.

Due reviews, new learning, and near-due cards
all appear in one continuous battle stream.

Finish 5 enemies?
  Daily Goal complete.
  The game does not stop.

Master the whole deck?
  Celebrate it.
  The game still does not stop.
```

---

# 43. Final design intent

The engine is not intended to be “Anki with a game skin.”

Its defining architecture is the integration of:

- bounded within-day acquisition;
- FSRS-based long-term memory;
- repair after retrieval failure;
- dynamic source mixing;
- controlled randomness;
- hard anti-starvation guarantees;
- reversible mastery;
- post-mastery maintenance;
- low-interaction binary learner input;
- infinite voluntary continuation.

The system should optimize learning quality without presenting the learner with a conventional queue-completion experience.

**The scheduler owns learning priority. The game layer owns motivation and expression. Neither should silently rewrite the other's rules.**

---

# 44. Approved v1 Clarifications

The specification author has approved the following 14 interpretations
as formal v1 rules. Each is now incorporated into its normative section
above (not merely appended here); this section is an index, not an
appendix of competing rules.

1. **Initial first-pass** — finite shuffled snapshot of ACTIVE+NEW+
   never-presented cards, served without replacement; a served card does
   not re-enter ordinary selection until the batch is exhausted; only
   the repair hard cap and Critical Due may preempt it, and resume
   without reshuffling. → section 9.1.
2. **New cards admitted during first-pass** — never appended to a
   running batch; wait for exhaustion, then a new batch (if ≥2
   candidates) or ordinary Active participation (if exactly 1). →
   section 9.2.
3. **Repair target vs. global interrupt** — a reached repair target does
   not force the next global question, only priority at the next Active
   slot; only the repair hard cap is a global interrupt, still above
   Critical Due; pure Post-Mastery mode services target-reached repair/
   due Spaced Confirmation through a pre-draw relearning tier instead
   (no ACTIVE source exists there). → sections 12.2, 25.3.
4. **Active internal priority** — starvation > target-reached Repair >
   due Spaced Confirmation > ordinary weighted Active. → section 19.2.
5. **Multiple Spaced Confirmations** — smallest
   `correct_cooldown_until_position` (earliest-opened gate) wins; RNG
   only for exact ties. → section 19.2.
6. **Repair collisions** — independently sampled positions, never
   mutated/shifted; resolved at selection time only (oldest Wrong/
   earliest hard cap first, RNG for exact ties); explicitly distinct
   from legacy SRS queue-position shifting. → section 12.2.
7. **All-sources-unavailable emergency fallback** — relax ONLY the
   ordinary Active Correct cooldown, never any repair/Spaced-
   Confirmation/safety invariant; choose the closest-to-eligible
   ordinary Active card, RNG only for exact ties; log
   `emergency_fallback_applied`/`emergency_cooldown_relaxation`. →
   section 35.1.
8. **Multiple Active starvation candidates** — greatest
   `active_draws_since_eligible` wins; RNG for exact ties. → section
   22.3.
9. **Active starvation counter semantics** — increment only on a
   legitimate-but-not-selected ordinary Active opportunity; freeze
   during Correct cooldown or repair/relearning governance; reset to 0
   on any actual presentation. → section 22.3.
10. **Scheduler position scope** — `scheduler_position` is per (user,
    deck), monotonic, never reset between Sessions; distinct from the
    Session-local `session_position`; "intervening cards"/"global
    questions" throughout this document mean `scheduler_position`. →
    section 2.1.
11. **Critical Due five-question boundary** — after a forced Critical
    Due at position P, positions P+1..P+5 are not forced again by this
    guarantee; P+6 may force again; a single `last_critical_due_position`
    is sufficient. → section 22.2.
12. **Test 14 semantics** — the Correct/Correct/Wrong/Correct/Correct
    sequence is qualifying scheduled FSRS long-term review events, not
    five consecutive global questions; the Wrong triggers the real
    Relearning detour, whose Repair/Spaced Corrects do not themselves
    count; final result unchanged (count 4, streak 2, Mastered). →
    "Test 14" (section 38).
13. **Long-term/Near-Due Wrong pool membership** — `FORGOTTEN` +
    `pool_status = ACTIVE` (the short-term acquisition/relearning area,
    not long-term FSRS) + `REPAIR_PENDING`; completion returns
    `pool_status = OUTSIDE`, branching to `ACQUIRED` (never mastered) or
    `LEARNED` (previously mastered). → sections 13.1, 16.3, 25.2.
14. **Active admission persistence timing** — the pure scheduler only
    *decides* admissions as part of a trace; a future trusted selection-
    claim transaction *persists* them atomically together with the
    claimed card, `scheduler_position`/`scheduler_revision`, and
    first-pass queue state, validating `scheduler_revision` (or
    equivalent) to reject stale snapshots. Not implemented by this
    clarification pass — see `docs/LEARNING_ENGINE_V1_RUNTIME_CUTOVER_TODO.md`.
    → section 8.4.
