// POST /api/ai-ask -> /.netlify/functions/ai-ask
// Body: { question, data, today } - answers natural-language questions about
// repair data using Gemini. `data` is a client-trimmed, PII-free snapshot of
// repair records (no zendesk id/order number/serial/customer contact info -
// see the askAI() function in index.html for exactly what's sent). `today`
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
  'status (current ticket status), outcome (how it was resolved), createdAt (when the ticket was opened, ISO timestamp), ' +
  'closedAt (when the ticket was closed and its outcome - e.g. a replacement being sent - took effect, ISO timestamp, null if still open), ' +
  'trackingStatus (shipping status if applicable, may be null). ' +
  'Answer accurately based ONLY on the data given - never invent numbers, and say so plainly if the data does not contain enough information to answer. ' +
  'For date/time questions ("today", "this week", "past N days/months"), always compare against the "Today\'s date" value given to you, never guess it from the data - and use closedAt for questions about when something was sent/shipped/resolved/replaced, createdAt for questions about when a ticket was opened/created. ' +
  'Count carefully and precisely: go through the records methodically rather than estimating, and if you provide a "table" breakdown, the individual values in it must sum to (or otherwise exactly match) any total number stated in the answer text - never let the answer text and the table disagree. ' +
  'Keep the answer concise and conversational (2-4 sentences). ' +
  'Only fill in the "table" field when the question asks for a breakdown/ranking/comparison ACROSS MULTIPLE categories (e.g. "how many by X", "top issues", "android 6 vs 11", "which size has the most issues") - one row per category as {label, value}, sorted most-to-least relevant. ' +
  'A question asking for a single total (e.g. "how many X were sent today") does NOT need a table - just state the number in the answer text and omit the table field (or leave it empty) to keep the response short.';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    var apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return json(200, { answer: null, message: 'Ask AI is not configured yet - add GEMINI_API_KEY in Netlify env vars. See SETUP.md.' });

    var body = JSON.parse(event.body || '{}');
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
      var generationConfig = { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0, maxOutputTokens: 3072 };
      // Fully disabling "thinking" (budget 0) was fast but made counting/
      // date-filtering questions unreliable - the model would eyeball the
      // JSON array instead of actually working through it, producing
      // confidently wrong counts. A small budget gives it room to verify a
      // count before answering without the multi-second latency uncapped
      // thinking had. Some model versions don't support this field, so we
      // retry without it below if that's what caused a request to fail.
      if (!skipThinkingConfig) generationConfig.thinkingConfig = { thinkingBudget: 1024 };
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 20000);
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
      if (e.name === 'AbortError') return json(504, { error: 'AI request timed out', detail: 'Gemini did not respond within 20s - try a more specific question.' });
      throw e;
    }

    // If the model name itself is the problem (renamed/retired again in the
    // future) and no explicit GEMINI_MODEL override is set, retry once
    // against a specific known-good version rather than failing outright.
    if (!r.ok && r.status === 404 && !process.env.GEMINI_MODEL) {
      console.error('Gemini model "'+primaryModel+'" not found, retrying with gemini-2.5-flash');
      r = await callGemini('gemini-2.5-flash', false);
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
      return json(502, { error: 'AI request failed', detail: errText.substring(0, 300) });
    }

    var respData = await r.json();
    var candidate = respData.candidates && respData.candidates[0];
    var text = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text;
    var finishReason = candidate && candidate.finishReason;
    if (!text) return json(502, { error: 'AI returned no content' });

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
