-- Learning Engine v1 -- the one-way rollout invariant, enforced in the
-- database itself.
--
-- Forward-only, strictly additive. Does not edit RC-A
-- (20261007000000_learning_engine_v1_runtime_cutover_schema.sql, which
-- defines public.learning_engine_v1_rollout) or either RC-C answer-commit
-- migration (20261013000000/20261014000000) -- this migration adds
-- exactly one new trigger function and one new trigger on
-- public.learning_engine_v1_rollout. No existing column, constraint,
-- grant, RLS policy, or function body is modified.
--
-- ---------------------------------------------------------------------
-- The gap (review finding, confirmed)
-- ---------------------------------------------------------------------
-- RC-A's own header comment already states the intended rule: "per R5,
-- automatic rollback to legacy is prohibited from this point on" once
-- first_v1_answer_at is set. Until this migration, that was documented
-- intent only -- RC-A granted no write access to `authenticated`/`anon`
-- (so an ordinary tester could never violate it), but nothing stopped a
-- service_role-privileged caller (operational tooling, a future admin
-- function, or a direct psql session) from deleting the row, or from
-- clearing/overwriting first_v1_answer_at, even after the one-way zone
-- had already been entered. RLS policies and table grants do not apply
-- to a role with the bypassrls attribute (service_role) at all, and the
-- RC-C answer-commit transaction itself runs AS service_role -- so the
-- boundary has to be enforced by the database's own trigger machinery
-- (which fires for every DML statement regardless of bypassrls), not by
-- any grant/policy/application-level convention.
--
-- ---------------------------------------------------------------------
-- The fix
-- ---------------------------------------------------------------------
-- One new row-level BEFORE UPDATE OR DELETE trigger making
-- first_v1_answer_at a write-once historical marker:
--
--   DELETE:
--     OLD.first_v1_answer_at IS NULL     -> allowed (rollout may still be
--                                           cancelled operationally before
--                                           any v1 answer was ever committed)
--     OLD.first_v1_answer_at IS NOT NULL -> rejected (42501) -- the row is
--                                           now permanent
--
--   UPDATE (examining only the first_v1_answer_at column; every other
--   column on this row may still change freely, e.g. a future column add):
--     OLD NULL     -> NEW NOT NULL  -> allowed (the normal first-answer
--                                      transition RC-C's
--                                      commit_learning_engine_v1_answer()
--                                      performs)
--     OLD NULL     -> NEW NULL      -> allowed (no-op)
--     OLD NOT NULL -> NEW = OLD     -> allowed (no-op, including any
--                                      unrelated column update on an
--                                      already-permanent row)
--     OLD NOT NULL -> NEW NULL      -> rejected (42501)
--     OLD NOT NULL -> NEW <> OLD    -> rejected (42501)
--
-- Deliberately NOT a SECURITY DEFINER function: it performs no write of
-- its own (it only inspects OLD/NEW and either returns a row unchanged or
-- raises), so there is nothing here that needs elevated privileges --
-- the minimal-privilege precedent this codebase's OTHER trigger functions
-- only reach for when they must write to a table the firing role lacks a
-- grant on (e.g. RC-B's bump_scheduler_revision_on_cards_insert()).
--
-- ---------------------------------------------------------------------
-- Session routing contract (durable invariant for RC-D)
-- ---------------------------------------------------------------------
-- A learning_engine_v1_rollout row with first_v1_answer_at IS NOT NULL is
-- now a database-enforced PERMANENT fact -- it can never be deleted, and
-- the timestamp itself can never change. A future RC-D's session-creation
-- routing may therefore trust it unconditionally: once a user has
-- committed their first v1 answer, "has this user already entered the
-- one-way v1 zone" is simply `first_v1_answer_at is not null` on a row
-- that is now guaranteed to keep existing with that same value forever.
-- `sessions.engine_version` remains the sole runtime source of truth for
-- an ALREADY-CREATED session (unchanged, RC-A's own original contract) --
-- this invariant governs only whether a brand-new session may ever be
-- routed to 'legacy' for a user who has already left the rollout table's
-- pre-commit phase; it does not retroactively change any existing row.
create function public.enforce_learning_engine_v1_rollout_one_way()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.first_v1_answer_at is not null then
      raise exception 'learning_engine_v1_rollout: cannot delete the rollout row for user % -- first_v1_answer_at is already set, and the one-way v1 zone is permanent', old.user_id
        using errcode = '42501';
    end if;
    return old;
  end if;

  -- tg_op = 'UPDATE': first_v1_answer_at is a write-once historical
  -- marker once non-null -- every other column transition is untouched
  -- by this guard.
  if old.first_v1_answer_at is not null and new.first_v1_answer_at is distinct from old.first_v1_answer_at then
    raise exception 'learning_engine_v1_rollout: first_v1_answer_at for user % is already set and cannot be changed or cleared', old.user_id
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.enforce_learning_engine_v1_rollout_one_way() is
  'Learning Engine v1 rollout one-way guard: makes learning_engine_v1_rollout.first_v1_answer_at a permanent, write-once historical marker once set. Rejects (42501) any DELETE of a row whose first_v1_answer_at is already non-null, and any UPDATE that would clear or change an already-set first_v1_answer_at. Fires for every role, including service_role -- RLS/grants do not apply to a bypassrls role, so this boundary is enforced by the trigger itself, not by policy. Does not restrict any other column or any transition while first_v1_answer_at is still null.';

create trigger learning_engine_v1_rollout_one_way_guard
  before update or delete on public.learning_engine_v1_rollout
  for each row
  execute function public.enforce_learning_engine_v1_rollout_one_way();
