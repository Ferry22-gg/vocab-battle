# Vocab Battle

Vocab Battle is a vocabulary-learning web app that turns flashcard study into a lightweight battle game. It aims to combine effective memorization (spaced repetition), motivation and engagement (game-like feedback), and flexible vocabulary learning (your own independent deck library).

> **Status: Alpha / MVP.** This is an experimental, invite-only closed beta under active development. Expect rough edges.

## Why I Built This

The idea came from my own language-learning experience. Existing tools tend to optimize for one thing:

- some are strong at **memorization** but feel dry,
- some are strong at **engagement** but are weaker at long-term retention,
- some are **flexible** but expect you to design the whole learning process yourself.

Vocab Battle tries to combine **spaced repetition**, **game-like learning**, and **custom vocabulary decks** so that you only have to choose a deck and press Start; the app decides what to study next.

## Current Features

Implemented in the repository today:

- **Invite-only authentication:** ID + password login, with account roles (tester / admin) and disabled-account handling.
- **Onboarding:** choose a nickname, then pick a starter deck.
- **Starter decks:** three official decks (two English TOEFL-level decks with Japanese meanings, and one Swahili basics deck). Selecting one copies it into your own independent library.
- **Study session with a battle loop:** front/back flashcards where you reveal the answer and mark it Correct or Wrong. Correct answers damage an enemy, with combo, speed bonus and critical-hit feedback. Defeated enemies are replaced by new ones, and unfinished sessions can be resumed.
- **Spaced-repetition scheduling:** FSRS-based card scheduling (via `ts-fsrs`) plus a custom learning engine that manages new, learning, review and mastered cards.
- **Progress tracking:** XP, levels, daily goal, streaks, and per-deck mastery progress with mastery notifications.
- **Decks screen:** per-deck and per-card status, and switching between your decks.
- **Stats screen:** today's activity, weekly activity, lifetime stats, personal bests and learning progress.
- **Mobile-first UI** with reduced-motion support.
- **Tests:** unit, database integration, SQL-level, and end-to-end (Playwright) suites.

Not yet available in the UI: building custom decks or adding your own cards, a leaderboard, and an admin area (the admin page is a placeholder).

## Tech Stack

- **Frontend / app:** Next.js (App Router, Server Components and Server Actions), React, TypeScript, Tailwind CSS
- **Backend / data:** Supabase (Auth and PostgreSQL), accessed through `@supabase/ssr` and `@supabase/supabase-js`
- **Scheduling:** `ts-fsrs`
- **Testing:** Vitest, Playwright, SQL tests run against local Supabase
- **Tooling:** pnpm, ESLint
- **Deployment:** Vercel

## Architecture & Security

- **Server-side auth and authorization.** Every protected page and Server Action goes through a central data-access layer that verifies the user's JWT on the server and loads their role and account status. The middleware-level check is only an optimistic redirect, never the real gate. The acting user is never taken from client input.
- **Row Level Security.** RLS is enabled on all application tables. Users can only read and write their own rows, and direct writes are limited to a small allow-listed set of columns and tables.
- **Privileged operations are separate from client code.** Core state changes (committing an answer, claiming the next card, XP, streaks) run in `SECURITY DEFINER` Postgres functions that are only executable by the `service_role`. The service-role client is `server-only` and is guarded against accidental use against a remote project during local development.
- **Idempotent, transactional writes.** Answer submission is idempotent via client event IDs and runs in a single database transaction, so retries do not double-count.
- **No secrets in the repository.** Environment files are git-ignored, and `.env.example` documents variable names only. The only `NEXT_PUBLIC_` variables are the Supabase URL and the publishable key, which are designed to be public and are protected by RLS.

## Product Development Approach

In an earlier AI-development project, I learned that designing an ideal solution too early, before validating technical feasibility or real user needs, creates unnecessary complexity. For Vocab Battle I try to:

1. Define the core user problem.
2. Narrow the MVP scope.
3. Identify technical risks early.
4. Get feedback from external engineers.
5. Build and iterate in smaller steps.

## What I'm Exploring

- **Spaced repetition and the learning engine:** the scheduling logic is actively being reworked (the current branch is a second-generation engine), including how new cards are introduced and how mistakes are repaired.
- **Session performance:** reducing server round trips and perceived latency between cards.
- **Engagement and retention:** how much game feedback helps without distracting from recall.
- **Future work (not implemented):** custom deck and card creation in the UI, a leaderboard, an admin area, more worlds and enemies, personalized learning, and richer learning analytics.

## AI-Assisted Development

I use AI coding tools (including Claude Code) as part of my workflow for implementation support, debugging, code review and documentation. Some specs and notes in `docs/` were written to guide those tools.

I remain responsible for the product requirements, architecture decisions, feature prioritization, testing and validation, and the final implementation decisions. AI is a development tool here, not a replacement for understanding or ownership of the code.

Some visual assets used in this prototype were generated using AI image-generation tools.

## About the Developer

I'm a student at Waseda University in the School of International Liberal Studies. My interests include data science, statistics, game theory and mechanism design, business, and product development. I have experience in data science-related internships and in international B2B sales.

## Status

Vocab Battle is under active development and should be considered an experimental MVP / alpha product. Features, data models and the learning engine may change without notice.

## Running Locally

Requires Node.js, pnpm and the Supabase CLI.

```bash
pnpm install
pnpm exec supabase start          # local Postgres + Auth
cp .env.example .env.local        # fill in values from `pnpm exec supabase status`
pnpm dev
```

Tests: `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e` (the integration and end-to-end suites only run against a local Supabase instance).
