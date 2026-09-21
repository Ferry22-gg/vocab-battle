# MVP Overview

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
3. Choose one of two starter decks.
4. Tap **Start Session**.
5. If cards are due for review, they appear first.
6. Reviews flow directly into new/learning cards from the same selected deck.
7. Each card appears as a standard front/back flashcard.
8. The user recalls the answer, reveals it, then taps **Correct** or **Wrong**.
9. Correct answers damage an enemy.
10. Combo, speed bonus, and occasional critical hits add game feedback.
11. Defeating an enemy immediately spawns another.
12. The daily goal is to defeat **5 enemies**.
13. After the goal is completed, the user can stop or continue.
14. The user builds XP, levels, streaks, stats, and leaderboard rank over time.

## Learning model

The MVP separates two ideas:

### Mastery
The app first helps users learn a card well enough to consider it learned.

A card moves:

`NEW → LEARNING → LEARNED ↔ FORGOTTEN`

Current mastery rule:

- correct streak ≥ 4
- seen count ≥ 5

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

The MVP begins with simple rules. Future versions can personalize this based on each user's relative response speed and history.

## Battle system

Three enemy types are used in the MVP.

Initial balance:

- Enemy A: 90 HP
- Enemy B: 105 HP
- Enemy C: 120 HP
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
- Enemy defeated: +20 XP
- Daily goal completed: +30 XP

Levels become gradually harder:

`XP to next level = 200 + 50 × (current level - 1)`

These numbers are provisional and will be adjusted from beta data.

## Decks

Initial starter content:

### Advanced English Vocabulary I
- 100 cards
- English → Japanese
- Approximate TOEFL level shown in the description

### Advanced English Vocabulary II
- 100 cards
- English → Japanese
- Higher approximate TOEFL level shown in the description

Only the currently selected deck is used in a session.

Multiple decks are **not mixed**.

Users can also add, edit, and delete their own cards inside existing decks.

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
- add/edit/delete cards
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

## Leaderboard

Metric:

**Enemies Defeated**

Two views:

- Weekly
- All-time

Weekly ranking resets every **Monday at 00:00 JST**.

Ties use competition ranking:

`5th, 5th, 7th`

Users are displayed by nickname.

## Closed beta

### Alpha
- 5 users
- 3–5 days
- Goal: find bugs and usability failures

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

## Technical direction

- Mobile-first web application
- English UI
- GitHub from the beginning
- Claude Code for implementation support
- Supabase for database/authentication
- Vercel for deployment
- Admin account for beta analysis
- Raw answer-event logging from day one

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

Those belong to later stages after the core learning + engagement hypothesis is validated.
