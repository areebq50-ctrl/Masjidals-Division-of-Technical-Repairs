// POST /api/track-refresh -> /.netlify/functions/track-refresh
// Body: { repairId } — on-demand refresh, used by the "Refresh Status" button
// in the ticket detail view (and "Refresh All" on the In Transit page).
// Uses the direct carrier API (free, UPS/FedEx) whenever the tracking
// record's carrier has one, Shippo (free, USPS/DHL) otherwise - retried
// even if a previous attempt failed to register (worth retrying, e.g. after
// fixing credentials), not gated on a prior success.
const { sbGet, sbPatch, sbPost, lookupTracking, isTrackable, json } = require('./utils/shared');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    var repairId = JSON.parse(event.body || '{}').repairId;
    if (!repairId) return json(400, { error: 'repairId is required' });

    var rows = await sbGet('repairs', 'id=eq.' + encodeURIComponent(repairId));
    var repair = rows[0];
    if (!repair || !repair.tracking) return json(404, { error: 'No tracking on this repair' });

    var tr = typeof repair.tracking === 'string' ? JSON.parse(repair.tracking) : repair.tracking;
    // Retry based on whether this carrier CAN be tracked, not on tr.slug -
    // if the first attempt failed (bad creds, app not yet approved, etc.)
    // slug never got set, so gating on slug here would permanently give up
    // even after the underlying problem is fixed.
    if (!isTrackable(tr.carrier) && !tr.slug) return json(200, { ok: true, registered: false, message: 'Not registered for live tracking yet' });

    var wasDelivered = tr.status === 'Delivered';
    var outcome;
    try {
      outcome = await lookupTracking(tr.carrier, tr.number);
    } catch (e) {
      var failedTr = Object.assign({}, tr, { lastError: e.message });
      await sbPatch('repairs', repairId, { tracking: JSON.stringify(failedTr), updatedAt: new Date().toISOString() });
      return json(502, { error: tr.carrier + ' lookup failed', detail: e.message });
    }
    if (!outcome) return json(200, { ok: true, registered: false, message: tr.carrier + ' tracking is not configured yet - see SETUP.md.' });

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
