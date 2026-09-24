// POST /api/ai-ask -> /.netlify/functions/ai-ask
// Body: { question, data, today } - answers natural-language questions about
// repair data using Gemini. `data` is a client-trimmed, PII-free snapshot of
// repair records (no order number/serial/customer name/email/phone - see the
// askAI() function in index.html for exactly what's sent). The Zendesk
// ticket number IS sent: it's an internal ticket reference rather than
// customer information, and without it the model has no way to name which
// ticket it's talking about, which made "list the tickets where ..."
// questions unanswerable. Technician repair notes are sent for the same
// reason - questions about what was actually done to a device can't be
// answered from the customer's complaint text alone. `today`
// is the browser's local date (YYYY-MM-DD) - the model has no other way to
// know what "today"/"this week" means, so this is required for accurate
// date-relative answers; falls back to the server's UTC date if omitted.
// Fails gracefully (answer:null + message) if GEMINI_API_KEY isn't set, so
// the "Ask AI" page just explains itself instead of erroring until you add
// a key - see SETUP.md.
const { json } = require('./utils/shared');

var RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    answer: { type: 'STRING' },
    table: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { label: { type: 'STRING' }, value: { type: 'STRING' } },
        required: ['label', 'value']
      }
    }
  },
  required: ['answer']
};

var SYSTEM_PROMPT = 'You are a data analyst answering questions about a device repair shop\'s repair-ticket records for Masjidal (an Islamic technology company - the devices are "Athan Frame" smart displays). ' +
  'You will be given today\'s date, a JSON array of repair records, and a question. Each record has: type (customer/general/amazon), ' +
  'size (device size, e.g. 10", 14"), issue (free-text issue description), year (device year), android (Android version string), ' +
  'zdid (the Zendesk ticket number identifying this ticket - null on internal general/amazon repairs, which have no Zendesk ticket), ' +
  'repairNotes (the technician\'s own free-text notes on what was actually diagnosed/done to the device - parts replaced, steps tried; may be null if nothing was recorded), ' +
  'status (current ticket status), outcome (how it was resolved), createdAt (the date the ticket was opened, YYYY-MM-DD), ' +
  'closedAt (the date the ticket was closed and its outcome - e.g. a replacement being sent - took effect, YYYY-MM-DD), ' +
  'trackingStatus (shipping status if applicable). ' +
  'IMPORTANT: fields that are empty/unset are OMITTED from a record entirely rather than being present-but-null. So a record with no "closedAt" key is still open, a record with no "repairNotes" key has no recorded repair detail, and a record with no "zdid" key is an internal repair with no Zendesk ticket. Treat an absent key as "not set", never as a reason to skip the record. ' +
  'Answer accurately based ONLY on the data given - never invent numbers, and say so plainly if the data does not contain enough information to answer. ' +
  'For date/time questions ("today", "this week", "past N days/months"), always compare against the "Today\'s date" value given to you, never guess it from the data - and use closedAt for questions about when something was sent/shipped/resolved/replaced, createdAt for questions about when a ticket was opened/created. ' +
  'Count carefully and precisely: go through the records methodically rather than estimating, and if you provide a "table" breakdown, the individual values in it must sum to (or otherwise exactly match) any total number stated in the answer text - never let the answer text and the table disagree. ' +
  'Keep the answer concise and conversational (2-4 sentences). ' +
  'Only fill in the "table" field when the question asks for a breakdown/ranking/comparison ACROSS MULTIPLE categories (e.g. "how many by X", "top issues", "android 6 vs 11", "which size has the most issues") - one row per category as {label, value}, sorted most-to-least relevant. ' +
  'A question asking for a single total (e.g. "how many X were sent today") does NOT need a table - just state the number in the answer text and omit the table field (or leave it empty) to keep the response short. ' +
  'ALSO use the table when the question asks you to LIST specific tickets/devices matching some criteria. In that case put one row PER TICKET: "label" is the ticket\'s Zendesk number formatted as "ZD 13082" (use the zdid field; if zdid is null, use the device size and year instead), and "value" is a short description combining what the issue was and what was done about it, drawn from issue/repairNotes/outcome - e.g. "Turns on and off - motherboard replaced". Include every matching ticket, and state the total count in the answer text. ' +
  'When the question is about what was DONE to a device (a part replaced, a repair performed, e.g. "which ones had a motherboard replacement"), judge that from repairNotes first and outcome second - do NOT infer it from the issue text, which only describes the customer\'s complaint. If repairNotes is null for a ticket, you cannot tell what was done to it, so do not claim a specific repair was performed on it.';

