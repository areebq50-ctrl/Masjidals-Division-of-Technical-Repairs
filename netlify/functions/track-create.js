// POST /api/track-create -> /.netlify/functions/track-create (see netlify.toml redirect)
// Body: { repairId, carrier, number, notes } — registers a shipment for live
// tracking and stores the result on the repair's `tracking` column.
// Uses UPS/FedEx's own free Tracking APIs directly when the carrier is one
// of those (requires UPS_CLIENT_ID/UPS_CLIENT_SECRET or
// FEDEX_CLIENT_ID/FEDEX_CLIENT_SECRET - no paid plan needed); a carrier with
// a direct integration is never silently skipped in favor of AfterShip - a
// real failure is reported back as `error`/`tracking.lastError` instead.
// Other carriers use AfterShip (AFTERSHIP_API_KEY) if configured. With
// nothing configured for the given carrier, this just no-ops and the manual
// tracking info already saved by the client stays exactly as-is.
const { sbPatch, CARRIER_SLUGS, mapStatus, trackDirect, DIRECT_TRACKERS, json } = require('./utils/shared');

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

    // Preferred path: direct carrier API (free, UPS/FedEx). A thrown error
    // here is a real failure (bad credentials, app not approved, bad
    // tracking number, etc.) - surface it instead of silently falling
    // through, so it doesn't masquerade as "AfterShip isn't configured"
    // when AfterShip was never the intended path at all.
    if (DIRECT_TRACKERS[carrier]) {
      try {
        var direct = await trackDirect(carrier, number);
        if (direct) {
          var updatedDirect = Object.assign({}, base, {
            slug: direct.slug,
            status: direct.result.statusTag,
            statusText: direct.result.statusText,
            statusColor: direct.result.statusColor,
            expectedDelivery: direct.result.expectedDelivery,
            lastCheckedAt: new Date().toISOString(),
            checkpoints: (direct.result.checkpoints || []).slice(-10).reverse(),
            registered: true,
            deliveredAt: direct.result.statusTag === 'Delivered' ? new Date().toISOString() : null
          });
          await sbPatch('repairs', repairId, { tracking: JSON.stringify(updatedDirect), updatedAt: new Date().toISOString() });
          return json(200, { ok: true, registered: true, tracking: updatedDirect });
        }
      } catch (e) {
        console.error(carrier + ' direct tracking failed', e);
        var directFailedBase = Object.assign({}, base, { lastError: e.message });
        await sbPatch('repairs', repairId, { tracking: JSON.stringify(directFailedBase), updatedAt: new Date().toISOString() });
        return json(200, { ok: true, registered: false, tracking: directFailedBase, error: e.message });
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
      var afterShipFailedBase = Object.assign({}, base, { lastError: (data.meta || {}).message || null });
      await sbPatch('repairs', repairId, { tracking: JSON.stringify(afterShipFailedBase), updatedAt: new Date().toISOString() });
      return json(200, { ok: true, registered: false, tracking: afterShipFailedBase, error: (data.meta || {}).message });
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
