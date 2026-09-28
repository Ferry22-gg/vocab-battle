# MVP Implementation Specification for Claude Code

**Version:** 0.2  
**Status:** Product implementation specification

## 1. Document authority and implementation rule

You are implementing a closed-beta, mobile-first web MVP.

This document is the primary source of truth for:

- product behavior
- UX
- business rules
- learning rules
- battle rules
- beta behavior

`docs/DATABASE_SCHEMA.md` is the primary source of truth for:

- table/column structure
- foreign keys
- indexes
- Row Level Security
- migrations
- transaction boundaries
- idempotency
- database implementation details

If these two documents appear to imply conflicting product behavior:

- do not silently choose one
- stop and surface the conflict before implementation

Do not invent product behavior that conflicts with either document.

When a value is marked **provisional**, keep it configurable in one central configuration module.

Before making a large architectural decision that is not specified, explain the choice and choose the simplest implementation that preserves future extensibility.

Use Git from the beginning.

After each stable milestone:

1. test the feature
2. verify relevant database writes
3. run migrations/build/tests as applicable
4. inspect `git diff`
5. commit with a meaningful message
6. push when the milestone is stable

## 2. Product

Working concept:

**Anki × Duolingo × Notion**

Core MVP idea:

- a mastery engine teaches cards
- FSRS schedules learned cards
- a battle layer gamifies the learning loop
- user-owned decks become the learner's knowledge base

Important product principle:

> The user should experience one simple learning loop even though the internal memory system is complex.

## 3. Platform and stack

Target:

- mobile-first web application
- smartphone browsers first
- desktop browsers second
- English UI
- private closed-beta URL

Preferred stack:

- Next.js
- TypeScript
- Tailwind CSS
- Supabase
- Vercel
- GitHub
- pnpm

Database changes must be implemented with version-controlled Supabase migrations rather than only manual dashboard edits.

Do not implement native iOS or Android apps.

## 4. User roles and authentication

### Tester

Public-facing beta IDs:

`001` through `030`

Each tester receives a unique memorable password.

The user-facing login form asks for:

- User ID
- Password

Keep the user signed in using secure normal session persistence so that they do not need to log in on every visit.

No public sign-up.

No tester email-verification flow.

No tester email password-reset flow during beta.

If a tester forgets a password, admin resets it.

### Admin

Public-facing admin ID:

`999`

Admin uses a separate stronger password.

Admin can access:

`/admin`

Admin must:

- be excluded from beta analytics
- be excluded from leaderboard
- not contaminate learner datasets when previewing/testing the learner UI

Tester accounts must not be able to access `/admin` or another tester's private learning data.

Use Supabase Auth and RLS according to `DATABASE_SCHEMA.md`.

The internal Auth mapping may use an implementation-only identifier, but testers must only see and enter public ID + password.

## 5. First-login flow

On the user's first successful login:

1. choose nickname
2. show a very short tutorial
3. choose one starter deck
4. duplicate the selected starter deck into the user's independent library
5. set the duplicated deck as selected
6. enter Home

Nickname:

- stored separately from tester ID
- shown on leaderboard
- editable later
- case-insensitive uniqueness where practical
- keep validation simple

Do not ask unnecessary onboarding questions such as daily study time or English level.

## 6. Starter decks and duplication

Two official starter deck templates exist.

### Advanced English Vocabulary I

- 100 cards
- front: English
- back: Japanese
- description references approximate TOEFL level

### Advanced English Vocabulary II

- 100 cards
- front: English
- back: Japanese
- description references higher approximate TOEFL level

The supplied CSV files are imported as official template seed data.

### Template -> independent copy model

When the user chooses a starter deck:

1. validate source deck is an allowed official starter template
2. duplicate the selected deck
3. duplicate all 100 cards with new IDs
4. preserve provenance with source deck/card references
5. create one NEW learning-progress row per duplicated card
6. set the duplicated deck as the user's selected deck

The duplicated deck is independent.

User edits must never change:

- the official template
- another user's copy

The unselected official starter deck remains available to add later.

The duplication flow must be transactional and idempotent according to `DATABASE_SCHEMA.md`.

Only the currently selected user-owned deck is used in a session.

Do not mix multiple decks within one session.

## 7. Deck and card ownership

Users may:

