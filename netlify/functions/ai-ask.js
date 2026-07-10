// POST /api/ai-ask -> /.netlify/functions/ai-ask
// Body: { question, data } - answers natural-language questions about repair
// data using Gemini. `data` is a client-trimmed, PII-free snapshot of repair
// records (no zendesk id/order number/serial/customer contact info - see the
// askAI() function in index.html for exactly what's sent).
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
  'You will be given a JSON array of repair records and a question. Each record has: type (customer/general/amazon), ' +
  'size (device size, e.g. 10", 14"), issue (free-text issue description), year (device year), android (Android version string), ' +
  'status (current ticket status), outcome (how it was resolved), createdAt/closedAt (ISO timestamps), trackingStatus (shipping status if applicable, may be null). ' +
  'Answer accurately based ONLY on the data given - never invent numbers, and say so plainly if the data does not contain enough information to answer. ' +
  'Keep the answer concise and conversational (2-4 sentences). ' +
  'If the question asks for a breakdown, count, ranking, or comparison (e.g. "how many by X", "top issues", "android 6 vs 11", "which size has the most issues"), ' +
  'also fill in the "table" field with one row per category as {label, value} - value should be the count or metric as a string, sorted most-to-least relevant. ' +
  'If the question is not a breakdown/count/ranking question, omit the table field or return it empty.';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    var apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return json(200, { answer: null, message: 'Ask AI is not configured yet - add GEMINI_API_KEY in Netlify env vars. See SETUP.md.' });

    var body = JSON.parse(event.body || '{}');
    var question = (body.question || '').trim();
    var data = Array.isArray(body.data) ? body.data : [];
    if (!question) return json(400, { error: 'question is required' });
    if (question.length > 2000) return json(400, { error: 'Question is too long' });
    if (data.length > 3000) data = data.slice(0, 3000);

    // "gemini-flash-latest" is Google's rolling alias for their current
    // recommended fast model, so this doesn't go stale the way a pinned
    // version does (gemini-2.0-flash, hardcoded here previously, was
    // shut down by Google on 2026-06-01). Pin a specific version via
    // GEMINI_MODEL if you want stability over auto-updates instead.
    var primaryModel = process.env.GEMINI_MODEL || 'gemini-flash-latest';
    var userPrompt = 'Repair records (JSON array, ' + data.length + ' records):\n' + JSON.stringify(data) + '\n\nQuestion: ' + question;

    function callGemini(model) {
      return fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0.2 }
        })
      });
    }

    var r = await callGemini(primaryModel);

    // If the model name itself is the problem (renamed/retired again in the
    // future) and no explicit GEMINI_MODEL override is set, retry once
    // against a specific known-good version rather than failing outright.
    if (!r.ok && r.status === 404 && !process.env.GEMINI_MODEL) {
      console.error('Gemini model "'+primaryModel+'" not found, retrying with gemini-2.5-flash');
      r = await callGemini('gemini-2.5-flash');
    }

    if (!r.ok) {
      var errText = await r.text();
      console.error('Gemini error', r.status, errText);
      return json(502, { error: 'AI request failed', detail: errText.substring(0, 300) });
    }

    var respData = await r.json();
    var candidate = respData.candidates && respData.candidates[0];
    var text = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text;
    if (!text) return json(502, { error: 'AI returned no content' });

    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { return json(200, { answer: text, table: [] }); }

    return json(200, { answer: parsed.answer || '', table: parsed.table || [] });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'AI request failed', detail: String(e) });
  }
};
