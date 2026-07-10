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

module.exports = { sbGet, sbPatch, sbPost, CARRIER_SLUGS, STATUS_MAP, mapStatus, json, SUPABASE_URL, SUPABASE_KEY };
