// GET /api/shopify-callback - Shopify redirects here after you approve the
// install at /api/shopify-install. Verifies the request really came from
// Shopify (HMAC + state check), exchanges the one-time code for a permanent
// Admin API access token, and displays it once so you can copy it into
// SHOPIFY_ADMIN_TOKEN. Nothing here is stored - if you lose the token before
// copying it, just visit /api/shopify-install again.
const crypto = require('crypto');

function verifyHmac(query, secret) {
  var hmac = query.hmac;
  if (!hmac) return false;
  var params = Object.keys(query).filter(function (k) { return k !== 'hmac' && k !== 'signature'; }).sort();
  var message = params.map(function (k) { return k + '=' + query[k]; }).join('&');
  var digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  try {
    return digest.length === hmac.length && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
  } catch (e) { return false; }
}

function page(body) {
  return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: '<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:60px auto;line-height:1.6">' + body + '</body></html>' };
}

exports.handler = async function (event) {
  try {
    var query = event.queryStringParameters || {};
    var apiKey = process.env.SHOPIFY_API_KEY;
    var apiSecret = process.env.SHOPIFY_API_SECRET;
    if (!apiKey || !apiSecret) return page('<p>SHOPIFY_API_KEY / SHOPIFY_API_SECRET not set in Netlify env vars.</p>');

    var cookieHeader = event.headers.cookie || event.headers.Cookie || '';
    var cookieMatch = cookieHeader.match(/shopify_oauth_state=([^;]+)/);
    var cookieState = cookieMatch ? cookieMatch[1] : null;
    if (!query.state || query.state !== cookieState) {
      return page('<p>State check failed - please restart by visiting <a href="/api/shopify-install">/api/shopify-install</a> again.</p>');
    }

    if (!verifyHmac(query, apiSecret)) {
      return page('<p>Request signature did not verify - this did not come from Shopify as expected. Nothing was changed.</p>');
    }

    var shop = query.shop, code = query.code;
    if (!shop || !code) return page('<p>Missing shop or code in the callback.</p>');

    var tokenResp = await fetch('https://' + shop + '/admin/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code: code })
    });
    if (!tokenResp.ok) {
      var errText = await tokenResp.text();
      return page('<p>Token exchange failed: ' + errText.replace(/</g, '&lt;') + '</p>');
    }
    var tokenData = await tokenResp.json();
    var accessToken = tokenData.access_token;
    if (!accessToken) return page('<p>Shopify did not return an access token. Response: ' + JSON.stringify(tokenData).replace(/</g, '&lt;') + '</p>');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'shopify_oauth_state=; Path=/; Max-Age=0' },
      body: '<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:60px auto;line-height:1.6">' +
        '<h2>Shopify app installed</h2>' +
        '<p>Copy this into Netlify as <strong>SHOPIFY_ADMIN_TOKEN</strong> (Site configuration &rarr; Environment variables), then redeploy. This page will not show the token again.</p>' +
        '<pre style="background:#f3f3f3;padding:16px;border-radius:8px;word-break:break-all;user-select:all;font-size:14px">' + accessToken + '</pre>' +
        '<p>Also make sure <strong>SHOPIFY_STORE_DOMAIN</strong> is set to <code>' + shop + '</code>.</p>' +
        '</body></html>'
    };
  } catch (e) {
    console.error(e);
    return page('<p>Error: ' + String(e).replace(/</g, '&lt;') + '</p>');
  }
};