// Model names get retired - gemini-2.0-flash was hardcoded here until
// Google shut it down on 2026-06-01, which broke Ask AI outright. Rather
// than hardcode a replacement that will eventually die the same way, ask
// Google which models the key can actually use and pick from that.
var MODEL_PREFERENCE = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

async function listUsableModels(apiKey) {
  var controller = new AbortController();
  var t = setTimeout(function () { controller.abort(); }, 10000);
  try {
    var r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey, { signal: controller.signal });
    if (!r.ok) return { error: 'ListModels returned ' + r.status + ': ' + (await r.text()).substring(0, 200) };
    var d = await r.json();
    var names = (d.models || [])
      .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1; })
      .map(function (m) { return String(m.name || '').replace(/^models\//, ''); })
      .filter(Boolean);
    return { models: names };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'ListModels timed out' : String(e && e.message || e) };
  } finally { clearTimeout(t); }
}

// Prefer our known-good names in order, then any flash-class model, then
// anything at all that can generate content.
function pickModel(available) {
  for (var i = 0; i < MODEL_PREFERENCE.length; i++) {
    if (available.indexOf(MODEL_PREFERENCE[i]) !== -1) return MODEL_PREFERENCE[i];
  }
  var flash = available.filter(function (n) { return /flash/i.test(n) && !/thinking|image|audio|tts|embed/i.test(n); });
  if (flash.length) return flash[0];
  var gen = available.filter(function (n) { return /^gemini/i.test(n) && !/embed|image|audio|tts/i.test(n); });
  return gen[0] || null;
}

