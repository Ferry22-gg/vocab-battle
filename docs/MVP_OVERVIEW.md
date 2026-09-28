# MVP Overview

**Version:** 0.2  
**Status:** Human-facing MVP overview

## Product concept

**Anki × Duolingo × Notion**

A mobile-first learning product that combines:

- **Anki:** memory and spaced repetition
- **Duolingo:** engagement and game-like motivation
- **Notion:** accumulation of a personal knowledge base

The MVP focuses on one core question:

> Can flashcard learning become easier to continue when the learning loop itself is turned into a lightweight battle game, while the app automatically manages what to learn and when to review?

## What the user experiences

1. Log in to the closed beta.
2. Choose a nickname.
3. Choose one of two official starter decks.
4. The selected starter deck is copied into the user's own independent library.
5. Tap **Start Session**.
6. If cards from the selected deck are due for review, they appear first.
7. Reviews flow directly into new/learning cards from that same deck.
8. Each card appears as a standard front/back flashcard.
9. The user recalls the answer, reveals it, then taps **Correct** or **Wrong**.
10. Correct answers damage an enemy.
11. Combo, speed bonus, and occasional critical hits add game feedback.
12. Defeating an enemy immediately spawns another.
13. The daily goal is to defeat **5 enemies**.
14. After the goal is completed, the user can stop or continue.
15. The user builds XP, levels, streaks, stats, and leaderboard rank over time.
16. If the app is closed mid-session, the unfinished session can be resumed later.

The user should not need to think about review scheduling, FSRS settings, or separate session types. The intended experience is simply:

> Choose a deck, press **Start Session**, fight enemies, and let the app decide what should be studied next.

## Learning model

The MVP separates two ideas:

### Mastery

The app first helps users learn a card well enough to consider it learned.

A card moves:

`NEW → LEARNING → LEARNED ↔ FORGOTTEN`

Current mastery rule:

- correct streak ≥ 4
- seen count ≥ 5

The MVP uses a single **Active Pool** of roughly 30 cards.

Priority:

1. FORGOTTEN
2. existing LEARNING
3. NEW cards as refill

### Retention

Once learned, the card is scheduled with **FSRS**.

The user never chooses Anki-style **Again / Hard / Good / Easy** directly.

Instead, the user only chooses:

- Correct
- Wrong

The app estimates the internal FSRS rating from behavior such as:

- recall time
- seen count
- recent answer history
- correct streak
- previous mistakes

The MVP begins with simple configurable rules. Future versions can personalize this based on each user's relative response speed and history.

If a learned card is answered incorrectly twice within the review portion of one session, it becomes **FORGOTTEN** and returns to active learning. Its accumulated FSRS history is preserved.

## Battle system

Three enemy types are used in the MVP.

Initial balance:

- Enemy A: 90 HP
- Enemy B: 110 HP
- Enemy C: 160 HP
- Base damage: random 24–28
- Combo cap: x10
- Critical chance: 5%
- Critical damage: x2

The target experience is roughly **3–4 correct answers per enemy**, without making the exact number predictable.

Visual feedback is intentionally strongest for critical hits.

## Daily motivation

Daily Goal:

> **Defeat 5 enemies**

The app does not display a fixed question quota.

A streak continues only after the daily goal is completed.

Users can continue battling after the goal.

## XP and levels

Initial XP model:

- Correct answer: +2 XP
- Card learned: +15 XP
- Card re-learned: +15 XP
- Enemy defeated: +20 XP
- Daily goal completed: +30 XP

Levels become gradually harder:

`XP to next level = 200 + 50 × (current level - 1)`

These numbers are provisional and will be adjusted from beta data.

## Decks and knowledge ownership

Initial starter content:

### Advanced English Vocabulary I
- 100 cards
- English → Japanese
- Approximate TOEFL level shown in the description

### Advanced English Vocabulary II
- 100 cards
- English → Japanese
- Higher approximate TOEFL level shown in the description

When a user selects a starter deck, the app creates an **independent personal copy** of that deck and its cards.

This means:

- official starter content remains unchanged
- each user owns their own copy
- the user may add, edit, and delete cards in their copy
- changes never affect other users or the official source deck

Only the currently selected deck is used in a session.

Multiple decks are **not mixed** within one session.

## Main screens

### Home

Kept visually simple.

Initial layout direction:

- avatar / nickname
- streak
- level + XP
- character visual
- large **Start Session** button
- learning progress
- selected deck
- daily goal progress
- bottom navigation: Home / Dictionary / Stats

### Dictionary

- browse cards
- filter by status
- add/edit/delete cards in user-owned decks
- view learning state

### Stats

Includes:

- study time
- total sessions
- total answers
- learned / learning / new
- accuracy
- average response time
- longest combo
- enemies defeated
- critical hits
- current / longest streak
- level / XP
- weekly / all-time rank

## Session continuity

A session begins when the user presses **Start Session** and ends only when explicitly completed or timed out by defined product logic.

If the app is closed mid-session:

- the session remains resumable
- enemy state, combo, XP, and daily-goal progress are preserved
- the unanswered card that was on screen is not restored
- resuming draws a fresh next card

## Leaderboard

Metric:

**Enemies Defeated**

Two views:

- Weekly
- All-time

Weekly ranking resets every **Monday at 00:00 Asia/Tokyo**.

Ties use competition ranking:

`5th, 5th, 7th`

Users are displayed by nickname.

## Closed beta

### Alpha

- 5 users
- 3–5 days
- Goal: find bugs, usability failures, and data-integrity issues

### Beta

- About 30 users
- About 14 days
- Typical use expected around 5–15 minutes/day
- Users should be encouraged to use naturally rather than being forced to use it every day

Important signals:

- first enemy completion
- D1 / D3 / D7 return
- daily goal completion
- continuation after daily goal
- session duration
- review completion
- accuracy improvement with repeated exposure
- recall-time improvement with repeated exposure
- qualitative preference over ordinary flashcards

Admin/test accounts are excluded from beta-success analysis.

## Technical direction

- Mobile-first web application
- English UI
- GitHub from the beginning
- Claude Code for implementation support
- Supabase for database/authentication
- Vercel for deployment
- Version-controlled Supabase migrations
- Admin account for beta analysis
- Raw answer-event logging from day one
- CSV export for later analysis

Data is intentionally separated into:

- current learning state
- append-only raw history
- aggregate/cache data

This keeps beta analysis reliable while preserving room for future personalization.

## Not in the MVP

- native iOS / Android apps
- public release
- SNS/community
- friends/PvP
- marketplace / creator economy
- monster collection
- equipment/items/currency/shop
- bosses/rare enemies
- advanced AI analysis
- personalized machine learning
- AI-assisted card creation
- complex Notion-like database features

Those belong to later stages after the core learning + engagement hypothesis is validated.
