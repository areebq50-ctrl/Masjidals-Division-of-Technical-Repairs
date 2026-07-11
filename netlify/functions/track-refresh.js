// POST /api/track-refresh -> /.netlify/functions/track-refresh
// Body: { repairId } — on-demand refresh, used by the "Refresh Status" button
// in the ticket detail view. Uses UPS direct (free) whenever the tracking
// record's carrier is UPS (even if a previous attempt failed to register -
// worth retrying, e.g. after fixing UPS credentials), otherwise AfterShip.
const { sbGet, sbPatch, sbPost, mapStatus, trackUpsDirect, json } = require('./utils/shared');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    var repairId = JSON.parse(event.body || '{}').repairId;
    if (!repairId) return json(400, { error: 'repairId is required' });

    var rows = await sbGet('repairs', 'id=eq.' + encodeURIComponent(repairId));
    var repair = rows[0];
    if (!repair || !repair.tracking) return json(404, { error: 'No tracking on this repair' });

    var tr = typeof repair.tracking === 'string' ? JSON.parse(repair.tracking) : repair.tracking;
    // Retry on carrier, not on tr.slug - if UPS failed the first time (bad
    // creds, app not yet approved, etc.) slug never got set to 'ups-direct',
    // so gating on slug here would permanently give up on it even after the
    // underlying problem is fixed.
    if (tr.carrier !== 'UPS' && !tr.slug) return json(200, { ok: true, registered: false, message: 'Not registered for live tracking yet' });

    var wasDelivered = tr.status === 'Delivered';
    var updated;

    if (tr.carrier === 'UPS') {
      var upsResult;
      try {
        upsResult = await trackUpsDirect(tr.number);
      } catch (e) {
        var upsFailedTr = Object.assign({}, tr, { lastError: e.message });
        await sbPatch('repairs', repairId, { tracking: JSON.stringify(upsFailedTr), updatedAt: new Date().toISOString() });
        return json(502, { error: 'UPS lookup failed', detail: e.message });
      }
      if (!upsResult) return json(200, { ok: true, registered: false, message: 'UPS tracking is not configured yet - add UPS_CLIENT_ID/UPS_CLIENT_SECRET in Netlify.' });
      updated = Object.assign({}, tr, {
        slug: 'ups-direct', registered: true, lastError: null,
        status: upsResult.statusTag,
        statusText: upsResult.statusText,
        statusColor: upsResult.statusColor,
        expectedDelivery: upsResult.expectedDelivery || tr.expectedDelivery,
        lastCheckedAt: new Date().toISOString(),
        checkpoints: (upsResult.checkpoints || []).slice(-10).reverse(),
        deliveredAt: upsResult.statusTag === 'Delivered' ? (tr.deliveredAt || new Date().toISOString()) : tr.deliveredAt
      });
    } else {
      var apiKey = process.env.AFTERSHIP_API_KEY;
      if (!apiKey) return json(200, { ok: true, registered: false, message: 'Live tracking not configured yet' });

      var r = await fetch('https://api.aftership.com/v4/trackings/' + tr.slug + '/' + encodeURIComponent(tr.number), {
        headers: { 'aftership-api-key': apiKey }
      });
      var data = await r.json();
      if (!r.ok) return json(502, { error: 'AfterShip lookup failed', detail: (data.meta || {}).message });

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

    await sbPatch('repairs', repairId, { tracking: JSON.stringify(updated), updatedAt: new Date().toISOString() });

    if (!wasDelivered && updated.status === 'Delivered') {
      await sbPost('activity', { ticket: repair.ticket, msg: 'Package delivered (' + updated.carrier + ' ' + updated.number + ')', by: 'system', at: new Date().toISOString() });
    }

    return json(200, { ok: true, registered: true, tracking: updated });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'Failed to refresh tracking', detail: String(e) });
  }
};
