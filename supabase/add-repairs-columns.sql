-- Adds the columns the app has been trying to save (custName, custEmail,
-- custPhone, relatedTo) but that don't exist yet on `repairs` - this is
-- what's been causing every customer repair save to fail with:
--   "Could not find the 'custEmail' column of 'repairs' in the schema cache"
--
-- Run this once in the Supabase SQL Editor. Safe to re-run (IF NOT EXISTS).
-- Does not touch or remove any existing data/columns.

alter table public.repairs add column if not exists "custName" text;
alter table public.repairs add column if not exists "custEmail" text;
alter table public.repairs add column if not exists "custPhone" text;
alter table public.repairs add column if not exists "relatedTo" text;

-- Ask PostgREST to refresh its schema cache immediately instead of waiting
-- for its normal refresh interval, so the fix takes effect right away.
notify pgrst, 'reload schema';
