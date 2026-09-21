# MVP Implementation Specification for Claude Code

## 1. Role and instruction

You are implementing a closed-beta, mobile-first web MVP.

Treat this document as the primary product specification.

Do not invent product behavior that conflicts with this document.

When a requirement is marked **provisional**, keep the relevant values configurable in one central configuration module.

Before making a large architectural decision that is not specified here, explain the choice and choose the simplest implementation that preserves future extensibility.

Use Git from the beginning. Make small, meaningful commits after stable milestones.

## 2. Product

Working concept:

**Anki × Duolingo × Notion**

Core MVP idea:

- a mastery engine teaches cards
- FSRS schedules learned cards
- a battle layer gamifies the learning loop
- decks act as the user's knowledge base

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

Do not implement native iOS or Android apps.

## 4. User roles

### Tester
Public-facing beta IDs:

`001` through `030`

Each tester receives a unique memorable password.

The user-facing login form should ask for:

- User ID
- Password

Keep the user signed in using normal secure session persistence so that they do not need to log in on every visit.

### Admin
Public-facing admin ID:

`999`

Admin uses a separate stronger password.

Admin can access `/admin`.

Tester accounts must not be able to access `/admin` or another tester's private learning data.

Use Supabase Auth and Row Level Security.

The exact internal mapping between simple public IDs and Supabase Auth may be chosen during implementation, but public UX must remain ID + password.

## 5. First-login flow

On the user's first successful login:

1. Choose nickname
2. Show a very short tutorial
3. Choose starter deck
4. Enter Home

Nickname:
- stored separately from tester ID
- shown on leaderboard
- editable later
- keep validation simple
- avoid duplicate nicknames if practical

Do not ask unnecessary onboarding questions such as daily study time or English level.

## 6. Starter decks

Two starter decks exist.

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

The supplied CSV files should be imported as seed data.

Only the currently selected deck is used in a session.

Do not mix multiple decks inside a session.

## 7. Card lifecycle

Statuses:

- NEW
- LEARNING
- LEARNED
- FORGOTTEN

Lifecycle:

`NEW -> LEARNING -> LEARNED <-> FORGOTTEN`

When a NEW card is first shown in learning mode:

`NEW -> LEARNING`

### Mastery rule

A learning card becomes LEARNED when:

- `correct_streak >= 4`
- AND `seen_count >= 5`

When a card becomes LEARNED:
- remove it from Active Pool
- pass it to the retention/FSRS system

## 8. Active Pool

MVP uses only one learning pool.

Do not implement Pre-Active Pool.

Do not implement Outside Pool.

Active Pool target size:

approximately 30 cards

Eligible statuses:

- NEW
- LEARNING
- FORGOTTEN

Priority:
1. FORGOTTEN
2. existing LEARNING cards
3. NEW cards as refill

Treat 30 as a target size rather than a dangerous hard constraint if a FORGOTTEN card must be reintroduced.

## 9. Session architecture

User sees only one primary CTA:

**START SESSION**

Do not create a separate Review button.

Session behavior for currently selected deck:

1. If selected deck has due review cards, serve them first.
2. When all due reviews are cleared, automatically transition into learning cards from the same deck.
3. Continue as an endless battle until user chooses to stop.

The transition from review to learning must preserve:
- combo
- current enemy
- enemy HP
- XP/session state

Optionally show a brief:
`Reviews Cleared`

Do not force a result screen merely because review cards are finished.

## 10. Flashcard interaction

Each card uses a traditional front/back flashcard flow.

1. Show front
2. Start recall timer
3. User recalls mentally
4. User taps `Show Answer`
5. Stop recall timer
6. Show back
7. User taps `Correct` or `Wrong`

Important:

`response_time_ms` is measured from front display until `Show Answer`.

Do not include the time spent reading the revealed answer or choosing Correct/Wrong.

## 11. Raw answer event logging

Every answered card should create a raw event.

Store at least:

- event id
- user_id
- card_id
- deck_id
- session_id
- answered_at
- correct
- response_time_ms
- card_seen_count_at_answer
- correct_streak_before
- wrong_streak_before
- previous_answer if available
- card_status_before
- session_mode (`review` or `learning`)
- damage
- combo
- critical
- time_since_last_seen
- previous_review_interval where applicable

Preserve raw history. Do not only store aggregates.

## 12. Internal FSRS rating estimator

The user never selects:
- Again
- Hard
- Good
- Easy

The app internally estimates one of those ratings.

### Provisional MVP logic

Wrong:
- `Again`

Correct + very slow recall:
- `Hard`

Correct + normal recall:
- `Good`

Correct + fast recall:
- eligible for `Easy` only if:
  - `seen_count >= 4`
  - recent history is stable
  - previous answer was not Wrong

If those Easy eligibility conditions are not met:
- use `Good`

Exact response-time thresholds are not finalized.

Create configurable constants for:
- HARD response threshold
- EASY response threshold

Do not bury these values throughout the codebase.

Future versions will evaluate response speed relative to the specific user's historical behavior and possibly the specific user-card pair.

