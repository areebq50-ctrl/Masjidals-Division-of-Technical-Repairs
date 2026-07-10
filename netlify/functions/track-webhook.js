// POST /api/track-webhook -> /.netlify/functions/track-webhook
// Webhook receiver for AfterShip's "tracking update" event. Configure this URL
// (https://<your-netlify-domain>/api/track-webhook) in the AfterShip
// dashboard once deployed, and set AFTERSHIP_WEBHOOK_SECRET to the signing
// secret it gives you. This is what makes tracking update in near real time
// instead of waiting for the daily scheduled sweep (track-cron.js).
const crypto = require('crypto');
const { sbGet, sbPatch, sbPost, mapStatus, json } = require('./utils/shared');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    var secret = process.env.AFTERSHIP_WEBHOOK_SECRET;
    var rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    if (secret) {
      var signature = (event.headers || {})['aftership-hmac-sha256'];
      var expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
      if (!signature || signature !== expected) return json(401, { error: 'Invalid signature' });
    }

    var parsed = JSON.parse(rawBody || '{}');
    var msg = parsed.msg || parsed;
    var t = msg.tracking || msg;
    var trackingNumber = t.tracking_number;
    if (!trackingNumber) return json(200, { ok: true, ignored: true });

    var repairs = await sbGet('repairs', 'order=updatedAt.desc&limit=1000');
    var repair = repairs.find(function (r) { return r.tracking && r.tracking.indexOf(trackingNumber) !== -1; });
    if (!repair) return json(200, { ok: true, matched: false });

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

    return json(200, { ok: true, matched: true });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'Webhook processing failed', detail: String(e) });
  }
};
