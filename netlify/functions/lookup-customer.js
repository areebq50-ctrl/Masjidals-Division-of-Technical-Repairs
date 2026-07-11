// POST /api/lookup-customer -> /.netlify/functions/lookup-customer
// Body: { zdid, ordnum } - looks up customer name/email/phone from Zendesk
// (by ticket ID) and/or Shopify (by order number), plus a warranty
// determination from the Shopify order date when available. Read-only:
// never writes anything back to Zendesk/Shopify. Fails gracefully
// (found:false) if the relevant env vars aren't configured, so the app just
// quietly does nothing until you set these up - see SETUP.md.
//
// Warranty: standard warranty is 12 months from the Shopify order date. If
// the order has a line item with SKU "aframewarranty" (the $30 extended
// warranty add-on, +1 year), the total is bumped to 24 months.
const { json } = require('./utils/shared');

var WARRANTY_MONTHS = 12;
var EXTENDED_WARRANTY_MONTHS = 24;
var EXTENDED_WARRANTY_SKU = 'aframewarranty';

// Returns { name, email, phone } on a match, null if simply not
// configured/not found, or { error: '...' } on a real API failure (bad
// credentials, network issue, etc.) so the caller can tell the difference.
async function lookupZendesk(zdid){
  var subdomain=process.env.ZENDESK_SUBDOMAIN, email=process.env.ZENDESK_EMAIL, token=process.env.ZENDESK_API_TOKEN;
  if(!subdomain||!email||!token||!zdid)return null;
  try{
    var auth=Buffer.from(email+'/token:'+token).toString('base64');
    var headers={Authorization:'Basic '+auth,'Content-Type':'application/json'};
    var tr=await fetch('https://'+subdomain+'.zendesk.com/api/v2/tickets/'+encodeURIComponent(zdid)+'.json',{headers:headers});
    if(!tr.ok){
      if(tr.status===404)return null; // no such ticket - not an error, just no match
      return {error:'Zendesk returned '+tr.status+': '+(await tr.text()).substring(0,200)};
    }
    var tdata=await tr.json();
    var requesterId=tdata.ticket&&tdata.ticket.requester_id;
    if(!requesterId)return null;
    var ur=await fetch('https://'+subdomain+'.zendesk.com/api/v2/users/'+requesterId+'.json',{headers:headers});
    if(!ur.ok)return {error:'Zendesk user lookup returned '+ur.status};
    var udata=await ur.json();
    var u=udata.user||{};
    if(!u.name&&!u.email)return null;
    return {name:u.name||'',email:u.email||'',phone:u.phone||''};
  }catch(e){
    return {error:'Zendesk request failed: '+String(e)};
  }
}

// Returns { name, email, phone, purchaseDate, warrantyMonths } on a match,
// null if not configured/not found, or { error: '...' } on a real failure.
async function lookupShopify(ordnum){
  var store=process.env.SHOPIFY_STORE_DOMAIN, token=process.env.SHOPIFY_ADMIN_TOKEN;
  if(!store||!token||!ordnum)return null;
  try{
    var name=ordnum.trim();
    if(!name.startsWith('#'))name='#'+name;
    var r=await fetch('https://'+store+'/admin/api/2024-01/orders.json?status=any&name='+encodeURIComponent(name),{
      headers:{'X-Shopify-Access-Token':token,'Content-Type':'application/json'}
    });
    if(!r.ok)return {error:'Shopify returned '+r.status+': '+(await r.text()).substring(0,200)};
    var data=await r.json();
    var order=(data.orders||[])[0];
    if(!order)return null;

    var result={name:'',email:'',phone:'',purchaseDate:null,warrantyMonths:null};
    if(order.customer){
      var c=order.customer;
      result.name=[c.first_name,c.last_name].filter(Boolean).join(' ');
      result.email=c.email||order.email||'';
      result.phone=c.phone||(order.shipping_address||{}).phone||'';
    }
    if(order.created_at){
      result.purchaseDate=String(order.created_at).slice(0,10);
      var hasExtended=(order.line_items||[]).some(function(li){return (li.sku||'').trim().toLowerCase()===EXTENDED_WARRANTY_SKU;});
      result.warrantyMonths=hasExtended?EXTENDED_WARRANTY_MONTHS:WARRANTY_MONTHS;
    }
    if(!result.name&&!result.email&&!result.purchaseDate)return null;
    return result;
  }catch(e){
    return {error:'Shopify request failed: '+String(e)};
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try{
    var body=JSON.parse(event.body||'{}');
    var zdid=(body.zdid||'').trim(), ordnum=(body.ordnum||'').trim();
    if(!zdid&&!ordnum) return json(400,{found:false,message:'Provide a Zendesk ID or Order Number.'});

    var zdResult=await lookupZendesk(zdid);
    var shResult=await lookupShopify(ordnum);
    var zdError=zdResult&&zdResult.error, shError=shResult&&shResult.error;
    var zd=zdError?null:zdResult, sh=shError?null:shResult;

    if(!zd&&!sh){
      if(zdError||shError){
        // A real API error, not just "no match" - surface it so it's
        // distinguishable from "not configured" / genuinely nothing found.
        return json(200,{found:false,message:[zdError,shError].filter(Boolean).join(' | ')});
      }
      return json(200,{found:false,message:'No match found (or lookups not configured yet - see SETUP.md).'});
    }

    var merged={
      name:(zd&&zd.name)||(sh&&sh.name)||'',
      email:(zd&&zd.email)||(sh&&sh.email)||'',
      phone:(zd&&zd.phone)||(sh&&sh.phone)||'',
      purchaseDate:(sh&&sh.purchaseDate)||null,
      warrantyMonths:(sh&&sh.warrantyMonths)||null,
      source:[zd?'Zendesk':null,sh?'Shopify':null].filter(Boolean).join(' + ')
    };
    return json(200,{found:true,name:merged.name,email:merged.email,phone:merged.phone,
      purchaseDate:merged.purchaseDate,warrantyMonths:merged.warrantyMonths,source:merged.source});
  }catch(e){
    console.error(e);
    return json(500,{found:false,error:'Lookup failed',detail:String(e)});
  }
};
