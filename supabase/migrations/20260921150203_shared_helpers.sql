-- Shared helpers used by later migrations.
--
-- Scope for this migration only:
--   - set_updated_at(): generic BEFORE UPDATE trigger function that stamps
--     updated_at = now() on any table it is attached to.
--
-- Deliberately NOT included here:
--   - No CREATE EXTENSION statements. gen_random_uuid() has been a built-in
--     Postgres function (no extension required) since PG13, and Supabase
--     projects run on newer versions than that, so UUID primary keys need
--     nothing extra.
--   - is_admin() (and any other RLS-policy helper) is deferred to the
--     grants/RLS migration, since it will need to query public.profiles,
--     which does not exist yet at this point in the migration sequence.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Generic BEFORE UPDATE trigger: stamps updated_at = now() on the row being written. Not SECURITY DEFINER -- runs with the privileges of whatever statement/role is already permitted to update the row.';
