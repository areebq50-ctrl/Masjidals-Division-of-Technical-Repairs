// POST { repairId, carrier, number, notes } — registers a shipment with AfterShip
// (if configured) and stores the result on the repair's `tracking` column.
// With no AFTERSHIP_API_KEY set, this just no-ops and the manual tracking info
// already saved by the client stays exactly as-is - nothing breaks.
const { sbPatch, CARRIER_SLUGS, mapStatus } = require('./_shared');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    var body = req.body || {};
    var repairId = body.repairId, carrier = body.carrier, number = body.number, notes = body.notes || '';
    if (!repairId || !number) { res.status(400).json({ error: 'repairId and number are required' }); return; }

    var base = {
      carrier: carrier, number: number, notes: notes,
      status: '', statusText: 'Not yet tracked live', statusColor: 'blue',
      lastCheckedAt: null, expectedDelivery: null, deliveredAt: null,
      checkpoints: [], slug: null, registered: false
    };

    var apiKey = process.env.AFTERSHIP_API_KEY;
    if (!apiKey) {
      await sbPatch('repairs', repairId, { tracking: JSON.stringify(base), updatedAt: new Date().toISOString() });
      res.status(200).json({ ok: true, registered: false, tracking: base });
      return;
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
      res.status(200).json({ ok: true, registered: false, tracking: base, error: (data.meta || {}).message });
      return;
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
    res.status(200).json({ ok: true, registered: true, tracking: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to register tracking', detail: String(e) });
  }
};
