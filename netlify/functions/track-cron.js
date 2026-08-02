// Scheduled Netlify Function (see netlify.toml "schedule") — runs daily.
// Re-checks every repair with an active (non-delivered) live tracking record
// - the direct carrier API (free, UPS/FedEx) when the carrier has one
// (retried even if a previous attempt failed to register), AfterShip
// otherwise - in case a webhook was missed or never configured. This is
// what guarantees a shipment keeps getting checked all the way until it's
// marked Delivered.
// Netlify blocks triggering scheduled functions via a direct URL in
// production - to run this on demand, use Netlify -> Functions -> track-cron
// -> "Run now" in the dashboard instead.
const { sbGet, sbPatch, sbPost, mapStatus, trackDirect, DIRECT_TRACKERS, json } = require('./utils/shared');

exports.handler = async function () {
  var hasUps = !!(process.env.UPS_CLIENT_ID && process.env.UPS_CLIENT_SECRET);
  var hasFedex = !!(process.env.FEDEX_CLIENT_ID && process.env.FEDEX_CLIENT_SECRET);
  var hasAfterShip = !!process.env.AFTERSHIP_API_KEY;
  if (!hasUps && !hasFedex && !hasAfterShip) return json(200, { ok: true, skipped: 'Live tracking not configured yet' });

  var directConfigured = { UPS: hasUps, FedEx: hasFedex };

  try {
    var repairs = await sbGet('repairs', 'order=updatedAt.desc&limit=1000');
    var candidates = repairs.filter(function (r) {
      if (!r.tracking) return false;
      var tr;
      try { tr = typeof r.tracking === 'string' ? JSON.parse(r.tracking) : r.tracking; } catch (e) { return false; }
      // Include direct-carrier repairs even if slug never got set (a failed
      // registration shouldn't permanently exclude it from retries).
      return !!(tr && (tr.slug || DIRECT_TRACKERS[tr.carrier]) && tr.status !== 'Delivered');
    });

    var results = [];
    for (var i = 0; i < candidates.length; i++) {
      var r = candidates[i];
      var tr = typeof r.tracking === 'string' ? JSON.parse(r.tracking) : r.tracking;
      var wasDelivered = tr.status === 'Delivered';
      try {
        var updated;

        if (DIRECT_TRACKERS[tr.carrier]) {
          if (!directConfigured[tr.carrier]) { results.push({ id: r.id, skipped: tr.carrier + ' not configured' }); continue; }
          var direct;
          try {
            direct = await trackDirect(tr.carrier, tr.number);
          } catch (e) {
            await sbPatch('repairs', r.id, { tracking: JSON.stringify(Object.assign({}, tr, { lastError: e.message })), updatedAt: new Date().toISOString() });
            results.push({ id: r.id, error: e.message });
            continue;
          }
          updated = Object.assign({}, tr, {
            slug: direct.slug, registered: true, lastError: null,
            status: direct.result.statusTag,
            statusText: direct.result.statusText,
            statusColor: direct.result.statusColor,
            expectedDelivery: direct.result.expectedDelivery || tr.expectedDelivery,
            lastCheckedAt: new Date().toISOString(),
            checkpoints: (direct.result.checkpoints || []).slice(-10).reverse(),
            deliveredAt: direct.result.statusTag === 'Delivered' ? (tr.deliveredAt || new Date().toISOString()) : tr.deliveredAt
          });
        } else {
          if (!hasAfterShip) { results.push({ id: r.id, skipped: 'AfterShip not configured' }); continue; }
          var resp = await fetch('https://api.aftership.com/v4/trackings/' + tr.slug + '/' + encodeURIComponent(tr.number), {
            headers: { 'aftership-api-key': process.env.AFTERSHIP_API_KEY }
          });
          var data = await resp.json();
          if (!resp.ok) { results.push({ id: r.id, error: (data.meta || {}).message }); continue; }

          var t = (data.data && data.data.tracking) || {};
          var mapped = mapStatus(t.tag);
          updated = Object.assign({}, tr, {
            status: t.tag || tr.status,
            statusText: mapped.label,
            statusColor: mapped.color,
            expectedDelivery: t.expected_delivery || tr.expectedDelivery,
            lastCheckedAt: new Date().toISOString(),
            checkpoints: (t.checkpoints || []).slice(-10).reverse(),
            deliveredAt: t.tag === 'Delivered' ? (tr.deliveredAt || new Date().toISOString()) : tr.deliveredAt
          });
        }

        await sbPatch('repairs', r.id, { tracking: JSON.stringify(updated), updatedAt: new Date().toISOString() });

        if (!wasDelivered && updated.status === 'Delivered') {
          await sbPost('activity', { ticket: r.ticket, msg: 'Package delivered (' + updated.carrier + ' ' + updated.number + ')', by: 'system', at: new Date().toISOString() });
        }

        results.push({ id: r.id, status: updated.status });
      } catch (e) {
        results.push({ id: r.id, error: String(e) });
      }
    }

    return json(200, { ok: true, checked: candidates.length, results: results });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'Cron refresh failed', detail: String(e) });
  }
};
