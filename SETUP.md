# Masjidal DTR — Setup & Migration Notes

This covers what changed in this update, how to move the site from Netlify to
Vercel, and how to turn on live package tracking. Nothing here touches your
Supabase data or schema — the `repairs` table already has the `tracking`
column the app has always written to; the tracking feature just stores a
richer JSON object in that same field.

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
    real-time) and a daily cron job (fallback, in case the webhook is ever
    missed). When a package is marked Delivered, an activity-log entry is
    added automatically.
  - **This is fully optional.** Until you add an `AFTERSHIP_API_KEY` (see
    below), everything works exactly like before — tracking numbers are
    stored manually with no live status, no errors, no broken UI.
- Minor polish: added a page favicon (reuses your existing logo) and a proper
  meta description. No layout, permissions, or workflow logic changed.

## 1. Move from Netlify to Vercel

1. Push this branch's PR to your default branch (or deploy the branch
   directly from Vercel — see step 2).
2. Go to [vercel.com](https://vercel.com) → **Add New… → Project** → import
   `areebq50-ctrl/Masjidals-Division-of-Technical-Repairs` from GitHub.
3. Framework Preset: **Other**. Build Command: leave empty. Output
   Directory: leave default (root) — `index.html` is a static file, and the
   `/api` folder is auto-detected as Serverless Functions. No build step is
   needed.
4. Under **Environment Variables**, add whichever of these you want (all
   optional — see `.env.example` for details):
   - `AFTERSHIP_API_KEY`
   - `AFTERSHIP_WEBHOOK_SECRET`
   - `CRON_SECRET`
5. Click **Deploy**. You'll get a `*.vercel.app` URL immediately.
6. If you use a custom domain, add it under Project Settings → Domains, then
   update the domain's DNS records at your registrar to point to Vercel
   (Vercel shows you the exact records to add).
7. Once Vercel is confirmed working, go to your Netlify site → Site settings
   → and either **stop auto-publishing** or **delete the site** so the two
   don't both try to serve traffic. If you moved a custom domain over, do
   this only after DNS has fully cut over.

## 2. Turn on live package tracking (optional)

1. Create a free account at [aftership.com](https://www.aftership.com).
2. In the AfterShip dashboard: **Settings → API Keys** → create a key.
3. In Vercel: Project Settings → Environment Variables → add
   `AFTERSHIP_API_KEY` with that value → redeploy.
4. That alone gets you: automatic registration on save, live status in the
   ticket detail view, and the daily cron fallback sweep.
5. For near-instant updates instead of waiting for the daily sweep: in
   AfterShip, go to **Settings → Webhooks**, add
   `https://<your-vercel-domain>/api/track-webhook`, subscribe to the
   "tracking update" event, and copy the signing secret into Vercel as
   `AFTERSHIP_WEBHOOK_SECRET`.
6. AfterShip's free plan covers a generous number of tracked shipments/month
   for a shop this size; if you outgrow it, TrackingMore, Shippo, and
   EasyPost all offer a very similar API shape if you'd rather switch later.

### Vercel Cron note

The daily fallback sweep (`/api/track-cron`, 1pm UTC) uses a Vercel Cron Job
(`vercel.json`). Vercel's free Hobby plan allows cron jobs to run once a day,
which is what this is set to — no paid plan required.

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
