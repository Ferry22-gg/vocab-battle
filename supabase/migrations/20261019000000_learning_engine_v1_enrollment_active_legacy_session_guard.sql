-- Learning Engine v1 -- pre-RC-E corrective migration: close the
-- enrollment-time race between an active legacy Session and rollout
-- admission.
--
-- Forward-only. Does not edit, rewrite, or reinterpret
-- 20261017000000_learning_engine_v1_runtime_cutover_rc_d.sql (already
-- applied) -- every other branch of admit_user_to_learning_engine_v1() is
-- left completely untouched. This migration CREATE OR REPLACEs it in
-- place (same signature -- no new parameter, no new column) to add
-- exactly one new validation step, the same corrective-migration pattern
-- 20261014000000_learning_engine_v1_runtime_cutover_rc_c_rollout_guard.sql
-- already used for commit_learning_engine_v1_answer().
--
-- ---------------------------------------------------------------------
-- The gap (pre-RC-E safety audit finding, confirmed)
-- ---------------------------------------------------------------------
-- user_card_progress is shared mutable state between the legacy and v1
-- runtimes. lib/learning-engine/cutover/enroll.ts's
-- enrollUserInLearningEngineV1() normalizes a user's existing
-- user_card_progress rows into v1-shaped state (learning_stage/
-- pool_status/relearning_phase/repair_*) BEFORE calling this function to
-- admit them to rollout. If that user has an ACTIVE session pinned to
-- engine_version = 'legacy' (sessions.engine_version, set once at
-- creation by start_or_resume_session() and never re-evaluated on
-- resume), that session can go on committing further legacy answers via
-- commit_answer_transaction() -- which updates card_status but has no
-- knowledge of, and never maintains, the v1-only fields normalization
-- just wrote. The result is a user_card_progress row whose card_status
-- and v1-shaped fields describe two different moments in time: exactly
-- the "mixed legacy/v1 state" the approved plan's "eligible for v1" must
-- imply "safe for chooseNextCard() right now" principle (this migration's
-- own RC-D predecessor, 20261017000000's header) cannot tolerate.
--
-- enroll.ts now checks this itself before ever calling
-- runLearningEngineV1CutoverNormalization() (TypeScript-side guard, same
-- migration set). This migration closes the remaining race window: a
-- legacy session that starts (or is still starting, under
-- start_or_resume_session()'s own profile-row lock) AFTER enroll.ts's
-- check already passed but BEFORE this function's own transaction
-- commits. Locking the same profiles row start_or_resume_session() locks
-- (same FOR UPDATE pattern, same deadlock-avoidance ordering: profile
-- first, nothing else) serializes the two functions against each other --
-- whichever acquires the lock first forces the other to wait until it
-- commits, so admission and legacy-session-creation can never interleave
-- for the same user.
--
-- ---------------------------------------------------------------------
-- The fix
-- ---------------------------------------------------------------------
-- Lock the target profile row FOR UPDATE (as part of, not instead of, the
-- existing active-tester-account check below), then reject (42501) if an
-- ACTIVE, engine_version = 'legacy' session exists for this user. Never
-- auto-finishes that session -- the caller (enroll.ts) surfaces this as a
-- clear error requiring the existing Session to end first, exactly the
-- approved plan's preferred invariant. A v1 session is not a concern here
-- (this function's own ON CONFLICT DO NOTHING means it is only ever
-- meaningfully reached for a user with no rollout row yet, and
-- start_or_resume_session() can never assign engine_version = 'v1'
-- without one already existing), so this check is scoped to
-- engine_version = 'legacy' specifically, not "any active session."
create or replace function public.admit_user_to_learning_engine_v1(p_user_id uuid)
returns public.learning_engine_v1_rollout
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.learning_engine_v1_rollout;
  v_active_legacy_session_id uuid;
begin
  if p_user_id is null then
    raise exception 'admit_user_to_learning_engine_v1: p_user_id is required'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.profiles
    where id = p_user_id
      and account_status = 'active'
      and role = 'tester'
    for update
  ) then
    raise exception 'admit_user_to_learning_engine_v1: % is not an active tester account', p_user_id
      using errcode = '28000';
  end if;

  -- Pre-RC-E corrective: reject admission while an active legacy Session
  -- exists for this user -- see this migration's own header. Checked
  -- AFTER the profile row lock above, so this serializes correctly
  -- against a concurrent start_or_resume_session() call for the same
  -- user (which locks the identical profiles row first, in the identical
  -- order, before it would create a new session).
  select id into v_active_legacy_session_id
  from public.sessions
  where user_id = p_user_id
    and status = 'active'
    and engine_version = 'legacy'
  limit 1;

  if v_active_legacy_session_id is not null then
    raise exception 'admit_user_to_learning_engine_v1: user % has an active legacy session (%) -- it must be finished before this user can be enrolled in Learning Engine v1', p_user_id, v_active_legacy_session_id
      using errcode = '42501';
  end if;

  insert into public.learning_engine_v1_rollout (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select * into v_row
  from public.learning_engine_v1_rollout
  where user_id = p_user_id;

  return v_row;
end;
$$;

comment on function public.admit_user_to_learning_engine_v1(uuid) is
  'Runtime Cutover RC-D (pre-RC-E corrected): the minimal trusted rollout-admission primitive. SECURITY DEFINER, service_role-only. Locks the caller''s profiles row FOR UPDATE (serializing against start_or_resume_session()), then rejects (42501) if the user currently has an ACTIVE engine_version=''legacy'' session -- user_card_progress is shared mutable state and that session could otherwise keep committing legacy answers that never maintain the v1-only fields normalization just wrote. Otherwise inserts a learning_engine_v1_rollout row for an active tester (ON CONFLICT DO NOTHING, idempotent), never updates or deletes one, and performs no normalization itself. Callers MUST complete per-deck legacy-state normalization (RC-A''s normalize_card_progress_for_learning_engine_v1()/recompute_user_deck_learning_state_for_v1()) before calling this -- see lib/learning-engine/cutover/enroll.ts. Never grants authenticated/anon execute -- no tester can self-enroll.';

revoke all on function public.admit_user_to_learning_engine_v1(uuid) from public, anon, authenticated;
grant execute on function public.admit_user_to_learning_engine_v1(uuid) to service_role;
