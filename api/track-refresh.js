// POST { repairId } — on-demand refresh, used by the "Refresh Status" button
// in the ticket detail view. Looks up the latest status from AfterShip and
// writes it back onto the repair's `tracking` column.
const { sbGet, sbPatch, sbPost, mapStatus } = require('./_shared');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    var repairId = (req.body || {}).repairId;
    if (!repairId) { res.status(400).json({ error: 'repairId is required' }); return; }

    var apiKey = process.env.AFTERSHIP_API_KEY;
    if (!apiKey) { res.status(200).json({ ok: true, registered: false, message: 'Live tracking not configured yet' }); return; }

    var rows = await sbGet('repairs', 'id=eq.' + encodeURIComponent(repairId));
    var repair = rows[0];
    if (!repair || !repair.tracking) { res.status(404).json({ error: 'No tracking on this repair' }); return; }

    var tr = typeof repair.tracking === 'string' ? JSON.parse(repair.tracking) : repair.tracking;
    if (!tr.slug) { res.status(200).json({ ok: true, registered: false, message: 'Not registered with AfterShip yet' }); return; }

    var r = await fetch('https://api.aftership.com/v4/trackings/' + tr.slug + '/' + encodeURIComponent(tr.number), {
      headers: { 'aftership-api-key': apiKey }
    });
    var data = await r.json();
    if (!r.ok) { res.status(502).json({ error: 'AfterShip lookup failed', detail: (data.meta || {}).message }); return; }

    var t = (data.data && data.data.tracking) || {};
    var mapped = mapStatus(t.tag);
    var wasDelivered = tr.status === 'Delivered';
    var updated = Object.assign({}, tr, {
      status: t.tag || tr.status,
      statusText: mapped.label,
      statusColor: mapped.color,
      expectedDelivery: t.expected_delivery || tr.expectedDelivery,
      lastCheckedAt: new Date().toISOString(),
      checkpoints: (t.checkpoints || []).slice(-10).reverse(),
      deliveredAt: t.tag === 'Delivered' ? (tr.deliveredAt || new Date().toISOString()) : tr.deliveredAt
    });

    await sbPatch('repairs', repairId, { tracking: JSON.stringify(updated), updatedAt: new Date().toISOString() });

    if (!wasDelivered && t.tag === 'Delivered') {
      await sbPost('activity', { ticket: repair.ticket, msg: 'Package delivered (' + updated.carrier + ' ' + updated.number + ')', by: 'system', at: new Date().toISOString() });
    }

    res.status(200).json({ ok: true, registered: true, tracking: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to refresh tracking', detail: String(e) });
  }
};
