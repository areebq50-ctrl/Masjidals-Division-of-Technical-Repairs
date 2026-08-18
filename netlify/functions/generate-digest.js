// POST /api/generate-digest -> /.netlify/functions/generate-digest
// Body: { tickets: [{ ticketId, status, isClosed, issue, outcomeText,
//   repairNotes, notes, closingNotes, isNewToday, isClosedToday }] } -
// drafts the "Daily Update" message an employee posts to the team, in the
// shop's existing style (see index.html's openDailyDigest() for the exact
// examples this is modeled on). `ticketId` is an opaque correlation key
// (the repair's internal id, NOT the Zendesk ticket number) used only to
// match each drafted line back to the right repair - it means nothing to
// the model semantically. `repairNotes` is the shop's own "what did you do
// to repair the device" field (freeform, entered any time during the
// repair, not just at close) - it's the best source for specific technical
// detail (diagnosis, parts swapped, steps tried), when present. `notes` is
// a general free-text field that can contain a mix of actual repair detail
// and unrelated internal asides (reminders, "ask Areeb first", etc.) - the
// model is told to use judgment and only pull the repair-relevant part of
// it. `isClosed` is the one thing that actually means "done" - `status`
// alone is misleading (e.g. "Completed Testing" means the repair work is
// finished and the device moved to the testing shelf, NOT that testing
// itself is complete or the ticket is resolved - it's still open at that
// point), so the model is told explicitly not to infer "done" from the
// status string.
//
// Response is { lines: [{ ticketId, issueSummary, resolution }] } - two
// separate required fields rather than one freeform blob, specifically so
// the model can't quietly drop the issue summary (which happened when it
// was just "part of" one combined text field - `issue` is a required field
// on every repair, so issueSummary should never legitimately be empty).
// Neither field is ever the ZD ID, order number, tracking number, or
// @mention - those are assembled by the client from the actual repair
// record data, so there's no way for the model to invent or garble an
// identifier that matters. Fails gracefully (lines:null + message) if
// GEMINI_API_KEY isn't set.
const { json, callGemini } = require('./utils/shared');

var RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          ticketId: { type: 'STRING' },
          issueSummary: { type: 'STRING' },
          resolution: { type: 'STRING' }
        },
        required: ['ticketId', 'issueSummary', 'resolution']
      }
    }
  },
  required: ['lines']
};

var SYSTEM_PROMPT = 'You write brief internal status-update sentences for a device repair shop\'s team chat, describing what\'s going on with a repair ticket - for a teammate skimming a daily digest, not the customer. ' +
  'You will be given a JSON array of tickets, each with a "ticketId" (an opaque key for matching your response back to the right ticket - it has no other meaning, do not reference it in the text), an "issue" field (what the customer reported - this is a REQUIRED field on every ticket, so it is never actually empty), a "status" field (the shop\'s internal workflow stage), an "isClosed" boolean, and fields describing what was done: "repairNotes" (the technician\'s own freeform notes on the specific diagnostic/repair steps taken - parts replaced, things tried, test results - the best and most specific source when present), "notes" (a general free-text field on the ticket - it can contain real repair/diagnostic detail, but can also contain unrelated internal asides like reminders or notes-to-self, e.g. "ask Areeb first" or "call back Tuesday" - use judgment and only pull in the part of it that actually describes the issue or the fix, ignore the rest), "outcomeText" (the ticket\'s resolution category if closed), and "closingNotes". ' +
  'CRITICAL - never say a ticket, repair, or testing is finished/done/completed/resolved unless "isClosed" is true. "status" is an internal workflow label, NOT a completion signal - in particular a status like "Completed Testing" only means the repair work is done and the device has been moved to the testing shelf, it does NOT mean testing itself is finished or the ticket is resolved; the device is still actively being tested and the ticket is still open. Describe that case as something like "device is on the testing shelf" or "device is testing" (present/ongoing), never "testing has been completed" or "the repair is done". Only when isClosed is true should you describe the ticket as finished, using outcomeText/closingNotes for the final resolution.\n' +
  'Return one entry per ticket (same ticketId) with exactly two separate fields:\n' +
  '- "issueSummary": one short clause or sentence putting the "issue" field into your own words. This field is REQUIRED and must never be left empty or skipped - the ticket always has issue text, so always summarize it.\n' +
  '- "resolution": one to three short sentences on what was done, or is being done, about it, consistent with the isClosed rule above. MANDATORY: if repairNotes or notes names a specific action - a part replaced, a step taken (flashed/reflashed, reset, re-imaged), a specific test performed, a decision made (refund, replacement, waiting on customer) - the resolution MUST state that specific action in your own words. A generic phrase like "device is on the testing shelf" or "device is being looked into" is ONLY acceptable as a short addition after the specific action, NEVER as a substitute for it - dropping a concrete action that IS present in repairNotes/notes is a failure. Only fall back to a generic status-based sentence (from outcomeText/closingNotes/status) when repairNotes and notes truly contain no specific action at all.\n' +
  'Match this exact tone - these are real examples of the combined style (issue then specific resolution) to write in:\n' +
  '- "Customer reports the media player audio cuts out when the screen turns off and occasionally plays overlapping tracks that cannot be paused. I tried flashing but it failed so I replaced the motherboard. Device is testing."\n' +
  '- "Customer reported the frame freezes, crashes repeatedly, and currently shows a blank screen while powered on. Device was flashed. It will be testing for a couple days to ensure everything works as expected."\n' +
  '- "Customer requested a refund. Refund has been processed."\n' +
  '- "Customer reported the device was defective on arrival. We will issue a replacement device. UPS has already come to pick-up shipping so replacement will go out on Wednesday."\n' +
  'Rules: plain and direct, no greetings or sign-offs. ' +
  'Base both fields ONLY on the data given - never invent a detail, a date, a part, or a repair step that isn\'t there. ' +
  'NEVER include the ZD number, order number, tracking number, a customer name, or an @mention in either field - those are added separately by the app (a ticket with tracking will have it appended after your text, so don\'t restate or hint at the number yourself). NEVER mention attachments or screenshots - none are actually attached.';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    var body = JSON.parse(event.body || '{}');
    var tickets = Array.isArray(body.tickets) ? body.tickets : [];
    if (!tickets.length) return json(400, { error: 'tickets is required' });
    if (tickets.length > 60) tickets = tickets.slice(0, 60);

    var userPrompt = 'Tickets (JSON array, ' + tickets.length + ' tickets):\n' + JSON.stringify(tickets) +
      '\n\nReturn one "lines" entry per ticket above (same ticketId), same order.';

    var text;
    try {
      text = await callGemini(SYSTEM_PROMPT, userPrompt, {
        responseSchema: RESPONSE_SCHEMA, temperature: 0.4, maxOutputTokens: 2048, thinkingBudget: 0, timeoutMs: 20000
      });
    } catch (e) {
      console.error('Daily digest generation failed', e);
      return json(502, { error: 'Daily update generation failed', detail: e.message });
    }
    if (!text) return json(200, { lines: null, message: 'Daily Update is not configured yet - add GEMINI_API_KEY in Netlify env vars. See SETUP.md.' });

    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { return json(502, { error: 'AI returned a malformed response', detail: text.substring(0, 300) }); }

    return json(200, { lines: parsed.lines || [] });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'Failed to generate daily update', detail: String(e) });
  }
};