## 13. FSRS

Use `ts-fsrs`.

Initial configuration:

- `request_retention = 0.90`
- `enable_fuzz = true`
- `enable_short_term = true`

FSRS responsibilities:

- update memory state
- compute next review timing

The custom rating estimator is outside FSRS.

Do not rewrite the FSRS algorithm.

## 14. Review failure / FORGOTTEN

Within the review portion of one session:

First Wrong on a LEARNED review card:
- rate as Again
- reinsert the card later in that same review flow

Second Wrong on the same card during that review portion:
- `card_status = FORGOTTEN`
- move card back to Active Pool
- preserve previous FSRS history/state

Do not reset FSRS state/history.

After the FORGOTTEN card satisfies the mastery rule again:
- set `card_status = LEARNED`
- resume retention scheduling using the accumulated FSRS history

## 15. Battle system

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
- Enemy B: 105
- Enemy C: 120

Do not implement:
- elements
- skills
- status effects
- equipment
- enemy abilities

After an enemy is defeated:
- immediately spawn another

Battle is endless until user exits.

## 16. Damage system

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

## 17. Battle visual feedback

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

Prefer lightweight CSS/animation-library effects suitable for mobile web.

## 18. Daily Goal

Daily Goal:

**Defeat 5 enemies**

Do not display a fixed question quota.

Display progress as enemy defeats.

Example:
`3 / 5 Enemies`

When user defeats the fifth enemy:
- Daily Goal becomes complete
- streak is updated
- award Daily Goal XP
- show a lightweight completion state
- user can choose Continue or Finish

Do not force session end.

## 19. Streak

A day counts toward streak only when Daily Goal is completed.

Simply:
- opening the app
- answering one card
- starting a session

must not preserve the streak.

Use `Asia/Tokyo` day boundaries for MVP.

## 20. XP

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

Keep every XP value in a central configuration file/module.

## 21. Level

Initial formula for XP required for next level:

`200 + 50 * (current_level - 1)`

Examples:

- Lv1 -> 2: 200
- Lv2 -> 3: 250
- Lv3 -> 4: 300
- Lv4 -> 5: 350

No MVP level cap is required.

Keep progression constants configurable.

## 22. Leaderboard

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

## 23. Home

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

## 24. Dictionary

Support:
- list cards
- filter by card status
- add card
- edit card
- delete card

Users may add personal cards directly into existing decks.

New user-created card:
- belongs to selected target deck
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

## 25. Stats

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

## 26. Admin

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

## 27. Beta analytics

Track enough raw events to compute:

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

## 28. Beta structure

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

## 29. Out of scope

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

## 30. Central configuration requirement

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
- XP_ENEMY_DEFEATED
- XP_DAILY_GOAL
- LEVEL_BASE_XP
- LEVEL_XP_INCREMENT

Do not scatter these constants through components.

## 31. Implementation order

Implement incrementally.

Suggested order:

1. Project setup
2. Git repository hygiene / env example
3. Supabase schema
4. Authentication / tester/admin roles
5. First-login nickname flow
6. Starter deck seed import
7. Deck selection
8. Dictionary / card CRUD
9. Raw answer event logging
10. Basic flashcard session
11. Active Pool logic
12. Mastery logic
13. FSRS integration
14. Review -> learning seamless flow
15. Basic battle HP/damage
16. Combo
17. Speed bonus
18. Critical
19. Daily Goal / streak
20. XP / level
21. Stats
22. Leaderboard
23. Admin dashboard / CSV export
24. Mobile polish
25. Alpha QA

After each stable milestone:
- test the feature
- verify database writes
- commit to Git

## 32. Acceptance criteria

A tester can:

1. Open the private web app
2. Log in with assigned ID/password
3. Stay signed in across normal return visits
4. Choose nickname on first login
5. Choose a starter deck
6. See Home
7. Tap Start Session
8. Complete due reviews from selected deck if any
9. Seamlessly continue into learning cards
10. Recall a front card
11. Reveal the Japanese answer
12. Mark Correct or Wrong
13. Generate correct raw answer-event data
14. Damage enemy on Correct
15. Reset combo and deal zero damage on Wrong
16. Experience combo/speed/critical effects
17. Defeat enemies and spawn new ones
18. Complete Daily Goal at 5 enemies
19. Continue after Daily Goal if desired
20. Earn XP and levels
21. Earn streak only after Daily Goal
22. Progress cards through NEW/LEARNING/LEARNED/FORGOTTEN correctly
23. Receive FSRS review dates
24. Return a twice-failed review card to FORGOTTEN without deleting its FSRS history
25. Add/edit/delete cards inside an existing deck
26. View Stats
27. View weekly and all-time leaderboard
28. Admin can inspect tester data and export useful CSV data

## 33. Important design principle

The user should not need to think about:

- review scheduling
- FSRS
- Again/Hard/Good/Easy
- multiple session types

The intended experience is:

> Choose a deck, press Start Session, fight enemies, and let the app decide what you should study next.

The complex memory system should remain mostly invisible behind a simple game loop.
