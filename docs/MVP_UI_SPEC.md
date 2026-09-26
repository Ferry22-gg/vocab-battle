# Vocab Battle — MVP UI Specification

**Status:** v0.1 Draft  
**Scope:** Closed Beta UI / interaction specification  
**Primary principle:** Mobile-First, Zero-Cognitive-Load  
**Visual direction:** Clean Fantasy = Notion-like clarity + Duolingo-like playfulness

---

## 1. Purpose of this document

This document defines the **MVP UI/UX direction for the Closed Beta**.

It is intentionally narrower than the long-term product vision.

The long-term vision may later include:
- richer RPG/game systems
- monster collection
- avatar equipment
- events
- social systems
- UGC / deck marketplace
- creator monetization
- institutional distribution

Those future concepts must **not** be treated as current MVP implementation requirements unless explicitly moved into this document.

Backend/database/Learning Engine specifications remain authoritative for data and business logic.  
This document defines **presentation, interaction, and user flow**.

---

## 2. Product UX principles

### 2.1 Mobile-First

The primary target is a smartphone vertical layout.

Desktop/web responsiveness should remain possible, but mobile usability takes priority.

### 2.2 Zero-Cognitive-Load

The user should not need to decide what to do before studying.

The product should strongly optimize for:

> Open app → continue learning immediately.

Avoid unnecessary choices, modal interruptions, and decision-heavy navigation.

### 2.3 Learning flow must not be blocked by game feedback

Game feedback should make studying more rewarding, but must not slow down the learning loop.

Examples of non-blocking feedback:
- damage numbers
- enemy HP animation
- combo changes
- critical hit feedback
- XP gain
- Daily Goal completion
- level-up notification

Whenever possible, feedback may continue visually while the next card becomes available.

---

## 3. Visual direction — “Clean Fantasy”

### 3.1 Base UI

The application shell should feel:
- clean
- structured
- calm
- modern
- information-efficient
- easy to scan

Reference direction:
- Notion-like spacing and hierarchy
- clear typography
- restrained card surfaces
- moderate rounded corners
- sufficient whitespace

### 3.2 Game layer

Game-specific areas may be more expressive:
- enemy illustrations
- HP bars
- combo
- critical hits
- XP feedback
- lightweight fantasy iconography

The visual style should be:
- flat / illustrated
- playful
- approachable
- slightly fantasy/game-like

Avoid:
- realistic 3D RPG visuals
- visually heavy fantasy interfaces
- excessive particle effects
- dense HUDs that compete with the learning content

### 3.3 Design scalability

Use reusable components and design tokens so the visual skin can evolve later without changing the Learning Engine.

The MVP visual identity is **not the final art direction**.

---

## 4. MVP navigation architecture

Primary sections:

- **Home**
- **Decks**
- **Session**
- **Stats**

The Session entry point is the most important action in the application.

The navigation should make starting or resuming study require minimal thought and minimal taps.

A center-emphasized Session action in the bottom navigation is an approved design direction.

Exact layout and visual styling remain open to iteration.

---

## 5. Home screen — MVP intent

The Home screen should primarily answer:

1. What should I do now?
2. How am I doing today?
3. What am I currently studying?

The screen should remain visually simple.

### Required MVP concepts

- clear Session Start / Resume entry
- current selected deck
- Daily Goal progress
- basic progression feedback such as Streak and/or Level
- current study workload where useful

### Intentionally not finalized yet

The exact Home metrics and hierarchy are still under design.

Do **not** assume all of the following belong in the MVP:
- Coins
- competitive Rank
- retained/mastered-card count
- avatar systems
- detailed XP breakdown
- multiple simultaneous status widgets

These may be added later after visual prototyping and Beta feedback.

---

## 6. Session screen — core MVP interaction

This is the highest-priority UX in the product.

### 6.1 Core answer loop

Each card follows this sequence:

1. Show the **front** of the card.
   - MVP learning direction: English → Japanese.
2. The user thinks of the meaning.
3. When the user believes they know the answer, they trigger **Reveal / Flip**.
4. The Japanese meaning is shown.
5. The user compares the revealed answer with what they recalled.
6. The user self-grades:
   - **Wrong**
   - **Correct**
7. Battle / XP / combo feedback is displayed without blocking the learning flow.
8. The next card becomes available immediately or as quickly as practical.

Conceptually:

```text
English term
    ↓
Think
    ↓
Reveal / Flip
    ↓
Japanese meaning
    ↓
Wrong / Correct
    ↓
Battle feedback
    ↓
Next card
```

### 6.2 Reveal interaction

Reveal represents:

> “I have finished trying to recall this card.”

The exact interaction may be:
- tapping the card
- tapping a Reveal button
- another obvious single action

The exact gesture is not yet locked, but Reveal must be extremely clear and low-friction.

### 6.3 Self-grading

Correct/Wrong is selected **after Reveal**.

The self-grade is intentionally separate from recall time.

The user is expected to inspect the revealed answer before grading themselves.

---

## 7. Response-time measurement

`response_time_ms` measures recall difficulty.

### Start

Start timing when:
- the next card front is fully presented, and
- the user can begin recalling it.

### Stop

Stop timing **at the moment Reveal is triggered**.

Therefore:

```text
Card ready
│
│  ← response_time_ms
│
Reveal
│
│  not included
│
Read meaning
│
Correct / Wrong
```