// Reports what's actually wrong with the Gemini setup, so a failure can be
// diagnosed from the app instead of guessed at. Never returns the key.
async function runDiagnostics(apiKey) {
  var out = { keyPresent: !!apiKey, keyLength: apiKey ? apiKey.length : 0, configuredModel: process.env.GEMINI_MODEL || null };
  if (!apiKey) { out.verdict = 'GEMINI_API_KEY is not set in Netlify. Add it under Site settings -> Environment variables, then redeploy.'; return out; }
  var listed = await listUsableModels(apiKey);
  if (listed.error) {
    out.listModelsError = listed.error;
    out.verdict = /API key not valid|API_KEY_INVALID|401|403/i.test(listed.error)
      ? 'The GEMINI_API_KEY is set but Google rejected it. Generate a new key at aistudio.google.com/apikey and update it in Netlify, then redeploy.'
      : 'Could not reach Google to list models: ' + listed.error;
    return out;
  }
  out.usableModelCount = listed.models.length;
  out.sampleModels = listed.models.slice(0, 8);
  var chosen = pickModel(listed.models);
  out.chosenModel = chosen;
  if (!chosen) { out.verdict = 'The key works, but it has no models that support generateContent. Check the key\'s project has the Generative Language API enabled.'; return out; }
  // Smallest possible real call, to prove generation itself works.
  try {
    var r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + chosen + ':generateContent?key=' + apiKey, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the word OK.' }] }], generationConfig: { maxOutputTokens: 200 } })
    });
    out.testCallStatus = r.status;
    if (!r.ok) {
      var txt = await r.text();
      out.testCallError = txt.substring(0, 300);
      out.verdict = r.status === 429
        ? 'The key works but is being rate limited (quota exceeded). If it is a free-tier key, enable billing on its Google Cloud project.'
        : 'Model "' + chosen + '" rejected a test call with HTTP ' + r.status + '. See testCallError.';
      return out;
    }
    out.verdict = 'Working. Model "' + chosen + '" responded successfully.';
  } catch (e) {
    out.testCallError = String(e && e.message || e);
    out.verdict = 'Test call to "' + chosen + '" failed: ' + out.testCallError;
  }
  return out;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    var apiKey = process.env.GEMINI_API_KEY;

    var body = JSON.parse(event.body || '{}');
    if (body.diagnose === true) return json(200, { diagnostics: await runDiagnostics(apiKey) });

    if (!apiKey) return json(200, { answer: null, message: 'Ask AI is not configured yet - add GEMINI_API_KEY in Netlify env vars. See SETUP.md.' });

    var question = (body.question || '').trim();
    var data = Array.isArray(body.data) ? body.data : [];
    // Prefer the browser's local date (matches what the person asking means
    // by "today"); fall back to the server's UTC date if it wasn't sent or
    // looks malformed.
    var today = /^\d{4}-\d{2}-\d{2}$/.test(body.today || '') ? body.today : new Date().toISOString().slice(0, 10);
    if (!question) return json(400, { error: 'question is required' });
    if (question.length > 2000) return json(400, { error: 'Question is too long' });
    // Cap record count and trim long free-text fields - this is what's sent
    // on every single question with no caching, so keeping it lean matters
    // for response time, not just cost.
    if (data.length > 1200) data = data.slice(0, 1200);
    data = data.map(function (r) {
      var out = {};
      for (var k in r) { out[k] = (typeof r[k] === 'string' && r[k].length > 200) ? r[k].slice(0, 200) : r[k]; }
      return out;
    });

    // "gemini-flash-latest" is Google's rolling alias for their current
    // recommended fast model, so this doesn't go stale the way a pinned
    // version does (gemini-2.0-flash, hardcoded here previously, was
    // shut down by Google on 2026-06-01). Pin a specific version via
    // GEMINI_MODEL if you want stability over auto-updates instead.
    var primaryModel = process.env.GEMINI_MODEL || 'gemini-flash-latest';
    var userPrompt = 'Today\'s date: ' + today + '\n\nRepair records (JSON array, ' + data.length + ' records):\n' + JSON.stringify(data) + '\n\nQuestion: ' + question;

    function callGemini(model, skipThinkingConfig) {
      // maxOutputTokens too low was the direct cause of a real bug: the
      // model's structured JSON response was getting cut off mid-string
      // before it could close its quotes/braces, so JSON.parse() failed
      // and the raw broken JSON fragment ("{ \"answer\": \"Today...") got
      // shown to the user as if it were the answer. Generous headroom here
      // costs a bit more but a truncated response is unusable either way.
      // 3072 was too tight once "list every matching ticket" answers became
      // possible - those emit one table row per ticket and can legitimately
      // run long, and a truncated structured response fails JSON.parse()
      // entirely rather than degrading gracefully.
      var generationConfig = { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0, maxOutputTokens: 8192 };
      // Fully disabling "thinking" (budget 0) was fast but made counting/
      // date-filtering questions unreliable - the model would eyeball the
      // JSON array instead of actually working through it, producing
      // confidently wrong counts. A small budget gives it room to verify a
      // count before answering without the multi-second latency uncapped
      // thinking had. Some model versions don't support this field, so we
      // retry without it below if that's what caused a request to fail.
      if (!skipThinkingConfig) generationConfig.thinkingConfig = { thinkingBudget: 1024 };
      var controller = new AbortController();
      // Netlify caps a synchronous function at 26s, so abort just under that
      // to return a real JSON error instead of being killed mid-flight (which
      // surfaces to the user as an opaque "request failed").
      var timeout = setTimeout(function () { controller.abort(); }, 24000);
      return fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: generationConfig
        })
      }).finally(function () { clearTimeout(timeout); });
    }

    var r;
    try {
      r = await callGemini(primaryModel, false);
    } catch (e) {
      if (e.name === 'AbortError') return json(504, { error: 'AI request timed out', detail: 'Gemini did not respond within 24s. Questions that scan every ticket are the slowest - try narrowing it (a single year, a single device size, or open tickets only).' });
      throw e;
    }

    // If the model name itself is the problem (retired or renamed, which has
    // already happened once here), ask Google what this key CAN use and
    // retry with that, instead of falling back to another hardcoded name
    // that may be dead too.
    if (!r.ok && r.status === 404 && !process.env.GEMINI_MODEL) {
      console.error('Gemini model "' + primaryModel + '" not found, discovering a replacement');
      var listed = await listUsableModels(apiKey);
      var replacement = listed.models ? pickModel(listed.models) : null;
      if (replacement && replacement !== primaryModel) {
        console.error('Retrying with discovered model "' + replacement + '"');
        r = await callGemini(replacement, false);
      } else if (listed.error) {
        return json(502, { error: 'AI model unavailable',
          detail: 'Model "' + primaryModel + '" no longer exists, and the model list could not be fetched to find a replacement (' + listed.error + ').' });
      } else {
        return json(502, { error: 'AI model unavailable',
          detail: 'Model "' + primaryModel + '" no longer exists and no usable replacement was found for this API key.' });
      }
    }

    // If thinkingConfig itself isn't supported by whichever model resolved,
    // retry once without it rather than failing the whole request.
    if (!r.ok && r.status === 400) {
      var checkText = await r.clone().text();
      if (/thinking/i.test(checkText)) {
        console.error('Gemini rejected thinkingConfig, retrying without it');
        r = await callGemini(primaryModel, true);
      }
    }

    if (!r.ok) {
      var errText = await r.text();
      console.error('Gemini error', r.status, errText);
      // Translate the two failures that are actually about load rather than
      // a bug, so the page says what to do instead of "AI request failed".
      if (r.status === 429) {
        return json(502, { error: 'AI is rate limited right now',
          detail: 'Gemini rejected the request for exceeding its quota (requests or tokens per minute). Wait a minute and try again, or ask a narrower question so less data is sent. If this keeps happening, the API key is likely on the free tier and needs billing enabled.' });
      }
      if (r.status === 503 || r.status === 500) {
        return json(502, { error: 'Gemini is temporarily unavailable',
          detail: 'Google returned ' + r.status + ' (model overloaded). This is on their end - try again in a moment.' });
      }
      return json(502, { error: 'AI request failed', detail: 'Gemini returned ' + r.status + ': ' + errText.substring(0, 400) });
    }

    var respData = await r.json();
    var candidate = respData.candidates && respData.candidates[0];
    var text = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text;
    var finishReason = candidate && candidate.finishReason;
    if (!text) {
      // A candidate with no text is usually MAX_TOKENS (the whole budget went
      // to internal "thinking" before any answer was emitted) or a safety
      // block. Say which - previously this was an unexplained dead end.
      console.error('Gemini returned no content', finishReason, JSON.stringify(respData).substring(0, 400));
      return json(502, { error: 'AI returned no content',
        detail: finishReason === 'MAX_TOKENS'
          ? 'The model used its entire token budget before producing an answer - ask for a narrower list (e.g. one device size, or a shorter date range).'
          : 'Gemini finished with reason: ' + (finishReason || 'unknown') + '.' });
    }

    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // Invalid JSON is Gemini's internal wire format breaking (usually a
      // response cut off mid-string by the token limit) - never show that
      // raw to the user, it's not an answer. Try to salvage the "answer"
      // string up to wherever it got cut, so at least a partial answer is
      // useful, and flag clearly that it was cut off.
      var m = text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)/);
      if (m) {
        var salvaged = m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        return json(200, { answer: salvaged + ' [cut off - try a more specific question]', table: [] });
      }
      console.error('Gemini returned unparseable JSON', finishReason, text.substring(0, 300));
      return json(502, { error: 'AI response was cut off or malformed', detail: finishReason === 'MAX_TOKENS' ? 'The response hit the token limit - try a more specific question.' : 'Could not parse the AI response.' });
    }

    return json(200, { answer: parsed.answer || '', table: parsed.table || [] });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'AI request failed', detail: String(e) });
  }
};
