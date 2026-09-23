-- Learning/session tables: user_card_progress, sessions,
-- session_review_cards, session_learning_queue.
-- Source of truth: docs/DATABASE_SCHEMA.md sections 4.4-4.7.
--
-- Scope for this migration only: tables, constraints, foreign keys,
-- indexes, and updated_at triggers. No RLS, no grants, no seed data,
-- no answer_events/daily_user_stats/xp_events, no database transaction
-- functions.
--
-- FK delete-behavior convention followed throughout: RESTRICT on every
-- reference to profiles/cards/decks (durable, never auto-deleted rows);
-- CASCADE only on session_id references from the two per-session queue
-- tables, since those rows are temporary state owned entirely by their
-- parent session and have no meaning once it is gone.

-- =========================================================================
-- user_card_progress
-- =========================================================================

create table public.user_card_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references public.profiles (id) on delete restrict,
  card_id uuid not null
    references public.cards (id) on delete restrict,
  card_status text not null default 'NEW'
    check (card_status in ('NEW', 'LEARNING', 'LEARNED', 'FORGOTTEN')),
  seen_count integer not null default 0
    check (seen_count >= 0),
  correct_streak integer not null default 0
    check (correct_streak >= 0),
  wrong_streak integer not null default 0
    check (wrong_streak >= 0),
  last_seen_at timestamptz,
  last_answer_correct boolean,
  first_mastered_at timestamptz,
  last_mastered_at timestamptz,
  fsrs_due_at timestamptz,
  fsrs_stability double precision,
  fsrs_difficulty double precision,
  fsrs_elapsed_days integer not null default 0
    check (fsrs_elapsed_days >= 0),
  fsrs_scheduled_days integer not null default 0
    check (fsrs_scheduled_days >= 0),
  fsrs_reps integer not null default 0
    check (fsrs_reps >= 0),
  fsrs_lapses integer not null default 0
    check (fsrs_lapses >= 0),
  fsrs_learning_steps integer not null default 0
    check (fsrs_learning_steps >= 0),
  fsrs_state integer,
  fsrs_last_review_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_card_progress_user_id_card_id_key unique (user_id, card_id)
);

-- Indexes per DATABASE_SCHEMA.md section 8: Active Pool + due-review lookups.
create index user_card_progress_user_id_card_status_idx
  on public.user_card_progress (user_id, card_status);

create index user_card_progress_user_id_fsrs_due_at_idx
  on public.user_card_progress (user_id, fsrs_due_at);

create trigger set_updated_at
  before update on public.user_card_progress
  for each row
  execute function public.set_updated_at();

-- =========================================================================
-- sessions
-- =========================================================================

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references public.profiles (id) on delete restrict,
  deck_id uuid not null
    references public.decks (id) on delete restrict,
  status text not null default 'active'
    check (status in ('active', 'completed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  last_active_at timestamptz not null default now(),
  active_duration_sec integer not null default 0
    check (active_duration_sec >= 0),
  resume_count integer not null default 0
    check (resume_count >= 0),
  end_reason text
    check (end_reason is null or end_reason in ('user_finished', 'timeout', 'error')),
  current_mode text not null
    check (current_mode in ('review', 'learning')),
  started_with_reviews boolean not null default false,
  reviews_completed_at timestamptz,
  learning_draw_index integer not null default 0
    check (learning_draw_index >= 0),
  current_enemy_type text,
  current_enemy_max_hp integer
    check (current_enemy_max_hp is null or current_enemy_max_hp >= 0),
  current_enemy_hp integer
    check (current_enemy_hp is null or current_enemy_hp >= 0),
  current_combo integer not null default 0
    check (current_combo >= 0),
  total_answers integer not null default 0
    check (total_answers >= 0),
  correct_answers integer not null default 0
    check (correct_answers >= 0),
  wrong_answers integer not null default 0
    check (wrong_answers >= 0),
  enemies_defeated integer not null default 0
    check (enemies_defeated >= 0),
  longest_combo integer not null default 0
    check (longest_combo >= 0),
  critical_hits integer not null default 0
    check (critical_hits >= 0),
  xp_gained integer not null default 0
    check (xp_gained >= 0),
  daily_goal_progress integer not null default 0
    check (daily_goal_progress >= 0),
  daily_goal_completed boolean not null default false,
  continued_after_daily_goal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexes per DATABASE_SCHEMA.md section 8: resume/active-session lookups.
create index sessions_user_id_status_idx
  on public.sessions (user_id, status);

create index sessions_user_id_last_active_at_idx
  on public.sessions (user_id, last_active_at);

create trigger set_updated_at
  before update on public.sessions
  for each row
  execute function public.set_updated_at();

-- =========================================================================
-- session_review_cards
-- =========================================================================

create table public.session_review_cards (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null
    references public.sessions (id) on delete cascade,
  card_id uuid not null
    references public.cards (id) on delete restrict,
  queue_order integer not null
    check (queue_order >= 0),
  wrong_count integer not null default 0
    check (wrong_count >= 0),
  completed boolean not null default false,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_review_cards_session_id_card_id_key unique (session_id, card_id)
);

create trigger set_updated_at
  before update on public.session_review_cards
  for each row
  execute function public.set_updated_at();

-- =========================================================================
-- session_learning_queue
-- =========================================================================

create table public.session_learning_queue (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null
    references public.sessions (id) on delete cascade,
  card_id uuid not null
    references public.cards (id) on delete restrict,
  last_draw_index integer
    check (last_draw_index is null or last_draw_index >= 0),
  next_eligible_draw_index integer
    check (next_eligible_draw_index is null or next_eligible_draw_index >= 0),
  forced_reappear_draw_index integer
    check (forced_reappear_draw_index is null or forced_reappear_draw_index >= 0),
  times_shown_in_session integer not null default 0
    check (times_shown_in_session >= 0),
  last_result text
    check (last_result is null or last_result in ('correct', 'wrong')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_learning_queue_session_id_card_id_key unique (session_id, card_id)
);

create trigger set_updated_at
  before update on public.session_learning_queue
  for each row
  execute function public.set_updated_at();