Time spent:
- reading the revealed answer
- comparing the answer
- deciding whether to press Correct or Wrong

must **not** affect `response_time_ms`.

This is important because the Learning Engine uses response time for internal rating inference and speed-related battle feedback.

### Background/inactive time

How app-background / hidden-tab time should affect the timer is not yet locked in this UI spec.

Do not invent behavior without separate approval.

---

## 8. Session lifecycle

### 8.1 Sessions are intentionally open-ended

The MVP Session has no mandatory question count or enemy-count stopping point.

A user may continue studying indefinitely.

The application should not force the user out of a study flow merely because a milestone has been reached.

### 8.2 Exit means pause

In the normal MVP flow:

> Exit Session = leave the battle screen and return to the app, while preserving the active session.

It is **not** treated as destructive completion.

### 8.3 Resume by default

When an active session already exists:

> SESSION START should resume that session by default.

The user should not normally be asked:

- “Start new?”
- “Resume?”
- “Continue previous session?”

The product should make the obvious choice automatically.

Conceptually:

```text
SESSION START
    ↓
Study
    ↓
Exit
    ↓
Home
    ↓
SESSION START
    ↓
Resume previous active session
```

This behavior aligns with the existing `start_or_resume_session()` architecture.

### 8.4 Explicit session completion

A separate explicit “finish session permanently” UX is not currently a primary MVP requirement.

Do not introduce one unless later approved.

---

## 9. Daily Goal behavior

The current Daily Goal remains part of the MVP progression system.

Reaching the Daily Goal must **not end or pause the Session**.

When completed, use lightweight non-blocking feedback such as:
- small toast
- edge notification
- compact overlay
- temporary badge animation

Example concept:

```text
✓ Daily Goal Complete
5 / 5 enemies
```

The notification should disappear automatically and must not require a confirmation tap before learning continues.

The same principle applies to:
- level-up
- streak update
- XP gain
- enemy defeat
- combo milestones

Celebration is encouraged; interruption is not.

---

## 10. Battle presentation — MVP

The battle layer should support the learning loop, not dominate it.

The Session UI may show:

- current enemy
- enemy HP
- current word/card
- combo
- lightweight damage feedback
- critical feedback
- XP feedback

The exact layout is not finalized.

### MVP principle

The word/card remains the primary cognitive object.

Enemy art, HP, effects, and HUD must never make the learning content harder to read or slower to operate.

---

## 11. Decks screen — MVP

The MVP Decks screen should focus on:

- current selected deck
- available starter/user decks
- selecting the active deck
- basic deck information

A Spotify-like mental model is acceptable:
- one currently active/selected deck
- other decks available in a library-like list

### Not MVP requirements yet

Do not implement as part of the current Beta solely because they exist in the long-term vision:

- public deck marketplace
- paid decks
- creator profiles
- verified creator badges
- password-protected publishing
- monetization
- ratings/reviews
- institutional storefronts

The architecture should avoid blocking these future directions, but the UI does not need them now.

---

## 12. Stats screen — MVP

Stats should remain lightweight in the first Beta.

The exact metrics are not yet finalized.

Likely candidates include:
- Streak
- Level / XP
- recent study activity
- Daily Goal history
- card-learning progress

Do not invent a large analytics dashboard before Beta feedback.

---

## 13. Future-facing concepts — not current implementation scope

The following may be part of the long-term product vision but are **not current MVP UI requirements**:

- Monster collection / encyclopedia
- Avatar customization
- Equipment
- Skills
- World map
- Guilds
- social feed
- seasonal events
- Night Owl / time-linked events
- shareable profile cards
- Coins / premium currencies
- Deck Store
- UGC marketplace
- creator monetization
- university / school creator accounts
- paid knowledge distribution

They should not be implemented unless separately approved.

---

## 14. Intentionally unresolved UI decisions

The following are intentionally left open so they can be decided through prototypes and Beta feedback:

- exact Home information hierarchy
- whether Rank exists separately from Level
- whether Coins appear in MVP
- exact definition/display of “Mastered” cards
- exact fonts
- exact color palette
- exact spacing scale
- exact animation durations
- exact enemy illustration style
- card-flip visual treatment
- tap vs. other Reveal gesture
- swipe gestures
- exact Battle HUD arrangement
- detailed Stats metrics
- full Session summary UX
- app-background timing behavior for `response_time_ms`

Claude or another implementation agent must not silently convert these into permanent product decisions.

Use simple, replaceable defaults when implementation requires a temporary presentation.

---

## 15. Implementation guidance for Claude

When implementing MVP UI:

1. Treat this document as the current UI/UX source of truth.
2. Do not pull Future concepts into the MVP without explicit approval.
3. Preserve existing backend/database/Learning Engine behavior.
4. Prefer reusable components and design tokens over one-off styling.
5. Optimize for mobile vertical screens first.
6. Keep the learning loop extremely fast.
7. Do not add blocking celebration/result screens between normal answers.
8. Do not invent product-level metrics, currencies, or progression systems.
9. When a UI detail is unresolved, use the smallest reversible implementation.
10. Stop and report if a UI requirement conflicts with an existing backend invariant.

---

## 16. MVP Session UX summary

The core interaction can be summarized as:

> **Think → Reveal → Self-grade → Instant feedback → Next**

And the Session philosophy as:

> **Start instantly. Continue indefinitely. Exit without losing progress. Resume without deciding. Celebrate without interrupting.**
