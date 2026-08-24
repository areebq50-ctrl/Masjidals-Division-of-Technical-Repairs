-- One-time cleanup: closes every General/Amazon-return repair (i.e. NOT a
-- customer repair - those are left completely alone) that's still open.
-- These are the internal test/refurb tickets that get created, forgotten
-- about, and never formally closed.
--
-- I don't know what actually happened to each of these devices (fixed?
-- scrapped? still sitting on a shelf?), so rather than guess and write a
-- specific outcome that might be wrong, this marks them Closed with
-- Outcome "Other: Bulk-closed - stale internal ticket (no outcome
-- recorded)" and logs a matching Activity Log entry for each one, the
-- same as the app does when you close a ticket from the UI. If any of
-- these actually need a real outcome on record, edit that one ticket
-- afterward - Reopen Ticket is right there on Completed Repairs if you
-- need to fix one.
--
-- Run this once in the Supabase SQL Editor (Project -> SQL Editor -> New
-- query -> paste -> Run). Re-running it is harmless - by the second run,
-- the WHERE clause below no longer matches anything (they're all Closed).

with closed as (
  update public.repairs
  set
    status = 'Closed',
    "closedAt" = now(),
    "updatedAt" = now(),
    outcome = 'other:Bulk-closed - stale internal ticket (no outcome recorded)'
  where
    type in ('general', 'amazon')
    and status <> 'Closed'
  returning ticket
)
insert into public.activity (ticket, msg, by, at)
select ticket, 'Bulk-closed stale ticket (SQL cleanup, no specific outcome recorded)', 'System', now()
from closed;
