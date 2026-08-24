-- Fixes the Supabase Security Advisor's "Security Definer View" warning on
-- public.employees_public.
--
-- Why the view was built this way: Postgres views implicitly run with the
-- VIEW OWNER's privileges (not the querying user's) unless
-- `security_invoker=on` is set - and that's exactly what let
-- employees_public work as a safe, narrower "public" read surface on top
-- of `employees`, whose RLS deliberately has NO anon SELECT policy at all
-- (see security.sql - that's what keeps the `pin` column from ever being
-- bulk-readable). The Advisor's own suggested fix,
-- `security_invoker=on`, would NOT be safe to apply here: with no anon
-- SELECT policy on the base table, an invoker-mode view evaluates RLS as
-- the anon role and would return zero rows - breaking the login screen,
-- which needs to list every employee's name/avatar as tiles.
--
-- The actual fix: replace the view with a SECURITY DEFINER FUNCTION
-- instead. Same intentional "run as owner, expose only these columns"
-- behavior as before, but functions aren't covered by this lint rule at
-- all (it's specific to views) - and it's the exact pattern this app
-- already uses for verify_employee_pin in security.sql. Nothing about
-- what data the app can see changes; it's an RPC call instead of a plain
-- select now, that's the only difference.
--
-- Run this once in the Supabase SQL Editor (Project -> SQL Editor -> New
-- query -> paste -> Run). Safe to re-run.

create or replace function public.get_employees_public()
returns table (
  id public.employees.id%TYPE,
  name public.employees.name%TYPE,
  role public.employees.role%TYPE,
  color public.employees.color%TYPE,
  "textColor" public.employees."textColor"%TYPE,
  initials public.employees.initials%TYPE,
  "seeCustomer" public.employees."seeCustomer"%TYPE,
  "createdAt" public.employees."createdAt"%TYPE,
  "updatedAt" public.employees."updatedAt"%TYPE
)
language sql
security definer
set search_path = public
as $$
  select id, name, role, color, "textColor", initials, "seeCustomer", "createdAt", "updatedAt"
  from public.employees;
$$;

revoke all on function public.get_employees_public() from public;
grant execute on function public.get_employees_public() to anon;

-- The view is no longer used by the app (index.html now calls
-- get_employees_public() above instead) and its mere existence is what
-- the Advisor flags, so it's dropped rather than left around unused.
drop view if exists public.employees_public;

notify pgrst, 'reload schema';
