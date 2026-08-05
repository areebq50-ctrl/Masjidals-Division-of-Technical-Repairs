// POST /api/lookup-customer -> /.netlify/functions/lookup-customer
// Body: { zdid, ordnum } - looks up customer name/email/phone from Zendesk
// (by ticket ID) and/or Shopify (by order number), plus a warranty
// determination from the Shopify order date when available, which Zendesk
// agent is assigned to the ticket (mapped to the shop's "ZD Assigned To"
// options), and a Gemini-generated one-sentence summary of the ticket's
// reported issue. Read-only: never writes anything back to Zendesk/Shopify.
// Fails gracefully (found:false) if the relevant env vars aren't
// configured, so the app just quietly does nothing until you set these up
// - see SETUP.md.
//
// Warranty: standard warranty is 12 months from the Shopify order date. If
// the order has a line item with SKU "aframewarranty" (the $30 extended
// warranty add-on, +1 year), the total is bumped to 24 months.
const { json, describeFetchError, callGemini } = require('./utils/shared');

var WARRANTY_MONTHS = 12;
var EXTENDED_WARRANTY_MONTHS = 24;
var EXTENDED_WARRANTY_SKU = 'aframewarranty';

// Tolerates the most common copy/paste mistakes: pasting the full URL
// (https://foo.zendesk.com) or the domain with .zendesk.com already
// attached, instead of just the subdomain.
function cleanZendeskSubdomain(s){
  return (s||'').trim().replace(/^https?:\/\//i,'').replace(/\.zendesk\.com.*$/i,'').replace(/\/.*$/,'');
}

// A real Zendesk account subdomain is only letters/digits/hyphens. Anything
// else (spaces, dots, an API token pasted into the wrong field, etc.) will
// never resolve to a real account - Zendesk's edge rejects the TLS
// handshake for unrecognized hostnames, which surfaces as a confusing
// ERR_SSL_TLS_ALERT_HANDSHAKE_FAILURE instead of a clear "wrong value"
// error. Catch it before making the request.
function isValidZendeskSubdomain(s){
  return /^[a-z0-9-]+$/i.test(s);
}

// Returns { name, email, phone, assignedAgent, subject, description } on a
// match (assignedAgent/subject/description may be empty strings if the
// ticket doesn't have them), null if simply not configured/not found, or
// { error: '...' } on a real API failure (bad credentials, network issue,
// etc.) so the caller can tell the difference.
async function lookupZendesk(zdid){
  var subdomain=cleanZendeskSubdomain(process.env.ZENDESK_SUBDOMAIN), email=process.env.ZENDESK_EMAIL, token=process.env.ZENDESK_API_TOKEN;
  if(!subdomain||!email||!token||!zdid)return null;
  if(!isValidZendeskSubdomain(subdomain)){
    return {error:'ZENDESK_SUBDOMAIN is set to "'+subdomain+'", which is not a valid Zendesk account name (letters/numbers/hyphens only). '+
      'It should be just the account name, e.g. if your Zendesk URL is https://masjidal.zendesk.com, set ZENDESK_SUBDOMAIN=masjidal - nothing else, no token or full URL.'};
  }
  try{
    var auth=Buffer.from(email+'/token:'+token).toString('base64');
    var headers={Authorization:'Basic '+auth,'Content-Type':'application/json'};
    var tr=await fetch('https://'+subdomain+'.zendesk.com/api/v2/tickets/'+encodeURIComponent(zdid)+'.json',{headers:headers});
    if(!tr.ok){
      if(tr.status===404)return null; // no such ticket - not an error, just no match
      return {error:'Zendesk returned '+tr.status+': '+(await tr.text()).substring(0,200)};
    }
    var tdata=await tr.json();
    var ticket=tdata.ticket||{};
    var requesterId=ticket.requester_id;
    if(!requesterId)return null;
    var ur=await fetch('https://'+subdomain+'.zendesk.com/api/v2/users/'+requesterId+'.json',{headers:headers});
    if(!ur.ok)return {error:'Zendesk user lookup returned '+ur.status};
    var udata=await ur.json();
    var u=udata.user||{};
    if(!u.name&&!u.email)return null;

    // Who's actually handling this ticket (the agent, not the customer) -
    // used to auto-fill "ZD Assigned To", separate from the customer fields.
    var assignedAgent='';
    if(ticket.assignee_id){
      var ar=await fetch('https://'+subdomain+'.zendesk.com/api/v2/users/'+ticket.assignee_id+'.json',{headers:headers});
      if(ar.ok){var adata=await ar.json();assignedAgent=(adata.user||{}).name||'';}
    }

    return {name:u.name||'',email:u.email||'',phone:u.phone||'',assignedAgent:assignedAgent,
      subject:ticket.subject||'',description:ticket.description||''};
  }catch(e){
    return {error:'Zendesk request failed: '+describeFetchError(e)};
  }
}

// Matches a Zendesk agent's name against the shop's fixed "ZD Assigned To"
// options (see f-assigned-to in index.html) - substring match so "Awais
// Khan" still matches "Awais". Returns '' if no confident match.
var ZD_ASSIGNEE_OPTIONS=['Awais','Afroz','Kiran'];
function matchAssignee(agentName){
  if(!agentName)return'';
  var lower=agentName.toLowerCase();
  var match=ZD_ASSIGNEE_OPTIONS.find(function(opt){return lower.indexOf(opt.toLowerCase())!==-1;});
  return match||'';
}

// Summarizes a Zendesk ticket's subject/description into a short plain-text
// issue description for the repair's "Issue / Problem" field. Returns null
// if there's nothing to summarize, GEMINI_API_KEY isn't set, or the
// summarization call fails for any reason - this is a nice-to-have on top
// of the customer lookup, never worth failing the whole lookup over.
async function summarizeIssue(subject,description){
  if(!subject&&!description)return null;
  try{
    var text=await callGemini(
      'You summarize a customer support ticket into ONE short, plain, factual sentence describing the device issue being reported, for a repair technician who will read it as the "Issue / Problem" field on a repair ticket. State only what the customer reported - no greetings, no filler, no quotes, no "the customer says". If the subject/description don\'t actually describe a device issue, respond with exactly: NONE',
      'Ticket subject: '+(subject||'(none)')+'\n\nTicket description:\n'+(description||'(none)').slice(0,3000),
      {temperature:0.2,maxOutputTokens:150,thinkingBudget:0,timeoutMs:12000}
    );
    if(!text)return null;
    text=text.trim();
    if(!text||/^NONE$/i.test(text))return null;
    return text;
  }catch(e){
    console.error('Issue summarization failed (non-fatal)',e);
    return null;
  }
}

// Tolerates pasting the full URL or the bare store name without
// ".myshopify.com" attached.
function cleanShopifyDomain(s){
  s=(s||'').trim().replace(/^https?:\/\//i,'').replace(/\/.*$/,'');
  if(s&&!/\.myshopify\.com$/i.test(s))s+='.myshopify.com';
  return s;
}

// Returns { name, email, phone, purchaseDate, warrantyMonths } on a match,
// null if not configured/not found, or { error: '...' } on a real failure.
async function lookupShopify(ordnum){
  var store=cleanShopifyDomain(process.env.SHOPIFY_STORE_DOMAIN), token=process.env.SHOPIFY_ADMIN_TOKEN;
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
    return {error:'Shopify request failed: '+describeFetchError(e)};
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try{
    var body=JSON.parse(event.body||'{}');
    var zdid=(body.zdid||'').trim(), ordnum=(body.ordnum||'').trim();
    if(!zdid&&!ordnum) return json(400,{found:false,message:'Provide a Zendesk ID or Order Number.'});

    var zdConfigured=!!(process.env.ZENDESK_SUBDOMAIN&&process.env.ZENDESK_EMAIL&&process.env.ZENDESK_API_TOKEN);
    var shConfigured=!!(process.env.SHOPIFY_STORE_DOMAIN&&process.env.SHOPIFY_ADMIN_TOKEN);

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
      // Make it unambiguous whether this is "not configured" vs "genuinely
      // no match" - these used to collapse into one generic message.
      if(!zdConfigured&&!shConfigured){
        return json(200,{found:false,message:'Neither Zendesk nor Shopify is configured yet - add the env vars in Netlify and redeploy (see SETUP.md).'});
      }
      var unconfigured=[];
      if(zdid&&!zdConfigured)unconfigured.push('Zendesk not configured');
      if(ordnum&&!shConfigured)unconfigured.push('Shopify not configured');
      var msg='No matching '+[zdid?'Zendesk ticket':null,ordnum?'Shopify order':null].filter(Boolean).join(' or ')+' found for that ID/order.';
      if(unconfigured.length)msg+=' ('+unconfigured.join(', ')+')';
      return json(200,{found:false,message:msg});
    }

    var assignedTo=zd?matchAssignee(zd.assignedAgent):'';
    var issueSummary=zd?await summarizeIssue(zd.subject,zd.description):null;

    var merged={
      name:(zd&&zd.name)||(sh&&sh.name)||'',
      email:(zd&&zd.email)||(sh&&sh.email)||'',
      phone:(zd&&zd.phone)||(sh&&sh.phone)||'',
      purchaseDate:(sh&&sh.purchaseDate)||null,
      warrantyMonths:(sh&&sh.warrantyMonths)||null,
      assignedTo:assignedTo,
      issueSummary:issueSummary,
      source:[zd?'Zendesk':null,sh?'Shopify':null].filter(Boolean).join(' + ')
    };
    return json(200,{found:true,name:merged.name,email:merged.email,phone:merged.phone,
      purchaseDate:merged.purchaseDate,warrantyMonths:merged.warrantyMonths,
      assignedTo:merged.assignedTo,issueSummary:merged.issueSummary,source:merged.source});
  }catch(e){
    console.error(e);
    return json(500,{found:false,error:'Lookup failed',detail:String(e)});
  }
};
