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

### Also worth knowing: "view-only tech" is stored per-browser, not in the database

The `employees` table has no `viewOnlyCustomer` column (confirmed by running
`information_schema.columns` against your actual database). The app stores
that flag in **browser localStorage** instead (`setViewOnlyMap()` /
`getViewOnlyMap()` in the code), keyed by employee ID. In practice this means:
if an admin sets a tech to "view only" on one computer, that restriction
**only applies on that specific browser** — logging in as that tech from a
different computer, browser, or after clearing browser data, they'd get full
access again, since there's no server-side record of the setting. Same for
`security.sql`'s `verify_employee_pin` function - it can't return
`viewOnlyCustomer` because there's nothing in Postgres to return.

This isn't something I changed - it's how the feature already worked - but
given "view only" is meant to be an access restriction, having it be
per-browser rather than a real permission is worth knowing about. If you
want this to actually be enforced everywhere consistently, it'd need a real
`viewOnlyCustomer` boolean column added to `employees` and the client code
switched to read/write it there instead of localStorage - a small, safe
change I can make whenever you want it.

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

Since you ship exclusively with UPS, the tracking feature prefers UPS's own
free Tracking API — no AfterShip account or paid plan needed:

1. Go to [developer.ups.com](https://developer.ups.com) → sign up/log in →
   **Create an app**. Add the **Tracking API** product to it.
2. Copy the app's **Client ID** and **Client Secret**.
3. In Netlify: Site settings → Environment variables → add `UPS_CLIENT_ID`
   and `UPS_CLIENT_SECRET` → redeploy (Deploys → Trigger deploy).
4. That's it — saving a UPS tracking number now automatically looks up
   status via UPS directly, shown in the ticket detail view, refreshed by
   the "Refresh Status" button and the daily scheduled sweep.

**Limitation to know about**: UPS's free API doesn't offer an easy webhook
for real-time push updates (that requires UPS's separate Quantum View
enterprise product), so UPS-tracked shipments only update when someone
clicks "Refresh Status" or when the daily sweep runs (once/day) — not
instantly the moment UPS's system updates. For a repair shop's volume this
is normally fine; say the word if you want tighter timing later.

If you ever also want AfterShip as a fallback for other carriers, the code
already supports it: set `AFTERSHIP_API_KEY`, and optionally
`AFTERSHIP_WEBHOOK_SECRET` for near-real-time updates on those. Not required
for UPS.

### Scheduled function note

The daily fallback sweep (`track-cron`, 1pm UTC) is a [Netlify Scheduled
Function](https://docs.netlify.com/build/functions/scheduled-functions/),
declared in `netlify.toml`. This is included on Netlify's free tier — no
paid plan required. Scheduled functions can't be triggered by visiting a
URL in production (Netlify blocks that) - to run it on demand, go to
Netlify → your site → **Functions** → `track-cron` → **Run now**.

## 3. Turn on Ask AI (optional)

1. Go to [aistudio.google.com](https://aistudio.google.com) → **Get API
   key** → create a key (free tier is generous for this volume of use).
2. In Netlify: Site settings → Environment variables → add `GEMINI_API_KEY`
   → redeploy.
3. That's it — the "Masjidal AI" page (visible to admins in the sidebar and
   as a shortcut button in the top bar) starts answering questions.
   `GEMINI_MODEL` is optional if you want to pin a specific model version;
   the default is `gemini-flash-latest`, Google's rolling alias for their
   current recommended fast model, chosen specifically so this doesn't go
   stale the way a hardcoded version number eventually does (an earlier
   version of this pinned to `gemini-2.0-flash`, which Google shut down on
   2026-06-01 - if Masjidal AI ever stops working with a "model not found"
   style error again in the future, that's almost certainly why - check
   [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)
   for current model names and set `GEMINI_MODEL` accordingly).

## 4. Turn on Zendesk/Shopify customer lookup (optional)

**Zendesk:**
1. Zendesk Admin Center → Apps and integrations → APIs → Zendesk API →
   enable token access → add API token.
2. In Netlify, add `ZENDESK_SUBDOMAIN` (the part before `.zendesk.com` in
   your Zendesk URL), `ZENDESK_EMAIL` (the email of the account that
   generated the token), and `ZENDESK_API_TOKEN`.

**Shopify:**

Shopify's simple "reveal a static token" custom-app flow wasn't available on
this account - it routed straight into the dev dashboard (Client ID/Secret,
OAuth-based) instead. To bridge that, this repo includes a one-time OAuth
install helper (`/api/shopify-install` and `/api/shopify-callback`):

1. In the Shopify **dev dashboard** app you already created (Client ID +
   Secret screen): go to its **Configuration** and set:
   - **App URL**: `https://<your-netlify-domain>/api/shopify-install`
   - **Allowed redirection URL(s)**: `https://<your-netlify-domain>/api/shopify-callback`
   - **Scopes**: `read_orders`
   - Then try **Release** again - it was likely failing before because these
     fields were empty.
2. In Netlify, add `SHOPIFY_STORE_DOMAIN` (your `xxxxx.myshopify.com`
   domain), `SHOPIFY_API_KEY` (the Client ID), and `SHOPIFY_API_SECRET`
   (reveal it on that same Settings screen) → redeploy.
3. Visit `https://<your-netlify-domain>/api/shopify-install` in a browser
   while logged into the store admin. Approve the install (it'll ask for
   `read_orders` access). You'll land on a page showing an access token
   once.
4. Copy that value into Netlify as `SHOPIFY_ADMIN_TOKEN` → redeploy. Done -
   `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET` aren't needed again after this
   (safe to leave them, or remove them later).

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
