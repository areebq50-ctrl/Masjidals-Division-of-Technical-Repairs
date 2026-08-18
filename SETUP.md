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
- **Auto-fill on Zendesk ID/Order Number entry** (New Repair form) - typing a
  Zendesk ID or Order Number and tabbing out automatically fills in, all
  reviewable before saving, never auto-saved silently:
  - Customer Name/Email/Phone, from Zendesk (ticket requester) and/or
    Shopify (order).
  - **ZD Assigned To** (Awais/Afroz/Kiran) - matched from the Zendesk
    ticket's assigned agent, separate from the customer's own info above.
  - **Warranty** toggle + date - from the Shopify order's purchase date (12
    months standard, 24 with the `aframewarranty` SKU).
  - **Issue / Problem** - a one-sentence Gemini-generated summary of the
    Zendesk ticket's subject/description (needs `GEMINI_API_KEY` too; skipped
    silently if that's not set, same as everything else here).
  Needs `ZENDESK_*`/`SHOPIFY_*` env vars (see below) - does nothing until
  then. Read-only: never writes anything back to Zendesk or Shopify.
- **Daily Update** button (top bar) - drafts the WhatsApp-ready team status
  message you'd otherwise type by hand, for every customer repair whose
  status you changed today - created, edited to a new status, closed, or
  reopened, not just ones you personally created or closed. Bolded title +
  bolded `*ZD 13140 | Order #29422*` per ticket, e.g.:
  `*ZD 13140 | Order #29422* - @Afroz Masjidal Customer says the device
  turns on and off... Tracking: 1ZGW30800313247576`. Each line always
  covers the issue reported and what was done about it - prefers the
  **Repair Notes** field (the technician's own freeform "what I did"
  notes) for specific detail when it's filled in, and also pulls in
  relevant detail from **Additional Notes** (ignoring anything that reads
  like an internal-only aside, e.g. "ask Areeb first"), falling back to
  the outcome/closing notes otherwise. A repair only gets described as
  "done"/"completed"/"resolved" once the ticket is actually **Closed** -
  a status like "Completed Testing" only means the device moved to the
  testing shelf, not that testing itself is finished, so the message says
  something like "device is testing" for that case instead. Gemini only
  writes the issue-summary and resolution text; the ZD id, order number,
  @mention, and tracking number are always assembled from the actual
  repair data, never left to the model. Nothing is posted automatically -
  it opens in a modal with a Copy button, you paste it wherever you send
  these today. Needs `GEMINI_API_KEY` (already required for Masjidal AI
  above); does nothing until then.
- **Order Number is now optional** on customer repairs (previously
  required) - some tickets genuinely don't have one.
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
  looks up live status directly from UPS/FedEx (their own free tracking
  APIs) or Shippo (also free, for USPS/DHL), and the ticket detail view
  shows a live status pill ("In Transit", "Out for Delivery", "Delivered",
  ...), estimated delivery date, and a short checkpoint timeline, with a
  "Refresh Status" button. Completed Repairs rows also show a small
  tracking pill, and there's a dedicated **In Transit** page for everything
  still on its way back to a customer.
  - Status updates automatically two ways: an hourly scheduled sweep
    (always on once any carrier is configured, no one needs to click
    anything) and, if you set up the optional Shippo webhook, near-instant
    updates on Shippo-tracked shipments. When a package is marked
    Delivered, an activity-log entry is added automatically.
  - **This is fully optional.** Until you add carrier credentials (see
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
scheduled hourly sweep working, connect the repo via Git rather than a manual
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
   - `UPS_CLIENT_ID`/`UPS_CLIENT_SECRET`, `FEDEX_CLIENT_ID`/`FEDEX_CLIENT_SECRET`,
     `SHIPPO_API_KEY` — live package tracking
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

Nothing here requires a paid plan or account — UPS and FedEx have their own
free tracking APIs (preferred, used automatically for those two carriers),
and Shippo (which Masjidal already uses) covers the rest (USPS, DHL) for
free too, no shipping labels need to be purchased through them.

**UPS:**
1. Go to [developer.ups.com](https://developer.ups.com) → sign up/log in →
   **Create an app**. Add the **Tracking API** product to it.
2. Copy the app's **Client ID** and **Client Secret**.
3. In Netlify: Site settings → Environment variables → add `UPS_CLIENT_ID`
   and `UPS_CLIENT_SECRET`.

**FedEx:**
1. Go to [developer.fedex.com](https://developer.fedex.com) → sign up/log
   in → create a project, and add the **Track API** to it.
2. Copy the project's **API Key** (Client ID) and **Secret Key** (Client
   Secret).
3. In Netlify: Site settings → Environment variables → add
   `FEDEX_CLIENT_ID` and `FEDEX_CLIENT_SECRET`.

**Shippo** (covers USPS/DHL — anything that isn't UPS/FedEx):
1. Log into your existing Shippo account at
   [apps.goshippo.com/settings/api](https://apps.goshippo.com/settings/api).
2. Copy the **API Token** (the live one, not "Test Token").
3. In Netlify: Site settings → Environment variables → add `SHIPPO_API_KEY`.

Then **redeploy** (Deploys → Trigger deploy). That's it — saving a tracking
number now automatically looks up live status (UPS/FedEx direct if that's
the carrier, Shippo otherwise), shown in the ticket detail view and the new
**In Transit** page (left sidebar). It also keeps itself updated
automatically from there — no one needs to click "Refresh" — via an hourly
scheduled sweep, on top of the manual "Refresh Status"/"Refresh All"
buttons for whenever you want it checked immediately. You only need to set
up the carriers you actually ship with — e.g. if you only ship UPS/FedEx,
Shippo isn't needed at all, and vice versa.

**If tracking isn't working**: open the ticket detail view (or the In
Transit page) and check the message under the tracking status — it shows
the real reason instead of a generic error (bad credentials, an app still
awaiting production approval, etc.), so you don't need to check Netlify
function logs. The most common cause for UPS/FedEx specifically: a
developer app starts out sandboxed and needs to be approved for
**production** access to the tracking product before the production API
will accept requests from it — check your app's status on the carrier's
developer portal if you're seeing an authentication error.

**Limitation to know about**: UPS/FedEx's free APIs don't offer a webhook
for instant push updates, so UPS/FedEx-tracked shipments update at most
hourly (the scheduled sweep) unless someone clicks "Refresh
Status"/"Refresh All" for something more urgent. Shippo-tracked shipments
(USPS/DHL) CAN get near-instant updates if you set up the optional webhook
(see `SHIPPO_WEBHOOK_SECRET` in `.env.example`); otherwise they're on the
same hourly sweep. Want a tighter interval than hourly? Just say so — it's
a one-line change.

### In Transit page

A dedicated **In Transit** view (left sidebar, under Completed) lists every
closed repair whose package tracking hasn't hit "Delivered" yet — carrier,
tracking number, live status, and estimated delivery, with a "Refresh All"
button to force-check everything on the list at once. A repair drops off
this list automatically the moment its tracking flips to Delivered, **or
after 7 days from the ticket's closed date, whichever comes first** — so
one that never gets confirmed as delivered (lost tracking, carrier stopped
updating, etc.) doesn't sit there forever. It stays visible in Completed
Repairs either way, with its last known tracking status — this cutoff only
affects the dedicated In Transit list, not the underlying data.

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