- browse their own decks/cards
- add cards
- edit cards
- delete cards from the user's perspective

Users may modify only user-owned deck copies.

Official template decks/cards are read-only to testers.

Normal deletion must preserve historical learning references. Follow the soft-delete behavior in `DATABASE_SCHEMA.md`.

New user-created cards:

- belong to a user-owned deck
- start as `NEW`

MVP manual card fields:

- English front
- Japanese back

Future AI-assisted card creation is out of MVP.

## 8. Card lifecycle

Product statuses:

- NEW
- LEARNING
- LEARNED
- FORGOTTEN

Lifecycle:

`NEW -> LEARNING -> LEARNED <-> FORGOTTEN`

Product `card_status` and internal FSRS state are separate concepts.

When a NEW card is first shown in learning mode:

`NEW -> LEARNING`

### Mastery rule

A learning card becomes LEARNED when:

- `correct_streak >= 4`
- AND `seen_count >= 5`

When a card becomes LEARNED:

- remove it from Active Pool eligibility
- update mastery timestamps
- pass it to retention / FSRS scheduling
- award card-learned XP exactly once for that mastery event

Re-mastery after FORGOTTEN:

- preserves first mastery timestamp
- updates last mastery timestamp
- awards card-relearned XP
- resumes retention using accumulated FSRS history

## 9. Active Pool

MVP uses one learning pool only.

Do not implement:

- Pre-Active Pool
- Outside Pool
- an Active Pool database table
- an `in_active_pool` flag

Active Pool is derived from current user-card state for the selected deck.

Target size:

approximately 30 cards

Eligible statuses:

- FORGOTTEN
- LEARNING
- NEW

Priority:

1. FORGOTTEN
2. existing LEARNING
3. NEW cards as refill

Treat 30 as a target size rather than a hard safety limit if a FORGOTTEN card must be reintroduced.

## 10. Session model

User sees one primary CTA:

**START SESSION**

Do not create a separate Review button.

A session begins when the user starts/resumes learning for one selected deck.

Within the same session:

1. serve the fixed due-review queue for that deck if reviews are due
2. when review is cleared, automatically transition to learning mode
3. continue as an endless battle until user explicitly finishes

The transition from review to learning preserves:

- combo
- current enemy type
- enemy max/current HP
- XP gained in the session
- enemy count
- Daily Goal progress

A brief `Reviews Cleared` effect may be shown.

Do not force a result screen merely because reviews are complete.

## 11. Session interruption and resume

Closing the app does **not** automatically complete the session.

An unfinished session remains active.

On a later app launch, if an active unfinished session exists:

- show previous session summary/state
- offer:
  - Resume
  - Finish

Resume restores:

- current enemy type
- enemy max/current HP
- current combo
- session XP
- enemies defeated in session
- Daily Goal progress
- learning draw index
- persisted review queue state
- persisted learning cooldown/reappearance state

The card that was visible but unanswered when the app closed is **not restored**.

Do not create an answer event for an unanswered card.

Resume draws a fresh next card.

## 12. Review queue

At the start of the review portion:

- determine the due review cards for the selected deck
- fix that queue for the current review portion

Cards that become due after the review portion starts are not added to that same review queue.

For one review card:

### Correct

- mark review item completed

### First Wrong in the same review portion

- internal rating = Again
- increment review wrong count
- move card to back of review queue

### Second Wrong in the same review portion

- increment review wrong count
- `card_status = FORGOTTEN`
- mark review item completed
- card becomes eligible for Learning Active Pool

The review wrong count must survive session interruption/resume.

Preserve all accumulated FSRS history/state.

## 13. Learning draw / cooldown / forced reappearance

Learning draw position is tracked per session.

Review cards do not increment the Learning draw index.

### Correct at Learning draw N

The card cannot appear in the next 10 Learning draws.

Conceptually:

`next_eligible_draw_index = N + 11`

Clear any previous forced-reappearance reservation.

### Wrong at Learning draw N

Choose a random gap:

`6..9`

Schedule:

`forced_reappear_draw_index = N + gap`

If the forced position is already reserved:

- shift the newly scheduled reservation forward until a free position is found

The card cannot be selected again before this (possibly collision-shifted)
final reserved draw, and must be selected at it:

