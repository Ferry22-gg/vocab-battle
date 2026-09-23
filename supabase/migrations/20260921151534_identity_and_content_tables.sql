-- Identity/content tables: profiles, decks, cards.
-- Source of truth: docs/DATABASE_SCHEMA.md sections 4.1-4.3.
--
-- Scope for this migration only: tables, constraints, foreign keys,
-- indexes, and updated_at triggers. No RLS, no grants, no seed data,
-- no learning/session tables, no database transaction functions.
--
-- Cyclic FK note: profiles.selected_deck_id -> decks.id and
-- decks.owner_user_id -> profiles.id form a cycle. Resolved by creating
-- profiles first with selected_deck_id left unconstrained, then decks
-- (which can safely reference profiles), then adding the deferred
-- profiles -> decks foreign key at the end via ALTER TABLE.

-- =========================================================================
-- profiles
-- =========================================================================

create table public.profiles (
  id uuid primary key,
  public_user_id text not null unique,
  role text not null default 'tester'
    check (role in ('tester', 'admin')),
  account_status text not null default 'active'
    check (account_status in ('active', 'disabled')),
  exclude_from_analytics boolean not null default false,
  nickname text,
  onboarding_completed boolean not null default false,
  -- References decks.id, added later via ALTER TABLE once that table exists.
  selected_deck_id uuid,
  total_xp integer not null default 0
    check (total_xp >= 0),
  level integer not null default 1
    check (level >= 1),
  current_streak integer not null default 0
    check (current_streak >= 0),
  longest_streak integer not null default 0
    check (longest_streak >= 0),
  total_enemies_defeated integer not null default 0
    check (total_enemies_defeated >= 0),
  last_daily_goal_completed_on date,
  first_active_at timestamptz,
  last_active_at timestamptz,
  disabled_at timestamptz,
  disabled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Not specified explicitly in DATABASE_SCHEMA.md. ON DELETE RESTRICT is
  -- used because the account lifecycle intentionally preserves profiles and
  -- learner history via account_status = 'disabled' rather than deletion;
  -- an auth.users deletion must not cascade into the application profile.
  constraint profiles_id_fkey foreign key (id)
    references auth.users (id) on delete restrict
);

-- Case-insensitive nickname uniqueness without the citext extension.
create unique index profiles_nickname_lower_idx
  on public.profiles (lower(nickname))
  where nickname is not null;

create trigger set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- =========================================================================
-- decks
-- =========================================================================

create table public.decks (
  id uuid primary key default gen_random_uuid(),
  name text not null
    check (length(trim(name)) > 0),
  description text,
  front_language text not null,
  back_language text not null,
  owner_user_id uuid
    references public.profiles (id) on delete restrict,
  source_deck_id uuid
    references public.decks (id) on delete set null,
  is_template boolean not null default false,
  is_official boolean not null default false,
  visibility text not null default 'private'
    check (visibility in ('private', 'unlisted', 'public')),
  sort_order integer not null default 0
    check (sort_order >= 0),
  archived_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at
  before update on public.decks
  for each row
  execute function public.set_updated_at();

-- Deferred half of the cyclic relationship noted above.
alter table public.profiles
  add constraint profiles_selected_deck_id_fkey
  foreign key (selected_deck_id)
  references public.decks (id) on delete set null;

-- =========================================================================
-- cards
-- =========================================================================

create table public.cards (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null
    references public.decks (id) on delete restrict,
  front text not null
    check (length(trim(front)) > 0),
  back text not null
    check (length(trim(back)) > 0),
  extra_content jsonb not null default '{}'::jsonb,
  created_by_user_id uuid
    references public.profiles (id) on delete restrict,
  source_card_id uuid
    references public.cards (id) on delete set null,
  sort_order integer not null default 0
    check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Indexes per DATABASE_SCHEMA.md section 8.
create index cards_deck_id_deleted_at_idx
  on public.cards (deck_id, deleted_at);

create index cards_deck_id_sort_order_idx
  on public.cards (deck_id, sort_order);

create trigger set_updated_at
  before update on public.cards
  for each row
  execute function public.set_updated_at();
