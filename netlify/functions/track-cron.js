// Scheduled Netlify Function (see netlify.toml "schedule") — runs daily.
// Re-checks every repair with an active (non-delivered) live tracking record,
// in case the AfterShip webhook was missed or never configured. This is what
// guarantees a shipment keeps getting checked all the way until it's marked
// Delivered. Also reachable manually at /api/track-cron for testing.
const { sbGet, sbPatch, sbPost, mapStatus, json } = require('./utils/shared');

exports.handler = async function () {
  var apiKey = process.env.AFTERSHIP_API_KEY;
  if (!apiKey) return json(200, { ok: true, skipped: 'Live tracking not configured yet' });

  try {
    var repairs = await sbGet('repairs', 'order=updatedAt.desc&limit=1000');
    var candidates = repairs.filter(function (r) {
      if (!r.tracking) return false;
      var tr;
      try { tr = typeof r.tracking === 'string' ? JSON.parse(r.tracking) : r.tracking; } catch (e) { return false; }
      return !!(tr && tr.slug && tr.status !== 'Delivered');
    });

    var results = [];
    for (var i = 0; i < candidates.length; i++) {
      var r = candidates[i];
      var tr = typeof r.tracking === 'string' ? JSON.parse(r.tracking) : r.tracking;
      try {
        var resp = await fetch('https://api.aftership.com/v4/trackings/' + tr.slug + '/' + encodeURIComponent(tr.number), {
          headers: { 'aftership-api-key': apiKey }
        });
        var data = await resp.json();
        if (!resp.ok) { results.push({ id: r.id, error: (data.meta || {}).message }); continue; }

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

        await sbPatch('repairs', r.id, { tracking: JSON.stringify(updated), updatedAt: new Date().toISOString() });

        if (!wasDelivered && t.tag === 'Delivered') {
          await sbPost('activity', { ticket: r.ticket, msg: 'Package delivered (' + updated.carrier + ' ' + updated.number + ')', by: 'system', at: new Date().toISOString() });
        }

        results.push({ id: r.id, status: t.tag });
      } catch (e) {
        results.push({ id: r.id, error: String(e) });
      }
    }

    return json(200, { ok: true, checked: candidates.length, results: results });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'Cron refresh failed', detail: String(e) });
  }
};
