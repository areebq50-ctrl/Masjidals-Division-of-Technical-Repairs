-- Parts Inventory: screens, motherboards, WiFi antennas, etc. for Athan
-- Frames, tracked by size -> year -> firmware -> part, with a running
-- quantity and a log of every restock/use so "what gets used most" and
-- "what's low on stock" can be computed from real history.
--
-- Run this once in the Supabase SQL Editor (Project -> SQL Editor -> New
-- query -> paste -> Run). Safe to re-run (IF NOT EXISTS everywhere).

create table if not exists public.parts (
  id text primary key,
  size text not null,
  year text not null,
  firmware text not null,
  "partType" text not null,
  "partName" text,
  quantity integer not null default 0,
  "reorderThreshold" integer not null default 0,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "createdBy" text
);

-- One row per restock or use, so "most used" and "who used what when" can
-- be reconstructed later - the running quantity on `parts` is a
-- convenience cache, this table is the source of truth for history.
create table if not exists public.parts_log (
  id text primary key,
  "partId" text not null references public.parts(id) on delete cascade,
  type text not null check (type in ('restock','use')),
  qty integer not null check (qty > 0),
  by text,
  at timestamptz not null default now(),
  note text
);

create index if not exists parts_log_partid_idx on public.parts_log ("partId");
create index if not exists parts_log_at_idx on public.parts_log (at desc);

-- Ask PostgREST to refresh its schema cache immediately instead of waiting
-- for its normal refresh interval, so the app can use these tables right
-- away.
notify pgrst, 'reload schema';
