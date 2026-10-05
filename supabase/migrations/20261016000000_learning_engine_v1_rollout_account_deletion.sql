-- Learning Engine v1 -- corrects the one-way rollout guard
-- (20261015000000_learning_engine_v1_rollout_one_way_guard.sql) so "a
-- live user can never fall back to legacy" does not also mean "this
-- user's account can never be fully deleted."
--
-- Forward-only, strictly additive over 20261015000000 -- that migration's
-- trigger ATTACHMENT is untouched; this migration only CREATE OR REPLACEs
-- the trigger FUNCTION's body (adding one new escape hatch, DELETE-only)
-- and adds one new trusted function. No prior migration is rewritten.
--
-- ---------------------------------------------------------------------
-- The gap (review finding, confirmed)
-- ---------------------------------------------------------------------
-- 20261015000000's trigger rejected ANY delete of a permanent rollout
-- row (first_v1_answer_at is not null), unconditionally -- correct for
-- the "live user" case (nothing may make a live v1 user's history
-- disappear, section 1 of this migration's own task brief), but it also
-- blocked the one case that legitimately needs to remove that row: a
-- full user/account deletion, which `learning_engine_v1_rollout.user_id
-- references public.profiles (id) on delete restrict` (RC-A, unchanged by
-- this migration) requires to happen BEFORE the profile itself can be
-- deleted -- the same fixed ordering convention every other user-owned
-- table in this schema already follows (tests/integration/fixtures/
-- setup.ts's deleteOwnedLearnerData, mirroring the project's only
-- existing account/data deletion lifecycle; there is no separate
-- production "delete my account" RPC today -- confirmed by audit before
-- writing this migration).
--
-- ---------------------------------------------------------------------
-- The fix: an explicit, narrow escape hatch -- never FK/CASCADE ordering
-- ---------------------------------------------------------------------
-- Rejected alternative: relying on `ON DELETE CASCADE` from profiles and
-- having the trigger distinguish "cascaded from a profile delete" from
-- "a direct standalone delete" by checking whether the profile row still
-- exists. This was NOT adopted -- Postgres does not guarantee that a
-- cascaded child delete's BEFORE DELETE trigger observes the parent row
-- as already gone (the two deletes are part of the same statement's
-- execution and the exact visibility ordering is an internal implementation
-- detail this migration does not rely on, per the task brief's own
-- explicit warning not to assume FK/trigger ordering without testing it).
--
-- Instead: a single, narrowly-scoped flag (`set_config(..., is_local =>
-- true)`, never a session-wide or persistent setting) that the trigger's
-- DELETE branch checks, combined with exactly ONE new trusted function
-- that is the ONLY place permitted to set it -- and which explicitly
-- turns the flag back off again, in the same call, immediately after its
-- own single DELETE. A plain `DELETE FROM learning_engine_v1_rollout` --
-- even run AS service_role, even inside whatever future trusted function
-- -- still hits the unconditional rejection unless it goes through this
-- one function, and the bypass never outlives that one call even if the
-- caller's own transaction stays open afterward. This sidesteps cascade-
-- ordering entirely: the FK stays exactly `on delete restrict`,
-- completely unchanged, and the deletion sequence a full account
-- deletion must already follow (rollout row, then every other owned row,
-- then profile, then auth user -- RESTRICT demands this order
-- regardless) is exactly where this new function's one call slots in.
--
-- UPDATE semantics are completely unaffected by this migration --
-- first_v1_answer_at remains write-once (NULL -> timestamp allowed;
-- timestamp -> the same timestamp allowed; any other change rejected,
-- for every role, no escape hatch). Only the DELETE branch gains the
-- bypass -- a full account deletion removes the whole row, it never
-- rewrites it.
create or replace function public.enforce_learning_engine_v1_rollout_one_way()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.first_v1_answer_at is not null
       and coalesce(current_setting('vocab_battle.allow_permanent_rollout_delete', true), '') <> 'on' then
      raise exception 'learning_engine_v1_rollout: cannot delete the rollout row for user % -- first_v1_answer_at is already set, and the one-way v1 zone is permanent while this user exists (use delete_learning_engine_v1_rollout_for_account_deletion() for a genuine full account deletion)', old.user_id
        using errcode = '42501';
    end if;
    return old;
  end if;

  -- tg_op = 'UPDATE': unchanged from 20261015000000 -- no escape hatch,
  -- first_v1_answer_at is write-once for every role, always.
  if old.first_v1_answer_at is not null and new.first_v1_answer_at is distinct from old.first_v1_answer_at then
    raise exception 'learning_engine_v1_rollout: first_v1_answer_at for user % is already set and cannot be changed or cleared', old.user_id
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.enforce_learning_engine_v1_rollout_one_way() is
  'Learning Engine v1 rollout one-way guard (corrected, 20261016000000). UPDATE: first_v1_answer_at remains a permanent write-once historical marker once set, no exceptions, for every role. DELETE: rejected (42501) whenever first_v1_answer_at is already set, UNLESS the transaction-local vocab_battle.allow_permanent_rollout_delete flag is "on" -- set only by delete_learning_engine_v1_rollout_for_account_deletion(), the single sanctioned path for a genuine full account deletion. A live user (profile still exists, no account-deletion flow invoked) can never make their own permanent v1 history disappear.';

-- ---------------------------------------------------------------------
-- The one sanctioned bypass: a full account deletion only.
-- ---------------------------------------------------------------------
-- SECURITY DEFINER, service_role-only -- the same trust boundary as
-- every other trusted Learning Engine v1 function. Deletes AT MOST one
-- row (this user's own rollout row, if any -- a no-op, not an error, if
-- none exists, e.g. a legacy-only user). Does not touch, and is not
-- responsible for, any other owned table, the profile row, or the auth
-- user -- the caller (today: the integration test fixtures' existing
-- deleteOwnedLearnerData/teardownIntegrationFixtures sequence; in the
-- future, whatever trusted account-deletion workflow the product adds)
-- remains responsible for the rest of that ordered sequence, exactly as
-- it already is for every other RESTRICT-constrained table in this
-- schema. This function does not, and must not, decide BY ITSELF that a
-- full account deletion is underway -- the caller already had to decide
-- that before calling it.
create function public.delete_learning_engine_v1_rollout_for_account_deletion(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'delete_learning_engine_v1_rollout_for_account_deletion: p_user_id is required'
      using errcode = '22023';
  end if;

  -- Transaction-local (is_local => true) for the duration of this one
  -- DELETE only -- explicitly turned back off immediately afterward, in
  -- the SAME function call, so the bypass can never leak to any OTHER
  -- statement even if the caller's transaction stays open afterward
  -- (e.g. a single multi-statement psql/pgTAP transaction). In normal
  -- production use, each trusted RPC call is already its own
  -- transaction (PostgREST), so this explicit reset is defense-in-depth,
  -- not merely theoretical -- it is what makes the bypass genuinely
  -- scoped to "this one row, this one call," never "this whole
  -- transaction."
  perform set_config('vocab_battle.allow_permanent_rollout_delete', 'on', true);
  delete from public.learning_engine_v1_rollout where user_id = p_user_id;
  perform set_config('vocab_battle.allow_permanent_rollout_delete', 'off', true);
end;
$$;

comment on function public.delete_learning_engine_v1_rollout_for_account_deletion(uuid) is
  'The ONLY sanctioned way to delete a learning_engine_v1_rollout row once first_v1_answer_at is set -- for a genuine full account/user deletion only (profiles -> auth.users is on delete restrict, so this row must be removed before the profile can be, the same fixed ordering every other owned table in this schema already follows). SECURITY DEFINER, service_role-only. Sets a flag the enforce_learning_engine_v1_rollout_one_way() trigger checks, deletes the row (a no-op if the user has no rollout row at all), then immediately clears the flag again in this same call -- the bypass never outlives this one DELETE, even if the caller keeps its own transaction open afterward. Does not delete the profile, auth user, or any other owned data itself; the caller''s own account-deletion sequence remains responsible for the rest, in the existing fixed order.';

revoke all on function public.delete_learning_engine_v1_rollout_for_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.delete_learning_engine_v1_rollout_for_account_deletion(uuid) to service_role;
