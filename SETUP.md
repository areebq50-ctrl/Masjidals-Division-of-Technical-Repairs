# Masjidal DTR — Setup Notes

This covers what changed in this update and how to turn on live package
tracking on Netlify. Nothing here touches your Supabase data or schema — the
`repairs` table already has the `tracking` column the app has always written
to; the tracking feature just stores a richer JSON object in that same field.

## ⚠️ Action required: run `supabase/security.sql`

This update fixes a real security issue and **needs one manual step from you
to fully take effect**. Previously, every employee's PIN was sent to the
browser in plaintext before login (visible in dev tools network tab to
anyone who loaded the page), and the login page itself hardcoded a default
admin PIN (`7346`) in the public source. The app code is fixed, but closing
the hole completely requires a database-level change I can't make for you:

1. Open your Supabase project → **SQL Editor** → **New query**.
2. Paste in the contents of `supabase/security.sql` from this repo and run it.
3. Log in as an admin → **Settings → Employees → Edit "Areeb Qureshi"** → set
   a new PIN, in case the account still uses the old hardcoded `7346`.

Until step 2 is done, the app itself no longer displays or transmits PINs
in normal use, but the `pin` column is still technically readable by anyone
who queries the Supabase REST API directly with the public anon key — the
SQL script is what actually closes that off. See the comments in
`supabase/security.sql` for exactly what it does and why.

### Also worth knowing: a permissions cleanup

The three functions that gate editing/closing/deleting tickets
(`canEdit`, `canCloseTicket`, `canDeleteTicket`) had each been redefined
2–3 times across the file from iterative patches, with later versions
silently overriding earlier ones. I consolidated each into a single
definition, preserving whatever was actually active in production (the
last-defined version), not necessarily the original. One thing I noticed in
the process: view-only techs currently **can** delete a customer ticket they
created — an earlier patch had blocked this, but a later patch (adding
delete rules for "general" employees) was based on an older copy of the
function and silently dropped that restriction. I left the currently-active
behavior in place rather than silently changing it, since I can't be sure
which behavior you actually want — let me know if view-only techs should be
blocked from deleting customer tickets and I'll add it back.

## What changed

- **Waqas removed** from the "ZD Assigned To" dropdown in the New/Edit Repair
  form. Existing tickets already assigned to Waqas are untouched — the value
  just isn't offered for new/edited tickets anymore. If you want those old
  tickets reassigned, that's a manual edit per ticket (or tell me and I can
  script a one-time Supabase update).
- **Live package tracking.** Closing a ticket with "Device Shipped Back" or
  "Replacement Sent to Customer" already prompted for a carrier + tracking
  number — that part is unchanged. Now, saving that tracking number also
  registers it with AfterShip (a carrier-tracking API covering UPS, FedEx,
  USPS, DHL, etc.), and the ticket detail view shows a live status pill
  ("In Transit", "Out for Delivery", "Delivered", ...), estimated delivery
  date, and a short checkpoint timeline, with a "Refresh Status" button.
  Completed Repairs rows also show a small tracking pill so you can see
  delivery status at a glance without opening the ticket.
  - Status updates automatically two ways: an AfterShip webhook (near
    real-time) and a daily scheduled function (fallback, in case the webhook
    is ever missed). When a package is marked Delivered, an activity-log
    entry is added automatically.
  - **This is fully optional.** Until you add an `AFTERSHIP_API_KEY` (see
    below), everything works exactly like before — tracking numbers are
    stored manually with no live status, no errors, no broken UI.
  - Implemented as **Netlify Functions** under `netlify/functions/`, so it
    deploys on Netlify with no other infrastructure needed.
- Minor polish: added a page favicon (reuses your existing logo) and a proper
  meta description. No layout, permissions, or workflow logic changed.

## 1. Deploying this to Netlify

The GitHub repo (`areebq50-ctrl/Masjidals-Division-of-Technical-Repairs`) was
empty before this change, so it's unlikely your current live site is
git-connected to it yet. To get Functions (needed for live tracking) and the
scheduled daily sweep working, connect the repo via Git rather than a manual
drag-and-drop upload — drag-and-drop deploys don't reliably build serverless
functions.

1. In the Netlify dashboard, go to your existing DTR site (or **Add new site
   → Import an existing project** if you want a fresh site).
2. Choose **GitHub** → select
   `areebq50-ctrl/Masjidals-Division-of-Technical-Repairs` → branch
   `claude/masjidal-refactor-vercel-ag0h8q` (or your default branch, once
   this is merged).
3. Build settings: Netlify will read `netlify.toml` automatically — publish
   directory `.`, functions directory `netlify/functions`. No build command
   needed.
4. Under **Site settings → Environment variables**, add whichever of these
   you want (all optional — see `.env.example` for details):
   - `AFTERSHIP_API_KEY`
   - `AFTERSHIP_WEBHOOK_SECRET`
5. Click **Deploy site**.
6. If this is a new site (not your existing one), point your custom domain
   at it under **Domain settings**, then retire the old site once you've
   confirmed the new one works.

If your current site is already connected to a different repo/branch, the
simplest path is: point that existing site's Git integration at this repo
and branch (Site settings → Build & deploy → Link a different repository),
so you keep your existing domain and don't have to redo DNS.

## 2. Turn on live package tracking (optional)

1. Create a free account at [aftership.com](https://www.aftership.com).
2. In the AfterShip dashboard: **Settings → API Keys** → create a key.
3. In Netlify: Site settings → Environment variables → add
   `AFTERSHIP_API_KEY` with that value → redeploy (Deploys → Trigger deploy).
4. That alone gets you: automatic registration on save, live status in the
   ticket detail view, and the daily scheduled-function fallback sweep.
5. For near-instant updates instead of waiting for the daily sweep: in
   AfterShip, go to **Settings → Webhooks**, add
   `https://<your-netlify-domain>/api/track-webhook`, subscribe to the
   "tracking update" event, and copy the signing secret into Netlify as
   `AFTERSHIP_WEBHOOK_SECRET`.
6. AfterShip's free plan covers a generous number of tracked shipments/month
   for a shop this size; if you outgrow it, TrackingMore, Shippo, and
   EasyPost all offer a very similar API shape if you'd rather switch later.

### Scheduled function note

The daily fallback sweep (`track-cron`, 1pm UTC) is a [Netlify Scheduled
Function](https://docs.netlify.com/functions/scheduled-functions/), declared
in `netlify.toml`. This is included on Netlify's free tier — no paid plan
required. It's also reachable manually at `/api/track-cron` for testing.

## Ideas for later (not built yet, happy to add any of these)

- **Customer-facing tracking link/email**: text or email the customer their
  tracking link automatically when the ticket closes with a shipped outcome.
  Needs an email/SMS provider (Postmark, Resend, Twilio) and their contact
  info captured somewhere in the ticket — currently the app doesn't collect
  customer email/phone at all.
- **Delivered filter** on Completed Repairs (e.g. "Awaiting Delivery" vs
  "Delivered") now that delivery status is tracked.
- **Dashboard stat card** for "Packages In Transit" count.
- Move the hardcoded Supabase anon key out of `index.html` into a build-time
  injected value — low priority since it's already public-by-design for a
  client-side app using RLS, but worth knowing it's there if you ever
  tighten Supabase row-level security policies.
