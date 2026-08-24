-- Parts Inventory: screens, motherboards, WiFi antennas, etc. for Athan
-- Frames, tracked by size -> year -> Android type -> identifier (firmware
-- for Android 11 parts, production date for Android 6 parts, since those
-- don't have a firmware version) -> part, with a running quantity and a
-- log of every restock/use so "what gets used most" and "what's low on
-- stock" can be computed from real history.
--
-- =======================================================================
-- RUN THIS WHOLE FILE. Paste all of it into the Supabase SQL Editor
-- (Project -> SQL Editor -> New query -> paste -> Run).
--
-- It is fully idempotent and self-healing: it works whether the tables
-- don't exist yet, were created by an older version of this file, or
-- already exist and are fine. It fixes every known reason a part save
-- can fail:
--   1. tables missing              -> creates them
--   2. columns missing             -> adds them (androidType/productionDate
--                                     were added after the first release)
--   3. firmware declared NOT NULL  -> relaxes it (Android 6 parts have no
--                                     firmware)
--   4. anon role lacks privileges  -> grants them
--   5. RLS on with no policies     -> adds permissive policies
--   6. stale PostgREST schema cache-> reloads it
--
-- Nothing here deletes or overwrites existing rows.
-- =======================================================================

-- 1. Tables ------------------------------------------------------------
create table if not exists public.parts (
  id text primary key
);

create table if not exists public.parts_log (
  id text primary key
);

-- 2. Columns -----------------------------------------------------------
-- Added one-by-one rather than relying on the CREATE TABLE above, so this
-- repairs a table created by ANY earlier version of this file, not just a
-- brand new one.
alter table public.parts add column if not exists size text;
alter table public.parts add column if not exists year text;
alter table public.parts add column if not exists "androidType" text;
alter table public.parts add column if not exists firmware text;
alter table public.parts add column if not exists "productionDate" date;
alter table public.parts add column if not exists "partType" text;
alter table public.parts add column if not exists "partName" text;
alter table public.parts add column if not exists quantity integer not null default 0;
alter table public.parts add column if not exists "reorderThreshold" integer not null default 0;
alter table public.parts add column if not exists "createdAt" timestamptz not null default now();
alter table public.parts add column if not exists "updatedAt" timestamptz not null default now();
alter table public.parts add column if not exists "createdBy" text;

alter table public.parts_log add column if not exists "partId" text;
alter table public.parts_log add column if not exists type text;
alter table public.parts_log add column if not exists qty integer;
alter table public.parts_log add column if not exists by text;
alter table public.parts_log add column if not exists at timestamptz not null default now();
alter table public.parts_log add column if not exists note text;

-- 3. Relax constraints that block valid saves --------------------------
-- An earlier version declared firmware NOT NULL, but Android 6 parts are
-- identified by production date and have no firmware value at all.
alter table public.parts alter column firmware drop not null;

create index if not exists parts_log_partid_idx on public.parts_log ("partId");
create index if not exists parts_log_at_idx on public.parts_log (at desc);

-- 4. Privileges for the anon role --------------------------------------
-- The app talks to Supabase with the public anon key (same as it does for
-- repairs/activity), so anon needs table privileges. Supabase's default
-- privileges usually cover this automatically for new tables in `public`,
-- but granting explicitly makes this script work regardless.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.parts to anon, authenticated;
grant select, insert, update, delete on public.parts_log to anon, authenticated;

-- 5. Row Level Security -------------------------------------------------
-- RLS is enabled deliberately: Supabase's Security Advisor flags any
-- API-exposed table in `public` that has RLS off, and you've already hit
-- one advisor warning on this project. The policies below are permissive
-- (anon may do everything), which matches how the rest of this app already
-- works - access control lives in the app UI, not in Postgres. Parts data
-- is part numbers and counts, nothing sensitive like the employees.pin
-- column that security.sql locks down.
alter table public.parts enable row level security;
alter table public.parts_log enable row level security;

drop policy if exists "parts_all_anon" on public.parts;
create policy "parts_all_anon" on public.parts
  for all to anon, authenticated using (true) with check (true);

drop policy if exists "parts_log_all_anon" on public.parts_log;
create policy "parts_log_all_anon" on public.parts_log
  for all to anon, authenticated using (true) with check (true);

-- 6. Refresh PostgREST's schema cache ----------------------------------
-- Without this, Supabase can keep reporting "Could not find the
-- 'androidType' column ... in the schema cache" for a while even after the
-- column exists.
notify pgrst, 'reload schema';

-- 7. Verification -------------------------------------------------------
-- The result grid below should list all 12 parts columns, including
-- androidType and productionDate. If those two are present, the save error
-- is fixed.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'parts'
order by ordinal_position;
