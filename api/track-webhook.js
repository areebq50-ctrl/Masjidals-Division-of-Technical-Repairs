// Webhook receiver for AfterShip's "tracking update" event. Configure this URL
// (https://<your-domain>/api/track-webhook) in the AfterShip dashboard once
// deployed, and set AFTERSHIP_WEBHOOK_SECRET to the signing secret it gives you.
// This is what makes tracking update in near real time instead of waiting for
// the daily cron fallback (track-cron.js).
const crypto = require('crypto');
const { sbGet, sbPatch, sbPost, mapStatus } = require('./_shared');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    var secret = process.env.AFTERSHIP_WEBHOOK_SECRET;
    var rawBody = JSON.stringify(req.body || {});
    if (secret) {
      var signature = req.headers['aftership-hmac-sha256'];
      var expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
      if (!signature || signature !== expected) { res.status(401).json({ error: 'Invalid signature' }); return; }
    }

    var msg = (req.body && (req.body.msg || req.body)) || {};
    var t = msg.tracking || msg;
    var trackingNumber = t.tracking_number;
    if (!trackingNumber) { res.status(200).json({ ok: true, ignored: true }); return; }

    var repairs = await sbGet('repairs', 'order=updatedAt.desc&limit=1000');
    var repair = repairs.find(function (r) { return r.tracking && r.tracking.indexOf(trackingNumber) !== -1; });
    if (!repair) { res.status(200).json({ ok: true, matched: false }); return; }

    var tr = typeof repair.tracking === 'string' ? JSON.parse(repair.tracking) : repair.tracking;
    var mapped = mapStatus(t.tag);
    var wasDelivered = tr.status === 'Delivered';
    var updated = Object.assign({}, tr, {
      slug: t.slug || tr.slug,
      status: t.tag || tr.status,
      statusText: mapped.label,
      statusColor: mapped.color,
      expectedDelivery: t.expected_delivery || tr.expectedDelivery,
      lastCheckedAt: new Date().toISOString(),
      checkpoints: (t.checkpoints || tr.checkpoints || []).slice(-10).reverse(),
      deliveredAt: t.tag === 'Delivered' ? (tr.deliveredAt || new Date().toISOString()) : tr.deliveredAt
    });

    await sbPatch('repairs', repair.id, { tracking: JSON.stringify(updated), updatedAt: new Date().toISOString() });

    if (!wasDelivered && t.tag === 'Delivered') {
      await sbPost('activity', { ticket: repair.ticket, msg: 'Package delivered (' + updated.carrier + ' ' + updated.number + ')', by: 'system', at: new Date().toISOString() });
    }

    res.status(200).json({ ok: true, matched: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Webhook processing failed', detail: String(e) });
  }
};
