// Scheduled Netlify Function (see netlify.toml "schedule") — runs hourly.
// Re-checks every repair with an active (non-delivered) live tracking record
// - the direct carrier API (free, UPS/FedEx) when the carrier has one
// (retried even if a previous attempt failed to register), Shippo (free,
// USPS/DHL) otherwise. This is what guarantees a shipment keeps getting
// checked all the way until it's marked Delivered.
// Netlify blocks triggering scheduled functions via a direct URL in
// production - to run this on demand, use Netlify -> Functions -> track-cron
// -> "Run now" in the dashboard instead.
const { sbGet, sbPatch, sbPost, lookupTracking, isTrackable, json } = require('./utils/shared');

exports.handler = async function () {
  var anyConfigured = !!(process.env.UPS_CLIENT_ID && process.env.UPS_CLIENT_SECRET) ||
    !!(process.env.FEDEX_CLIENT_ID && process.env.FEDEX_CLIENT_SECRET) || !!process.env.SHIPPO_API_KEY;
  if (!anyConfigured) return json(200, { ok: true, skipped: 'Live tracking not configured yet' });

  try {
    var repairs = await sbGet('repairs', 'order=updatedAt.desc&limit=1000');
    var candidates = repairs.filter(function (r) {
      if (!r.tracking) return false;
      var tr;
      try { tr = typeof r.tracking === 'string' ? JSON.parse(r.tracking) : r.tracking; } catch (e) { return false; }
      // Include trackable-carrier repairs even if slug never got set (a
      // failed registration shouldn't permanently exclude it from retries).
      return !!(tr && (tr.slug || isTrackable(tr.carrier)) && tr.status !== 'Delivered');
    });

    var results = [];
    for (var i = 0; i < candidates.length; i++) {
      var r = candidates[i];
      var tr = typeof r.tracking === 'string' ? JSON.parse(r.tracking) : r.tracking;
      var wasDelivered = tr.status === 'Delivered';
      try {
        if (!isTrackable(tr.carrier)) { results.push({ id: r.id, skipped: 'No tracking source for ' + tr.carrier }); continue; }

        var outcome;
        try {
          outcome = await lookupTracking(tr.carrier, tr.number);
        } catch (e) {
          await sbPatch('repairs', r.id, { tracking: JSON.stringify(Object.assign({}, tr, { lastError: e.message })), updatedAt: new Date().toISOString() });
          results.push({ id: r.id, error: e.message });
          continue;
        }
        if (!outcome) { results.push({ id: r.id, skipped: tr.carrier + ' not configured' }); continue; }

        var updated = Object.assign({}, tr, {
          slug: outcome.slug, registered: true, lastError: null,
          status: outcome.result.statusTag,
          statusText: outcome.result.statusText,
          statusColor: outcome.result.statusColor,
          expectedDelivery: outcome.result.expectedDelivery || tr.expectedDelivery,
          lastCheckedAt: new Date().toISOString(),
          checkpoints: (outcome.result.checkpoints || []).slice(-10).reverse(),
          deliveredAt: outcome.result.statusTag === 'Delivered' ? (tr.deliveredAt || new Date().toISOString()) : tr.deliveredAt
        });

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
