// GET /api/shopify-install - one-time-use helper. Open this URL in a browser
// (logged into the store admin) to start the OAuth install for the Shopify
// custom-distribution app, since Shopify no longer offers a plain
// static-token custom app flow for this account. After approving, you land
// on /api/shopify-callback which shows the resulting access token once -
// copy it into SHOPIFY_ADMIN_TOKEN and you're done; this endpoint isn't
// needed again after that (lookup-customer.js only uses the static token).
const crypto = require('crypto');

exports.handler = async function (event) {
  var shop = process.env.SHOPIFY_STORE_DOMAIN;
  var apiKey = process.env.SHOPIFY_API_KEY;
  if (!shop || !apiKey) {
    return { statusCode: 400, headers: { 'Content-Type': 'text/html' }, body: '<p>Set SHOPIFY_STORE_DOMAIN and SHOPIFY_API_KEY in Netlify env vars first, then redeploy and reload this page.</p>' };
  }

  var siteUrl = process.env.URL || ('https://' + event.headers.host);
  var redirectUri = siteUrl + '/api/shopify-callback';
  var state = crypto.randomBytes(16).toString('hex');
  var scopes = 'read_orders';

  var authUrl = 'https://' + shop + '/admin/oauth/authorize?client_id=' + encodeURIComponent(apiKey) +
    '&scope=' + encodeURIComponent(scopes) +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&state=' + state;

  return {
    statusCode: 302,
    headers: {
      Location: authUrl,
      'Set-Cookie': 'shopify_oauth_state=' + state + '; Path=/; HttpOnly; Secure; Max-Age=600; SameSite=Lax'
    },
    body: ''
  };
};
