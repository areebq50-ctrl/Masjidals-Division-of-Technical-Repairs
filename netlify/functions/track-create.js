// POST /api/track-create -> /.netlify/functions/track-create (see netlify.toml redirect)
// Body: { repairId, carrier, number, notes } — registers a shipment for live
// tracking and stores the result on the repair's `tracking` column.
// Prefers UPS's own free Tracking API when the carrier is UPS and
// UPS_CLIENT_ID/UPS_CLIENT_SECRET are set (no paid plan needed). Falls back
// to AfterShip (AFTERSHIP_API_KEY) for other carriers, or if UPS isn't
// configured. With neither configured, this just no-ops and the manual
// tracking info already saved by the client stays exactly as-is.
const { sbPatch, CARRIER_SLUGS, mapStatus, trackUpsDirect, json } = require('./utils/shared');

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
      checkpoints: [], slug: null, registered: false
    };

    // Preferred path: UPS direct (free).
    if (carrier === 'UPS') {
      var upsResult = await trackUpsDirect(number).catch(function (e) { console.error('UPS direct failed', e); return null; });
      if (upsResult) {
        var updatedUps = Object.assign({}, base, {
          slug: 'ups-direct',
          status: upsResult.statusTag,
          statusText: upsResult.statusText,
          statusColor: upsResult.statusColor,
          expectedDelivery: upsResult.expectedDelivery,
          lastCheckedAt: new Date().toISOString(),
          checkpoints: (upsResult.checkpoints || []).slice(-10).reverse(),
          registered: true,
          deliveredAt: upsResult.statusTag === 'Delivered' ? new Date().toISOString() : null
        });
        await sbPatch('repairs', repairId, { tracking: JSON.stringify(updatedUps), updatedAt: new Date().toISOString() });
        return json(200, { ok: true, registered: true, tracking: updatedUps });
      }
    }

    // Fallback: AfterShip.
    var apiKey = process.env.AFTERSHIP_API_KEY;
    if (!apiKey) {
      await sbPatch('repairs', repairId, { tracking: JSON.stringify(base), updatedAt: new Date().toISOString() });
      return json(200, { ok: true, registered: false, tracking: base });
    }

    var payload = { tracking: { tracking_number: number } };
    var slug = CARRIER_SLUGS[carrier];
    if (slug) payload.tracking.slug = slug;

    var r = await fetch('https://api.aftership.com/v4/trackings', {
      method: 'POST',
      headers: { 'aftership-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var data = await r.json();

    // 4003 = "already exists" - AfterShip already knows this tracking number, treat as success.
    var alreadyExists = data.meta && data.meta.code === 4003;
    if (!r.ok && !alreadyExists) {
      await sbPatch('repairs', repairId, { tracking: JSON.stringify(base), updatedAt: new Date().toISOString() });
      return json(200, { ok: true, registered: false, tracking: base, error: (data.meta || {}).message });
    }

    var t = (data.data && data.data.tracking) || {};
    var mapped = mapStatus(t.tag);
    var updated = Object.assign({}, base, {
      slug: t.slug || slug || null,
      status: t.tag || '',
      statusText: mapped.label,
      statusColor: mapped.color,
      expectedDelivery: t.expected_delivery || null,
      lastCheckedAt: new Date().toISOString(),
      checkpoints: (t.checkpoints || []).slice(-10).reverse(),
      registered: true,
      deliveredAt: t.tag === 'Delivered' ? new Date().toISOString() : null
    });

    await sbPatch('repairs', repairId, { tracking: JSON.stringify(updated), updatedAt: new Date().toISOString() });
    return json(200, { ok: true, registered: true, tracking: updated });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'Failed to register tracking', detail: String(e) });
  }
};
