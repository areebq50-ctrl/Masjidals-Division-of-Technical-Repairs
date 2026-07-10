// POST /api/track-refresh -> /.netlify/functions/track-refresh
// Body: { repairId } — on-demand refresh, used by the "Refresh Status" button
// in the ticket detail view. Uses UPS direct (free) if this tracking was
// registered that way (tr.slug === 'ups-direct'), otherwise AfterShip.
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
    if (!tr.slug) return json(200, { ok: true, registered: false, message: 'Not registered for live tracking yet' });

    var wasDelivered = tr.status === 'Delivered';
    var updated;

    if (tr.slug === 'ups-direct') {
      var upsResult = await trackUpsDirect(tr.number);
      if (!upsResult) return json(502, { error: 'UPS lookup failed - check UPS_CLIENT_ID/UPS_CLIENT_SECRET' });
      updated = Object.assign({}, tr, {
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