`next_eligible_draw_index = forced_reappear_draw_index` (the same,
collision-shifted final value -- not the pre-shift `N + gap`)

So the reserved draw is both a floor (the earliest eligible draw) and a
guarantee (the draw at which the card must be selected) -- symmetric with
Correct's `next_eligible_draw_index`, except Wrong's floor is a random
draw in `N+6..9` (post-shift) rather than a fixed `N+11`.

This per-session queue state must survive session resume.

This queue/cooldown state is not the same thing as the Active Pool.

## 14. Flashcard interaction

Each card uses a traditional front/back flashcard flow.

1. show front
2. start recall timer
3. user recalls mentally
4. user taps `Show Answer`
5. stop recall timer
6. show back
7. user taps `Correct` or `Wrong`

Important:

`response_time_ms` is measured from front display until `Show Answer`.

Do not include:

- time spent reading the revealed answer
- time spent deciding Correct/Wrong after reveal

## 15. Raw answer event logging

Every answered card creates exactly one append-only answer event.

Client generates:

`client_event_id UUID`

Use it for idempotency.

A retry/double tap with the same `client_event_id` must not process the answer twice.

Preserve raw history.

Do not only store aggregates.

The answer event should capture the exact fields defined in `DATABASE_SCHEMA.md`, including at least:

- user_id
- card_id
- deck_id
- session_id
- answered_at
- correct
- response_time_ms
- session_mode
- card_seen_count_at_answer
- correct_streak_before
- wrong_streak_before
- previous_answer
- card_status_before
- card_status_after
- correct_streak_after
- wrong_streak_after
- time_since_last_seen
- previous_review_interval
- fsrs_rating
- fsrs_due_before
- fsrs_due_after
- base_damage
- speed_bonus
- combo
- damage
- critical
- enemy_hp_before
- enemy_hp_after

Normal answer events are append-only.

Do not update or delete them during ordinary product use.

## 16. Internal FSRS rating estimator

The user never selects:

- Again
- Hard
- Good
- Easy

The app internally estimates one of those ratings.

### Provisional MVP logic

Wrong:

- Again

Correct + very slow recall:

- Hard

Correct + normal recall:

- Good

Correct + fast recall is eligible for Easy only if:

- `seen_count >= 4`
- recent history is stable
- previous answer was not Wrong

If those Easy eligibility conditions are not met:

- Good

Exact response-time thresholds are not finalized.

Create configurable constants for:

- HARD response threshold
- EASY response threshold

Do not scatter thresholds through the codebase.

Future versions will evaluate response speed relative to:

- the specific user's history
- the specific card's history
- possibly the specific user-card pair

## 17. FSRS

Use:

`ts-fsrs`

Initial configuration:

- `request_retention = 0.90`
- `enable_fuzz = true`
- `enable_short_term = true`

FSRS responsibilities:

- update memory state
- compute next review timing

The custom rating estimator is outside FSRS.

Do not rewrite the FSRS algorithm.

Product `card_status` and internal FSRS state remain separate.

When a card becomes FORGOTTEN:

- do not reset accumulated FSRS history/state

After re-mastery:

- continue retention using accumulated FSRS history

## 18. Atomic answer processing

Answer submission is a critical multi-table operation.

Implement it as a trusted atomic operation according to `DATABASE_SCHEMA.md`.

Conceptually one successful answer transaction must include, where applicable:

- validate authenticated active tester
- validate active session and deck/card context
- enforce `client_event_id` idempotency
- capture pre-answer state
- update seen/streak/last-seen state
- apply mastery/FORGOTTEN lifecycle rules
- estimate internal FSRS rating
- update FSRS state/due date
- update review queue or learning queue state
- calculate battle result
- update enemy state / respawn
- insert raw answer event
- update session aggregates
- update daily aggregate state
- insert XP ledger events
- update profile XP / level
- process Daily Goal / streak exactly once if triggered

If any required step fails:

- rollback the entire answer operation

Do not allow partial answer processing.

## 19. Battle system

The learning session is visually a battle.

There are 3 enemy types in MVP.

Enemy differences:

- different appearance
- slightly different HP

Enemy spawn:

- random
- approximately equal probability

Initial HP:

- Enemy A: 90
- Enemy B: 110
- Enemy C: 160

Do not implement:

