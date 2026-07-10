// Shared helpers for the Netlify Functions in ../*.js. Lives in a subfolder
// so Netlify's function scanner doesn't try to turn it into its own endpoint.

// Same Supabase project the client (index.html) already talks to directly.
// Overridable via env vars if the key is ever rotated.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://aafszbfonkhwgiykwqrz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhZnN6YmZvbmtod2dpeWt3cXJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NDM3MDAsImV4cCI6MjA5MDAxOTcwMH0.Vrmdjzg0HPNoPqWr9pREsAx5THBk8hkjBERggwidTO8';

function sbHeaders(prefer) {
  var h = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' };
  if (prefer) h['Prefer'] = prefer;
  return h;
}

async function sbGet(table, query) {
  var url = SUPABASE_URL + '/rest/v1/' + table + '?select=*' + (query ? '&' + query : '');
  var r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase GET ' + table + ' failed: ' + r.status + ' ' + (await r.text()));
  return r.json();
}

async function sbPatch(table, id, obj) {
  var url = SUPABASE_URL + '/rest/v1/' + table + '?id=eq.' + encodeURIComponent(id);
  var r = await fetch(url, { method: 'PATCH', headers: sbHeaders('return=representation'), body: JSON.stringify(obj) });
  if (!r.ok) throw new Error('Supabase PATCH ' + table + ' failed: ' + r.status + ' ' + (await r.text()));
  return r.json();
}

async function sbPost(table, obj) {
  var url = SUPABASE_URL + '/rest/v1/' + table;
  var r = await fetch(url, { method: 'POST', headers: sbHeaders('return=representation'), body: JSON.stringify(obj) });
  if (!r.ok) throw new Error('Supabase POST ' + table + ' failed: ' + r.status + ' ' + (await r.text()));
  return r.json();
}

const CARRIER_SLUGS = { UPS: 'ups', FedEx: 'fedex', USPS: 'usps', DHL: 'dhl' };

const STATUS_MAP = {
  Pending: { label: 'Label Created', color: 'yellow' },
  InfoReceived: { label: 'Label Created', color: 'yellow' },
  InTransit: { label: 'In Transit', color: 'blue' },
  OutForDelivery: { label: 'Out for Delivery', color: 'purple' },
  AttemptFail: { label: 'Delivery Attempted', color: 'red' },
  Delivered: { label: 'Delivered', color: 'green' },
  Exception: { label: 'Exception', color: 'red' },
  Expired: { label: 'Tracking Expired', color: 'red' },
  AvailableForPickup: { label: 'Available for Pickup', color: 'purple' }
};

function mapStatus(tag) {
  return STATUS_MAP[tag] || { label: tag || 'Unknown', color: 'blue' };
}

function json(statusCode, obj) {
  return { statusCode: statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

// --- UPS direct tracking (free UPS Developer Kit API - no AfterShip needed) ---
// OAuth2 client_credentials token. Fetched fresh per request rather than
// cached, since these are short-lived serverless invocations - simpler and
// still well within UPS's rate limits for this shop's volume.
async function getUpsToken() {
  var id = process.env.UPS_CLIENT_ID, secret = process.env.UPS_CLIENT_SECRET;
  if (!id || !secret) return null;
  var auth = Buffer.from(id + ':' + secret).toString('base64');
  var r = await fetch('https://onlinetools.ups.com/security/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + auth },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) { console.error('UPS OAuth failed', r.status, await r.text()); return null; }
  var data = await r.json();
  return data.access_token || null;
}

const UPS_STATUS_MAP = {
  D: { label: 'Delivered', color: 'green' },
  I: { label: 'In Transit', color: 'blue' },
  M: { label: 'Label Created', color: 'yellow' },
  P: { label: 'Picked Up', color: 'blue' },
  X: { label: 'Exception', color: 'red' }
};

// Returns the same normalized shape the AfterShip path uses
// ({statusTag, statusText, statusColor, expectedDelivery, checkpoints}) so
// the rest of the app doesn't need to know which backend served it.
async function trackUpsDirect(trackingNumber) {
  var token = await getUpsToken();
  if (!token) return null;
  var r = await fetch('https://onlinetools.ups.com/api/track/v1/details/' + encodeURIComponent(trackingNumber), {
    headers: { Authorization: 'Bearer ' + token, transId: 'dtr-' + Date.now(), transactionSrc: 'MasjidalDTR' }
  });
  if (!r.ok) { console.error('UPS tracking lookup failed', r.status, await r.text()); return null; }
  var data = await r.json();
  var shipment = data.trackResponse && data.trackResponse.shipment && data.trackResponse.shipment[0];
  var pkg = shipment && shipment.package && shipment.package[0];
  if (!pkg) return null;

  var cur = pkg.currentStatus || {};
  var mapped = UPS_STATUS_MAP[cur.type] || { label: cur.description || 'Unknown', color: 'blue' };

  function toIso(dateStr, timeStr) {
    if (!dateStr) return null;
    var d = dateStr.substring(0, 4) + '-' + dateStr.substring(4, 6) + '-' + dateStr.substring(6, 8);
    if (!timeStr) return d;
    return d + 'T' + timeStr.substring(0, 2) + ':' + timeStr.substring(2, 4) + ':' + timeStr.substring(4, 6) + 'Z';
  }

  var checkpoints = (pkg.activity || []).map(function (a) {
    var addr = a.location && a.location.address;
    var loc = addr ? [addr.city, addr.stateProvince, addr.country].filter(Boolean).join(', ') : '';
    return { message: (a.status && a.status.description) || '', city: loc, checkpoint_time: toIso(a.date, a.time) };
  });

  var deliveryDateRaw = pkg.deliveryDate && pkg.deliveryDate[0] && pkg.deliveryDate[0].date;

  return {
    statusTag: cur.type === 'D' ? 'Delivered' : mapped.label,
    statusText: mapped.label,
    statusColor: mapped.color,
    expectedDelivery: toIso(deliveryDateRaw),
    checkpoints: checkpoints
  };
}

module.exports = { sbGet, sbPatch, sbPost, CARRIER_SLUGS, STATUS_MAP, mapStatus, json, trackUpsDirect, SUPABASE_URL, SUPABASE_KEY };
