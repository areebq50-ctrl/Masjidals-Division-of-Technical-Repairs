// POST /api/track-create -> /.netlify/functions/track-create (see netlify.toml redirect)
// Body: { repairId, carrier, number, notes } — registers a shipment for live
// tracking and stores the result on the repair's `tracking` column.
// Prefers UPS/FedEx's own free Tracking APIs directly when the carrier is
// one of those and configured (UPS_CLIENT_ID/UPS_CLIENT_SECRET or
// FEDEX_CLIENT_ID/FEDEX_CLIENT_SECRET - no paid plan needed); otherwise
// (including USPS/DHL, which have no direct integration, or UPS/FedEx when
// the direct API isn't set up) falls back to Shippo (SHIPPO_API_KEY), also
// free. A carrier with something configured is never silently skipped - a
// real failure is reported back as `error`/`tracking.lastError` instead.
// With nothing configured at all for the given carrier, this just no-ops
// and the manual tracking info already saved by the client stays as-is.
const { sbPatch, lookupTracking, json } = require('./utils/shared');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    var body = JSON.parse(event.body || '{}');
    var repairId = body.repairId, carrier = body.carrier, number = body.number, notes = body.notes || '';
    if (!repairId || !number) return json(400, { error: 'repairId and number are required' });

    var base = {
      carrier: carrier, number: number, notes: notes,
      status: '', statusText: 'Not yet tracked live', statusColor: 'blue',
      lastCheckedAt: null, expectedDelivery: null, deliveredAt: null,
      checkpoints: [], slug: null, registered: false, lastError: null
    };

    async function save(tracking) {
      await sbPatch('repairs', repairId, { tracking: JSON.stringify(tracking), updatedAt: new Date().toISOString() });
    }

    var outcome;
    try {
      outcome = await lookupTracking(carrier, number);
    } catch (e) {
      // A thrown error is a real failure (bad credentials, app not
      // approved, bad tracking number, etc.) - surface it instead of
      // silently doing nothing.
      console.error(carrier + ' tracking failed', e);
      var failed = Object.assign({}, base, { lastError: e.message });
      await save(failed);
      return json(200, { ok: true, registered: false, tracking: failed, error: e.message });
    }

    if (!outcome) {
      // Nothing configured for this carrier at all - no-op, keep the manual info as-is.
      await save(base);
      return json(200, { ok: true, registered: false, tracking: base });
    }

    var updated = Object.assign({}, base, {
      slug: outcome.slug,
      status: outcome.result.statusTag,
      statusText: outcome.result.statusText,
      statusColor: outcome.result.statusColor,
      expectedDelivery: outcome.result.expectedDelivery,
      lastCheckedAt: new Date().toISOString(),
      checkpoints: (outcome.result.checkpoints || []).slice(-10).reverse(),
      registered: true,
      deliveredAt: outcome.result.statusTag === 'Delivered' ? new Date().toISOString() : null
    });
    await save(updated);
    return json(200, { ok: true, registered: true, tracking: updated });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'Failed to register tracking', detail: String(e) });
  }
};