- elements
- skills
- status effects
- equipment
- enemy abilities

After an enemy is defeated:

- immediately spawn another

Battle is endless until user explicitly finishes the session.

## 20. Damage system

### Correct

Deal damage.

### Wrong

- 0 damage
- combo resets to 0

### Base damage

Random integer:

- minimum 24
- maximum 28

Keep the random range configurable.

### Combo

Consecutive Correct answers increase combo.

Combo cap:

`x10`

Wrong resets combo to 0.

Initial combo damage bonus:

- x1–2: +0
- x3–4: +2
- x5–6: +4
- x7–8: +6
- x9–10: +8

### Speed bonus

Initial maximum:

`+3`

Exact time thresholds remain configurable.

### Critical

Probability:

`5%`

Effect:

`final damage x2`

Critical is random.

Critical must not influence:

- memory rating
- FSRS
- XP directly

Target average:

roughly 3–4 correct answers to defeat one enemy.

## 21. Battle visual feedback

Effects must be short and must not slow the flashcard loop.

Correct:

- damage popup
- enemy hit reaction
- HP bar decrease

Combo:

- persistent combo display
- stronger feedback at x3, x5, x10
- x10 may show `MAX COMBO`

Speed:

- brief `FAST!` indicator when bonus is awarded

Critical:

- strongest visual feedback
- large `CRITICAL!`
- emphasized damage number
- stronger enemy hit reaction
- short screen shake and/or flash
- lightweight particles/hit effect

Prefer lightweight effects suitable for mobile web.

## 22. Daily Goal

Daily Goal:

**Defeat 5 enemies**

Do not display a fixed question quota.

Display progress as enemy defeats.

Example:

`3 / 5 Enemies`

When user defeats the fifth enemy of the current Asia/Tokyo day:

- mark Daily Goal complete
- update streak exactly once
- award Daily Goal XP exactly once
- show a lightweight completion state
- user can choose Continue or Finish

Do not force session end.

Daily Goal processing must be idempotent for each user/JST date.

## 23. Streak

A day counts toward streak only when Daily Goal is completed.

Simply:

- opening the app
- answering one card
- starting a session

must not preserve the streak.

Use:

`Asia/Tokyo`

for MVP day boundaries.

## 24. XP ledger and current XP

Initial values:

- Correct Answer: +2 XP
- Card becomes LEARNED: +15 XP
- FORGOTTEN card becomes LEARNED again: +15 XP
- Enemy Defeated: +20 XP
- Daily Goal Complete: +30 XP

No direct XP for:

- Wrong
- combo
- speed bonus
- critical

Maintain:

- current cumulative XP in profile state
- append-only XP history in XP event ledger

XP generated from an answer must be idempotent.

Do not double-award XP because of network retry/double tap.

Keep every XP value in a central configuration module.

## 25. Level

Initial formula for XP required for next level:

`200 + 50 * (current_level - 1)`

Examples:

- Lv1 -> 2: 200
- Lv2 -> 3: 250
- Lv3 -> 4: 300
- Lv4 -> 5: 350

No MVP level cap is required.

Keep progression constants configurable.

## 26. Leaderboard

Leaderboard metric:

**Enemies Defeated**

Provide:

- Weekly
- All-time

Do not show leaderboard on Home.

Weekly reset boundary:

**Monday 00:00 Asia/Tokyo**

Use competition ranking for ties.

Example:

- #4 User A
- #5 User B
- #5 User C
- #7 User D

Display nickname, not tester ID.

Do not create a dedicated leaderboard table in MVP.

Derive:

- weekly ranking from daily user stats
- all-time ranking from profile lifetime enemy total

Exclude:

- admin
- any account marked excluded from analytics

## 27. Home

Keep Home visually simple.

Use the supplied concept image as layout inspiration, not as pixel-perfect specification.

Initial information hierarchy:

Top:

- avatar
- nickname
- streak
- level
- XP progress

Center:

- character / visual
- large `START SESSION` CTA

Below:

- learning progress
- selected deck
- Daily Goal progress

Bottom navigation:

- Home
- Dictionary
- Stats

Do not overcrowd Home with detailed analytics or leaderboard.

If an unfinished active session exists, Home/entry flow should clearly offer Resume or Finish.

## 28. Dictionary

Support:

