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

## What changed (latest batch)

- **Follow-up/linked tickets.** When creating a customer repair, if the
  Zendesk ID or Order Number entered matches an existing ticket, a banner
  shows the previous ticket(s) and the new one is automatically linked as a
  follow-up (`relatedTo`) instead of you having to edit the original. The
  ticket detail view shows both directions - "Previous repair" and any
  "Follow-up repair" - as clickable links.
- **Customer contact fields** (name/email/phone) added to customer repairs,
  optional, shown in the detail view. Groundwork for any future
  customer-facing notifications.
- **"Look up customer" button** on the New Repair form pulls name/email/phone
  from Zendesk (by ticket ID) and/or Shopify (by order number) into those new
  fields - you review and it fills in, never auto-saves silently. Needs
  `ZENDESK_*`/`SHOPIFY_*` env vars (see below) - does nothing until then.
  Read-only: it never writes anything back to Zendesk or Shopify.
- **Numeric PIN keypad** on the login screen - faster to tap on a shop-floor
  phone/tablet than the native keyboard. Physical keyboard typing still works.
- **Delivered vs Awaiting Delivery filter** on Completed Repairs, using the
  tracking status from the live-tracking feature.
- **Export CSV** button on Completed Repairs - downloads every repair record
  (all types/statuses) as a CSV that opens directly in Excel/Sheets.
- **Ask AI page** (Settings sidebar, admin-only) - ask natural-language
  questions about your repair data ("how many devices have a cracked
  screen", "which device size has the most issues", "android 6 vs 11
  breakdown") and get an answer plus, for breakdown-style questions, a table
  with its own CSV export. Backed by Gemini - needs `GEMINI_API_KEY` (see
  below), otherwise the page just explains it isn't configured yet. Only a
  trimmed, PII-free snapshot of repair data (no Zendesk ID/order
  number/serial/customer contact info) is sent to Gemini per question.

## What changed (earlier batch)

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
   - `AFTERSHIP_API_KEY`, `AFTERSHIP_WEBHOOK_SECRET` — live package tracking
   - `GEMINI_API_KEY`, `GEMINI_MODEL` — Ask AI
   - `ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`, `ZENDESK_API_TOKEN` — customer lookup
   - `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN` — customer lookup
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

## 3. Turn on Ask AI (optional)

1. Go to [aistudio.google.com](https://aistudio.google.com) → **Get API
   key** → create a key (free tier is generous for this volume of use).
2. In Netlify: Site settings → Environment variables → add `GEMINI_API_KEY`
   → redeploy.
3. That's it — the "Ask AI" page (visible to admins in the sidebar) starts
   answering questions. `GEMINI_MODEL` is optional if you want a different
   model than the default (`gemini-2.0-flash`).

## 4. Turn on Zendesk/Shopify customer lookup (optional)

**Zendesk:**
1. Zendesk Admin Center → Apps and integrations → APIs → Zendesk API →
   enable token access → add API token.
2. In Netlify, add `ZENDESK_SUBDOMAIN` (the part before `.zendesk.com` in
   your Zendesk URL), `ZENDESK_EMAIL` (the email of the account that
   generated the token), and `ZENDESK_API_TOKEN`.

**Shopify:**
1. Shopify Admin → Settings → Apps and sales channels → Develop apps →
   Create an app → Configure Admin API scopes → grant `read_orders` only →
   Install app → copy the Admin API access token (shown once).
2. In Netlify, add `SHOPIFY_STORE_DOMAIN` (e.g. `masjidal.myshopify.com`)
   and `SHOPIFY_ADMIN_TOKEN`.

Either one works independently — set up just Zendesk, just Shopify, or both.
See the top of this document for what this feature does and its limitations
(exact-match lookup only, read-only, no continuous sync).

## Ideas for later (not built yet, happy to add any of these)

- **Customer-facing tracking link/email**: now that customer email/phone is
  captured on the ticket, text or email them their tracking link
  automatically when the ticket closes with a shipped outcome. Needs an
  email/SMS provider (Postmark, Resend, Twilio).
- **Push repair status updates to Zendesk** as an internal note when a
  ticket's status changes (the "push" half of the Zendesk integration -
  only the "pull" half is built so far).
- **Dashboard stat card** for "Packages In Transit" count.
- Move the hardcoded Supabase anon key out of `index.html` into a build-time
  injected value — low priority since it's already public-by-design for a
  client-side app using RLS, but worth knowing it's there if you ever
  tighten Supabase row-level security policies.
