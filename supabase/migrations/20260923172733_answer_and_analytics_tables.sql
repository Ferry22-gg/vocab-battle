-- Answer/analytics tables: answer_events, daily_user_stats, xp_events.
-- Source of truth: docs/DATABASE_SCHEMA.md sections 4.8-4.10.
--
-- Scope for this migration only: tables, constraints, foreign keys,
-- indexes, and updated_at trigger where specified. No RLS, no grants,
-- no seed data, no database transaction functions.
--
-- Append-only tables per DATABASE_SCHEMA.md 2.3: answer_events and
-- xp_events get no updated_at column/trigger. daily_user_stats is a
-- mutable aggregate/cache table and does get one.
--
-- FK delete-behavior convention (continued from the previous migration):
-- RESTRICT on references to durable rows (profiles/cards/decks/sessions)
-- from answer_events, since it is the authoritative raw audit trail and
-- must never be silently orphaned/cascaded away. xp_events uses
-- ON DELETE SET NULL on its optional session/card/source-answer-event/
-- performed-by references, matching DATABASE_SCHEMA.md 4.10 exactly --
-- the XP ledger row itself must survive even if the thing it references
-- is later removed.

-- =========================================================================
-- answer_events
-- =========================================================================

create table public.answer_events (
  id uuid primary key default gen_random_uuid(),
  client_event_id uuid not null unique,
  user_id uuid not null
    references public.profiles (id) on delete restrict,
  card_id uuid not null
    references public.cards (id) on delete restrict,
  deck_id uuid not null
    references public.decks (id) on delete restrict,
  session_id uuid not null
    references public.sessions (id) on delete restrict,
  answered_at timestamptz not null default now(),
  correct boolean not null,
  response_time_ms integer not null
    check (response_time_ms >= 0),
  session_mode text not null
    check (session_mode in ('review', 'learning')),
  card_seen_count_at_answer integer not null
    check (card_seen_count_at_answer >= 0),
  correct_streak_before integer not null
    check (correct_streak_before >= 0),
  wrong_streak_before integer not null
    check (wrong_streak_before >= 0),
  previous_answer boolean,
  card_status_before text not null
    check (card_status_before in ('NEW', 'LEARNING', 'LEARNED', 'FORGOTTEN')),
  time_since_last_seen bigint,
  previous_review_interval integer,
  card_status_after text not null
    check (card_status_after in ('NEW', 'LEARNING', 'LEARNED', 'FORGOTTEN')),
  correct_streak_after integer not null
    check (correct_streak_after >= 0),
  wrong_streak_after integer not null
    check (wrong_streak_after >= 0),
  fsrs_rating text
    check (fsrs_rating is null or fsrs_rating in ('Again', 'Hard', 'Good', 'Easy')),
  fsrs_due_before timestamptz,
  fsrs_due_after timestamptz,
  base_damage integer not null default 0
    check (base_damage >= 0),
  speed_bonus integer not null default 0
    check (speed_bonus >= 0),
  combo integer not null default 0
    check (combo >= 0),
  damage integer not null default 0
    check (damage >= 0),
  critical boolean not null default false,
  enemy_hp_before integer,
  enemy_hp_after integer,
  created_at timestamptz not null default now()
);

-- Indexes per DATABASE_SCHEMA.md section 8. The UNIQUE constraint on
-- client_event_id already provides an index for that lookup.
create index answer_events_user_id_answered_at_idx
  on public.answer_events (user_id, answered_at);

create index answer_events_session_id_answered_at_idx
  on public.answer_events (session_id, answered_at);

-- =========================================================================
-- daily_user_stats
-- =========================================================================

create table public.daily_user_stats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references public.profiles (id) on delete restrict,
  stat_date date not null,
  first_activity_at timestamptz,
  last_activity_at timestamptz,
  active_duration_sec integer not null default 0
    check (active_duration_sec >= 0),
  session_count integer not null default 0
    check (session_count >= 0),
  total_answers integer not null default 0
    check (total_answers >= 0),
  correct_answers integer not null default 0
    check (correct_answers >= 0),
  wrong_answers integer not null default 0
    check (wrong_answers >= 0),
  cards_mastered integer not null default 0
    check (cards_mastered >= 0),
  cards_forgotten integer not null default 0
    check (cards_forgotten >= 0),
  reviews_due integer not null default 0
    check (reviews_due >= 0),
  reviews_completed integer not null default 0
    check (reviews_completed >= 0),
  enemies_defeated integer not null default 0
    check (enemies_defeated >= 0),
  critical_hits integer not null default 0
    check (critical_hits >= 0),
  longest_combo integer not null default 0
    check (longest_combo >= 0),
  -- May be negative: an admin adjustment can produce a net negative daily
  -- change (DATABASE_SCHEMA.md 4.9), so this intentionally has no >= 0 check.
  xp_gained integer not null default 0,
  daily_goal_completed boolean not null default false,
  daily_goal_completed_at timestamptz,
  continued_after_daily_goal boolean not null default false,
  post_goal_answers integer not null default 0
    check (post_goal_answers >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_user_stats_user_id_stat_date_key unique (user_id, stat_date)
);

create trigger set_updated_at
  before update on public.daily_user_stats
  for each row
  execute function public.set_updated_at();

-- =========================================================================
-- xp_events
-- =========================================================================

create table public.xp_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references public.profiles (id) on delete restrict,
  session_id uuid
    references public.sessions (id) on delete set null,
  card_id uuid
    references public.cards (id) on delete set null,
  source_answer_event_id uuid
    references public.answer_events (id) on delete set null,
  amount integer not null,
  reason text not null
    check (reason in (
      'correct_answer',
      'card_learned',
      'card_relearned',
      'enemy_defeated',
      'daily_goal_completed',
      'admin_adjustment'
    )),
  performed_by_user_id uuid
    references public.profiles (id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  -- Idempotency guard (DATABASE_SCHEMA.md 4.10 / 10.3): at most one XP
  -- event per (answer event, reason). Postgres allows multiple NULLs here,
  -- which is intended -- non-answer-based admin adjustments are unconstrained.
  constraint xp_events_source_answer_event_id_reason_key unique (source_answer_event_id, reason)
);