- list user-owned cards
- filter by card status
- add card
- edit card
- soft-delete card

Users may add personal cards directly into user-owned deck copies.

New user-created card:

- belongs to selected target user-owned deck
- starts as `NEW`

MVP manual card fields:

- English front
- Japanese back

Future:

- English input
- AI suggests Japanese meanings
- user selects/edits suggestion
- save

Do not implement AI card generation in MVP.

## 29. Stats

Initial Stats sections:

### Study

- Total Study Time
- Total Sessions
- Total Answers

### Knowledge

- Learned
- Learning
- New

### Performance

- Accuracy
- Longest Combo
- Average Response Time

### Battle

- Enemies Defeated
- Critical Hits
- Weekly Rank
- All-time Rank

### Consistency

- Current Streak
- Longest Streak

### Progression

- Level
- Total XP

Do not unnecessarily duplicate derived stats in profile storage if they can be calculated reliably from the database model.

## 30. Admin

Admin route:

`/admin`

Admin-only.

Minimum features:

### Overview

- active users
- total sessions
- total answers
- average study time
- average accuracy

### User list

- tester ID
- nickname
- last active
- sessions
- study time
- answers
- learned cards
- enemies defeated
- level

### User detail

- session history
- answer history
- card progress
- response time
- accuracy
- review behavior

### Export

Provide practical CSV export for beta analysis.

Prioritize data accessibility over fancy admin visuals.

Admin must not have unrestricted arbitrary edit access to append-only raw learner history.

Explicit recovery/admin actions should use designed trusted flows.

Admin preview/testing must not write learner history.

## 31. Analytics data model

Use three conceptual layers:

### Current state

Examples:

- profile state
- user-card progress
- active/completed sessions

### Append-only raw history

Examples:

- answer events
- XP events

### Aggregate/cache

Example:

- daily user stats

Raw history is the authoritative audit trail for beta analysis.

Use Asia/Tokyo for day-based aggregates.

D1 / D3 / D7 return should be based on the user's first real **Start Session** activity, not account creation.

## 32. Beta analytics

Track enough data to compute:

- First Enemy Completion
- D1 Return
- D3 Return
- D7 Return
- Daily Goal Completion Rate
- Post-Goal Continuation Rate
- Session Duration
- Answers per Session
- Review Due Completion Rate
- Accuracy by seen count
- Response time by seen count
- Average exposures until mastery
- Forgotten rate
- Wrong -> next attempt correct rate
- Enemies Defeated
- Longest Combo
- XP gained
- Levels reached

All beta-success analytics must exclude:

- admin accounts
- accounts marked excluded from analytics

## 33. Beta structure

### Alpha

- 5 users
- 3–5 days
- objective: bugs, usability, data integrity

### Closed Beta

- about 30 users
- about 14 days
- expected natural use: roughly 5–15 minutes/day

Do not design the beta around forced daily usage.

The product should measure voluntary return.

Primary success signals:

1. users voluntarily return over multiple days
2. meaningful percentage continue after Daily Goal is complete
3. accuracy improves as cards are seen more often
4. recall time tends to decrease as cards are seen more often
5. no critical learning-data loss
6. qualitative feedback suggests users prefer the battle experience to ordinary flashcards

Do not treat one small-sample metric as a definitive business-success threshold.

## 34. Out of scope

Do not implement in MVP:

- native iOS app
- native Android app
- public registration
- public release
- social network
- friends
- PvP
- community
- deck sharing
- creator economy
- marketplace
- bosses
- rare enemies
- monster collection
- equipment
- items
- in-game currency
- shop
- hearts / energy system
- complex character system
- advanced AI analysis
- ML personalization
- AI-assisted card creation
- complex Notion-style databases
- production tags/tag filtering

## 35. Central configuration requirement

Create central configuration for all tunable game/learning constants, including at least:

- ACTIVE_POOL_TARGET_SIZE
- HARD_RESPONSE_THRESHOLD_MS
- EASY_RESPONSE_THRESHOLD_MS
- ENEMY_HP values
- BASE_DAMAGE_MIN
- BASE_DAMAGE_MAX
- COMBO_CAP
- COMBO_BONUS tiers
- SPEED_BONUS values
- CRITICAL_RATE
- CRITICAL_MULTIPLIER
- DAILY_GOAL_ENEMIES
- XP_CORRECT
- XP_CARD_LEARNED
- XP_CARD_RELEARNED
- XP_ENEMY_DEFEATED
- XP_DAILY_GOAL
- LEVEL_BASE_XP
- LEVEL_XP_INCREMENT
- FSRS request retention / relevant settings

