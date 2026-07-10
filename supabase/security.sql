-- Masjidal DTR: lock down employees.pin so it can never be read by the
-- browser, even via a direct REST call using the public anon key.
--
-- Why this is needed: the app's anon key is embedded in index.html, which is
-- public. Before this change, the client fetched `select=*` on `employees`
-- to render the login screen, which included the plaintext `pin` column for
-- every employee - visible in the browser's network tab, before anyone even
-- logs in. The app code has been changed to read from `employees_public`
-- (defined below, no pin column) and to verify PINs via the
-- `verify_employee_pin` RPC instead of comparing them in JavaScript. This
-- script is the other half of that fix: without it, someone could still
-- query `.../rest/v1/employees?select=*` directly with the anon key and get
-- every PIN, regardless of what the app UI does.
--
-- Run this once in the Supabase SQL Editor (Project -> SQL Editor -> New
-- query -> paste -> Run). Safe to re-run.
--
-- Note: an earlier version of this script referenced a "viewOnlyCustomer"
-- column that doesn't exist in this database - that flag turns out to be
-- stored in browser localStorage by the app, not in Postgres at all. Fixed
-- below to match your actual employees columns (id, name, pin, role, color,
-- textColor, initials, seeCustomer, createdAt, updatedAt).

-- 1. A view of employees that omits `pin`. The app reads from this now
--    instead of the base table.
create or replace view public.employees_public as
  select
    id, name, role, color, "textColor", initials,
    "seeCustomer", "createdAt", "updatedAt"
  from public.employees;

grant select on public.employees_public to anon;

-- 2. Enable RLS on the base table and remove anon's ability to SELECT it
--    directly (pin lives there). Inserts/updates/deletes stay open for anon,
--    matching how the app already manages employees today - access control
--    for those actions happens in the app UI (admin-only nav), not in
--    Postgres. If you want database-level enforcement of that too, that's a
--    separate, bigger change (would need real authenticated sessions instead
--    of the shared anon key) - happy to help with that later if you want it.
alter table public.employees enable row level security;

drop policy if exists "employees_insert_anon" on public.employees;
create policy "employees_insert_anon" on public.employees
  for insert to anon with check (true);

drop policy if exists "employees_update_anon" on public.employees;
create policy "employees_update_anon" on public.employees
  for update to anon using (true) with check (true);

drop policy if exists "employees_delete_anon" on public.employees;
create policy "employees_delete_anon" on public.employees
  for delete to anon using (true);

-- Deliberately no anon SELECT policy here - with RLS enabled and no SELECT
-- policy, anon reads of the base table return zero rows. Reads go through
-- employees_public (step 1) or verify_employee_pin (step 3) instead.

-- 3. PIN verification without ever exposing the column: a SECURITY DEFINER
--    function runs with elevated privileges (so it can see `pin` despite the
--    policy above) but only ever returns a row for the exact id+pin given -
--    never a bulk read, and never the pin itself in the response.
create or replace function public.verify_employee_pin(p_employee_id text, p_pin text)
returns table (
  id text, name text, role text, color text, "textColor" text, initials text,
  "seeCustomer" boolean
)
language sql
security definer
set search_path = public
as $$
  select id, name, role, color, "textColor", initials, "seeCustomer"
  from public.employees
  where id = p_employee_id and pin = p_pin;
$$;

revoke all on function public.verify_employee_pin(text, text) from public;
grant execute on function public.verify_employee_pin(text, text) to anon;

-- 4. IMPORTANT MANUAL STEP: the admin account "areeb" was originally seeded
--    by app code with a hardcoded PIN (7346) that has been sitting in the
--    public page source since this app was built. If that account still
--    uses that PIN, change it now: log in as an admin -> Settings ->
--    Employees -> Edit "Areeb Qureshi" -> set a new PIN. Do this even if
--    you're not sure it's still 7346 - there's no downside to rotating it.
