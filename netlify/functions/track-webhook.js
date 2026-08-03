// POST /api/track-webhook -> /.netlify/functions/track-webhook
// Webhook receiver for Shippo's "track_updated" event. Optional - the hourly
// scheduled sweep (track-cron.js) and the "Refresh Status"/"Refresh All"
// buttons already keep tracking current, this just makes updates near-
// instant instead of waiting for those. Configure this URL
// (https://<your-netlify-domain>/api/track-webhook) under Settings ->
// Webhooks in the Shippo dashboard once deployed.
// Shippo doesn't sign webhook payloads with an HMAC the way some providers
// do, so verification here is a shared secret you choose yourself: set
// SHIPPO_WEBHOOK_SECRET, then append ?secret=<that value> to the webhook
// URL you register in Shippo's dashboard. If SHIPPO_WEBHOOK_SECRET isn't
// set, the webhook is accepted unauthenticated (fine for a low-stakes,
// read-only endpoint, but worth setting for real use).
const { sbGet, sbPatch, sbPost, normalizeShippoTrack, json } = require('./utils/shared');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    var secret = process.env.SHIPPO_WEBHOOK_SECRET;
    if (secret) {
      var provided = (event.queryStringParameters || {}).secret;
      if (provided !== secret) return json(401, { error: 'Invalid or missing secret' });
    }

    var rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    var parsed = JSON.parse(rawBody || '{}');
    var data = parsed.data || parsed;
    var trackingNumber = data.tracking_number;
    if (!trackingNumber) return json(200, { ok: true, ignored: true });

    var repairs = await sbGet('repairs', 'order=updatedAt.desc&limit=1000');
    var repair = repairs.find(function (r) { return r.tracking && r.tracking.indexOf(trackingNumber) !== -1; });
    if (!repair) return json(200, { ok: true, matched: false });

    var tr = typeof repair.tracking === 'string' ? JSON.parse(repair.tracking) : repair.tracking;
    var wasDelivered = tr.status === 'Delivered';
    var normalized = normalizeShippoTrack(data);
    var updated = Object.assign({}, tr, {
      slug: tr.slug || ('shippo:' + tr.carrier), registered: true, lastError: null,
      status: normalized.statusTag,
      statusText: normalized.statusText,
      statusColor: normalized.statusColor,
      expectedDelivery: normalized.expectedDelivery || tr.expectedDelivery,
      lastCheckedAt: new Date().toISOString(),
      checkpoints: normalized.checkpoints.length ? normalized.checkpoints : tr.checkpoints,
      deliveredAt: normalized.statusTag === 'Delivered' ? (tr.deliveredAt || new Date().toISOString()) : tr.deliveredAt
    });

    await sbPatch('repairs', repair.id, { tracking: JSON.stringify(updated), updatedAt: new Date().toISOString() });

    if (!wasDelivered && updated.status === 'Delivered') {
      await sbPost('activity', { ticket: repair.ticket, msg: 'Package delivered (' + updated.carrier + ' ' + updated.number + ')', by: 'system', at: new Date().toISOString() });
    }

    return json(200, { ok: true, matched: true });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'Webhook processing failed', detail: String(e) });
  }
};
