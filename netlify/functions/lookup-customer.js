// POST /api/lookup-customer -> /.netlify/functions/lookup-customer
// Body: { zdid, ordnum } - looks up customer name/email/phone from Zendesk
// (by ticket ID) and/or Shopify (by order number). Read-only: never writes
// anything back to Zendesk/Shopify. Fails gracefully (found:false) if the
// relevant env vars aren't configured, so the "Look up customer" button in
// the app just quietly does nothing until you set these up - see SETUP.md.
const { json } = require('./utils/shared');

async function lookupZendesk(zdid){
  var subdomain=process.env.ZENDESK_SUBDOMAIN, email=process.env.ZENDESK_EMAIL, token=process.env.ZENDESK_API_TOKEN;
  if(!subdomain||!email||!token||!zdid)return null;
  var auth=Buffer.from(email+'/token:'+token).toString('base64');
  var headers={Authorization:'Basic '+auth,'Content-Type':'application/json'};
  var tr=await fetch('https://'+subdomain+'.zendesk.com/api/v2/tickets/'+encodeURIComponent(zdid)+'.json',{headers:headers});
  if(!tr.ok)return null;
  var tdata=await tr.json();
  var requesterId=tdata.ticket&&tdata.ticket.requester_id;
  if(!requesterId)return null;
  var ur=await fetch('https://'+subdomain+'.zendesk.com/api/v2/users/'+requesterId+'.json',{headers:headers});
  if(!ur.ok)return null;
  var udata=await ur.json();
  var u=udata.user||{};
  if(!u.name&&!u.email)return null;
  return {name:u.name||'',email:u.email||'',phone:u.phone||''};
}

async function lookupShopify(ordnum){
  var store=process.env.SHOPIFY_STORE_DOMAIN, token=process.env.SHOPIFY_ADMIN_TOKEN;
  if(!store||!token||!ordnum)return null;
  var name=ordnum.trim();
  if(!name.startsWith('#'))name='#'+name;
  var r=await fetch('https://'+store+'/admin/api/2024-01/orders.json?status=any&name='+encodeURIComponent(name),{
    headers:{'X-Shopify-Access-Token':token,'Content-Type':'application/json'}
  });
  if(!r.ok)return null;
  var data=await r.json();
  var order=(data.orders||[])[0];
  if(!order||!order.customer)return null;
  var c=order.customer;
  var fullName=[c.first_name,c.last_name].filter(Boolean).join(' ');
  return {name:fullName,email:c.email||order.email||'',phone:c.phone||(order.shipping_address||{}).phone||''};
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try{
    var body=JSON.parse(event.body||'{}');
    var zdid=(body.zdid||'').trim(), ordnum=(body.ordnum||'').trim();
    if(!zdid&&!ordnum) return json(400,{found:false,message:'Provide a Zendesk ID or Order Number.'});

    var zd=null, sh=null;
    try{ zd=await lookupZendesk(zdid); }catch(e){ console.error('Zendesk lookup failed',e); }
    try{ sh=await lookupShopify(ordnum); }catch(e){ console.error('Shopify lookup failed',e); }

    if(!zd&&!sh) return json(200,{found:false,message:'No match found (or lookups not configured yet - see SETUP.md).'});

    var merged={
      name:(zd&&zd.name)||(sh&&sh.name)||'',
      email:(zd&&zd.email)||(sh&&sh.email)||'',
      phone:(zd&&zd.phone)||(sh&&sh.phone)||'',
      source:[zd?'Zendesk':null,sh?'Shopify':null].filter(Boolean).join(' + ')
    };
    return json(200,{found:true,name:merged.name,email:merged.email,phone:merged.phone,source:merged.source});
  }catch(e){
    console.error(e);
    return json(500,{found:false,error:'Lookup failed',detail:String(e)});
  }
};