Do not scatter these constants through components.

## 36. Database implementation expectations

Read and follow:

`docs/DATABASE_SCHEMA.md`

before implementing persistence.

Requirements include:

- UUID primary keys
- profiles linked to Supabase Auth
- RLS on application tables
- soft delete for decks/cards
- append-only answer events
- append-only XP events
- daily aggregate table
- no dedicated Active Pool table
- no dedicated leaderboard table
- no deck-cards join table for MVP
- official template -> full duplicate -> independent user copy
- trusted transactional starter duplication
- trusted atomic answer submission
- answer idempotency
- Daily Goal idempotency
- admin analytics exclusion
- efficient due-review / Active Pool indexes

Do not re-invent a conflicting schema in application code.

## 37. Implementation order

Implement incrementally.

Suggested order:

1. Project setup
2. Git repository hygiene / `.env.example`
3. Read and validate `DATABASE_SCHEMA.md`
4. Supabase migrations: core tables
5. RLS and helper functions
6. Authentication / tester-admin roles
7. Official starter deck seed import
8. Transactional starter-deck duplication
9. First-login nickname / onboarding flow
10. Deck selection
11. Dictionary / card CRUD with soft deletion
12. Session create/resume/finish
13. Review queue persistence
14. Learning queue persistence
15. Raw answer event + idempotent atomic `submit_answer`
16. Active Pool selection logic
17. Mastery / FORGOTTEN lifecycle logic
18. FSRS integration
19. Review -> learning seamless flow
20. Basic battle HP/damage
21. Combo
22. Speed bonus
23. Critical
24. Daily Goal / streak
25. XP ledger / level
26. Stats
27. Leaderboard
28. Admin dashboard / CSV export
29. Mobile polish
30. Alpha QA / data-integrity tests

After each stable milestone:

- run migrations
- verify schema
- verify RLS
- verify relevant writes
- run build/tests
- inspect diff
- commit

## 38. Acceptance criteria

A tester can:

1. open the private web app
2. log in with assigned ID/password
3. stay signed in across normal return visits
4. choose nickname on first login
5. choose an official starter deck
6. receive one independent user-owned deck copy
7. receive 100 independent card copies and NEW learning-progress records
8. see Home
9. tap Start Session
10. complete due reviews from the selected deck if any
11. seamlessly continue into learning cards
12. recall a front card
13. reveal the Japanese answer
14. mark Correct or Wrong
15. create one correct append-only raw answer event
16. safely retry an answer without double-processing it
17. damage enemy on Correct
18. reset combo and deal zero damage on Wrong
19. experience combo/speed/critical effects
20. defeat enemies and spawn new ones
21. complete Daily Goal at 5 enemies
22. avoid duplicate Daily Goal XP/streak awards
23. continue after Daily Goal if desired
24. earn XP and levels without duplicate awards
25. earn streak only after Daily Goal
26. progress cards through NEW/LEARNING/LEARNED/FORGOTTEN correctly
27. receive FSRS review dates
28. return a twice-failed review card to FORGOTTEN without deleting its FSRS history
29. enforce correct Learning cooldown / forced reappearance
30. close the app mid-session and later Resume with battle/queue state preserved
31. avoid creating an answer event for a card that was visible but unanswered at close
32. add/edit/soft-delete cards inside a user-owned deck
33. never alter the official template when editing a user copy
34. view Stats
35. view weekly and all-time leaderboard
36. prevent a tester from reading another tester's private data
37. exclude admin/test-excluded accounts from analytics and leaderboard
38. allow admin to inspect tester data and export useful CSV data

## 39. Important design principle

The user should not need to think about:

- review scheduling
- FSRS
- Again/Hard/Good/Easy
- multiple session types
- queue mechanics
- Active Pool implementation

The intended experience is:

> Choose a deck, press Start Session, fight enemies, and let the app decide what you should study next.

The complex memory, queue, transaction, and analytics systems should remain mostly invisible behind a simple game loop.
