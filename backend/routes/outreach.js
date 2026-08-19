const express = require('express');
const config = require('../config/env');
const logger = require('../utils/logger');
const Lead = require('../models/Lead');
const ICP = require('../models/ICP');
const Message = require('../models/Message');
const MessageTemplate = require('../models/MessageTemplate');
const Suppression = require('../models/Suppression');
const messageGenerator = require('../services/outreach/messageGenerator');
const promptBuilder = require('../services/outreach/promptBuilder');
const mailer = require('../services/outreach/mailer');
const scheduler = require('../services/outreach/scheduler');
const unsubscribe = require('../services/outreach/unsubscribe');

const router = express.Router();

const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 20000;

/**
 * Deep links that let a user send from their own mail client when SMTP is not
 * configured — or when they would simply rather the email came from their real
 * mailbox, which is often the better outcome for a first touch.
 */
function composeLinks(message) {
  const to = encodeURIComponent(message.to_email || '');
  const subject = encodeURIComponent(message.subject || '');
  const body = encodeURIComponent(message.body || '');

  return {
    mailto: `mailto:${to}?subject=${subject}&body=${body}`,
    // Opens a pre-filled Gmail compose window in whichever account the browser
    // is signed into.
    gmail: `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${subject}&body=${body}`,
    outlook: `https://outlook.office.com/mail/deeplink/compose?to=${to}&subject=${subject}&body=${body}`,
  };
}

function withLinks(message) {
  if (!message) return message;
  return { ...message, composeLinks: composeLinks(message) };
}

/** Reject oversized or empty content before it reaches the database. */
function validateContent({ subject, body }) {
  if (subject !== undefined && String(subject).length > MAX_SUBJECT_LENGTH) {
    return `Subject is too long (max ${MAX_SUBJECT_LENGTH} characters).`;
  }
  if (body !== undefined && String(body).length > MAX_BODY_LENGTH) {
    return `Message body is too long (max ${MAX_BODY_LENGTH} characters).`;
  }
  return null;
}

// ─── Status ─────────────────────────────────────────────────────────────────

/**
 * What the outreach module can currently do — which AI engine writes drafts,
 * whether mail can actually be sent, whether scheduling is live.
 *
 * Booleans and model names only; never key values.
 */
router.get('/status', async (req, res) => {
  try {
    res.json({
      ai: messageGenerator.describe(),
      smtp: mailer.status(),
      scheduler: scheduler.status(),
      sender: promptBuilder.senderProfile(),
      stats: await Message.getStats(),
      placeholders: MessageTemplate.PLACEHOLDERS,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Test the SMTP credentials without sending anything. */
router.post('/verify-smtp', async (req, res) => {
  const result = await mailer.verify();
  res.status(result.ok ? 200 : 400).json(result);
});

// ─── Generation ─────────────────────────────────────────────────────────────

/**
 * Draft a first-touch message for one lead.
 *
 * Two modes:
 *
 *   mode=generate (default) — the server calls the configured AI engine and
 *       saves the result as a draft. One click, message ready to edit.
 *
 *   mode=handoff — no key, no server-side model call. Returns the fully built
 *       prompt and a Gemini URL so the browser can open Gemini under the user's
 *       own Google login. The user runs it and pastes the answer back via
 *       PUT /messages/:id. This is the closest thing to "use my Gemini login"
 *       that actually exists: Google gives a server no way to borrow a browser
 *       session, so a human has to be the bridge.
 */
router.post('/generate/:leadId', async (req, res) => {
  try {
    // With the score joined on: the generator falls back to the score
    // explanation when a lead has no signal rows to personalise against.
    const lead = await Lead.findByIdWithScore(req.params.leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const icp = lead.icp_id ? await ICP.findById(lead.icp_id) : null;
    const mode = String(req.body?.mode || 'generate').toLowerCase();

    if (mode === 'handoff') {
      const handoff = await messageGenerator.buildHandoff(lead, icp);
      return res.json({
        mode: 'handoff',
        leadId: lead.id,
        prompt: handoff.prompt,
        geminiUrl: handoff.url,
        geminiBaseUrl: handoff.baseUrl,
        signal: handoff.signal,
        instructions: [
          'The prompt has been copied to your clipboard.',
          'Gemini opens in a new tab, signed in as you — paste the prompt and press enter.',
          'Copy Gemini\'s answer, paste it back into the draft editor, then review and send.',
        ],
      });
    }

    const draft = await messageGenerator.generateForLead(lead, icp, {
      provider: req.body?.provider || null,
    });

    // One live draft per lead. Regenerating replaces it rather than stacking up
    // near-identical drafts the user then has to tell apart. Sent messages are
    // untouched — they are history.
    const existingDrafts = await Message.list({ leadId: lead.id, status: 'draft', limit: 10 });
    for (const old of existingDrafts) await Message.delete(old.id);

    const message = await Message.create({
      lead_id: lead.id,
      icp_id: lead.icp_id,
      channel: 'email',
      to_email: lead.contact_email || null,
      to_name: lead.contact_name || null,
      from_email: mailer.fromAddress(),
      subject: draft.subject,
      body: draft.body,
      status: 'draft',
      generated_by: draft.provider,
      generation_prompt: draft.prompt,
      personalisation: draft.personalisation,
    });

    res.status(201).json({
      mode: 'generate',
      message: withLinks(message),
      provider: draft.provider,
      signal: draft.signal,
      // Set when the requested engine failed and the template writer stood in,
      // so the UI can tell the user the draft needs a closer edit.
      warning: draft.warning,
      // Surfaced so "why does it not mention their funding round?" has an
      // answer the user can see rather than guess at.
      personalisation: draft.personalisation,
      sendableNow: Boolean(lead.contact_email),
      noEmailReason: lead.contact_email ? null : 'This lead has no email address yet. Add one to send, or use the compose links.',
    });
  } catch (err) {
    logger.warn(`Message generation failed: ${err.message}`);
    res.status(502).json({ error: `Could not generate a draft: ${err.message}` });
  }
});

/** The raw prompt for a lead, without generating or saving anything. */
router.get('/prompt/:leadId', async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const icp = lead.icp_id ? await ICP.findById(lead.icp_id) : null;
    const handoff = await messageGenerator.buildHandoff(lead, icp);

    res.json({ prompt: handoff.prompt, geminiUrl: handoff.url, signal: handoff.signal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Templates ──────────────────────────────────────────────────────────────

router.get('/templates', async (req, res) => {
  try {
    res.json({ templates: await MessageTemplate.list(), placeholders: MessageTemplate.PLACEHOLDERS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Save a template — usually straight from a draft that worked.
 *
 * When `fromMessageId` is given the message's own text is stored, so "save this
 * one as a template" is a single click after the user has already edited it
 * into shape.
 */
router.post('/templates', async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A template name is required.' });

    let subject = body.subject;
    let bodyText = body.body;
    let sourceId = null;

    if (body.fromMessageId) {
      const source = await Message.findById(body.fromMessageId);
      if (!source) return res.status(404).json({ error: 'The message to save as a template was not found.' });
      subject = subject ?? source.subject;
      bodyText = bodyText ?? source.body;
      sourceId = source.id;
    }

    const invalid = validateContent({ subject, body: bodyText });
    if (invalid) return res.status(400).json({ error: invalid });

    if (!String(bodyText || '').trim()) {
      return res.status(400).json({ error: 'A template needs a body.' });
    }

    const template = await MessageTemplate.create({
      name,
      subject: subject || '',
      body: bodyText,
      tags: Array.isArray(body.tags) ? body.tags : [],
      source_message_id: sourceId,
    });

    res.status(201).json({ template });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/templates/:id', async (req, res) => {
  try {
    const invalid = validateContent(req.body || {});
    if (invalid) return res.status(400).json({ error: invalid });

    const template = await MessageTemplate.update(req.params.id, req.body || {});
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json({ template });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    const removed = await MessageTemplate.delete(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Apply a template to a lead, producing a draft.
 *
 * Placeholders are re-filled from this lead, which is why templates store
 * {{contact_name}} rather than the name they were saved with — otherwise the
 * previous recipient's details would ride along into a new email.
 */
router.post('/templates/:id/apply/:leadId', async (req, res) => {
  try {
    const template = await MessageTemplate.findById(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });

    const lead = await Lead.findById(req.params.leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const signal = await promptBuilder.resolveSignal(lead);
    const sender = promptBuilder.senderProfile();
    const values = MessageTemplate.valuesFromLead(lead, sender, signal.summary);

    const existingDrafts = await Message.list({ leadId: lead.id, status: 'draft', limit: 10 });
    for (const old of existingDrafts) await Message.delete(old.id);

    const message = await Message.create({
      lead_id: lead.id,
      icp_id: lead.icp_id,
      template_id: template.id,
      to_email: lead.contact_email || null,
      to_name: lead.contact_name || null,
      from_email: mailer.fromAddress(),
      subject: MessageTemplate.render(template.subject, values),
      body: MessageTemplate.render(template.body, values),
      status: 'draft',
      generated_by: 'template',
      personalisation: { ...values, template_id: template.id, template_name: template.name },
    });

    await MessageTemplate.recordUse(template.id);
    res.status(201).json({ message: withLinks(message) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Suppressions (do-not-contact) ──────────────────────────────────────────

router.get('/suppressions', async (req, res) => {
  try {
    res.json({ suppressions: await Suppression.list() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/suppressions', async (req, res) => {
  try {
    const { email, domain, reason } = req.body || {};
    if (!email && !domain) {
      return res.status(400).json({ error: 'Provide an email address or a domain to suppress.' });
    }

    const suppression = await Suppression.add({
      email,
      domain,
      reason: reason || 'Added manually',
      source: 'manual',
    });
    res.status(201).json({ suppression });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/suppressions/:id', async (req, res) => {
  try {
    const removed = await Suppression.delete(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Suppression not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Scan a reply for opt-out language.
 *
 * Paste in what came back and, when the intent is unambiguous, the sender is
 * suppressed and their queued messages are cancelled. Ambiguous phrases
 * ("not interested") are reported for the user to decide on rather than acted
 * on — see the two tiers in services/outreach/unsubscribe.js.
 */
router.post('/replies/scan', async (req, res) => {
  try {
    const replyText = String(req.body?.replyText || '').trim();
    if (!replyText) return res.status(400).json({ error: 'Paste the reply text to scan.' });
    if (replyText.length > 50000) return res.status(400).json({ error: 'That reply is too long to scan (max 50,000 characters).' });

    const result = await unsubscribe.processReply({
      replyText,
      email: req.body?.email || null,
      leadId: req.body?.leadId || null,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * One-click unsubscribe from an email footer.
 *
 * Public and token-based: the token identifies the exact message that was sent,
 * so the opt-out can be tied to a real send rather than to any address someone
 * types into a URL. Both verbs are handled — GET for the human clicking the
 * link, POST for the RFC 8058 one-click button Gmail and Outlook render.
 */
async function handleUnsubscribe(req, res) {
  const token = req.params.token;
  const message = await Message.findByUnsubscribeToken(token);

  if (!message) {
    return res.status(404).type('html').send(
      '<!doctype html><meta charset="utf-8"><title>Unsubscribe</title>' +
      '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.6">' +
      '<h1>Link not recognised</h1><p>This unsubscribe link is not valid. Reply to the email with "unsubscribe" and you will be removed.</p></body>'
    );
  }

  try {
    await Suppression.add({
      email: message.to_email,
      reason: 'Unsubscribed via the link in an email',
      source: 'unsubscribe_link',
      evidence: `message ${message.id}`,
      lead_id: message.lead_id || null,
    });

    const { query } = require('../config/database');
    await query(
      `UPDATE messages SET status = 'cancelled', error_message = 'Cancelled: recipient unsubscribed', updated_at = ?
       WHERE LOWER(to_email) = ? AND status IN ('draft', 'scheduled')`,
      [new Date().toISOString(), String(message.to_email || '').toLowerCase()]
    );

    if (message.lead_id) {
      await Lead.setReviewStatus(message.lead_id, 'rejected', 'Recipient unsubscribed.').catch(() => {});
    }

    logger.info(`[unsubscribe] ${message.to_email} unsubscribed via link`);

    // One-click clients want a bare 200, not a page.
    if (req.method === 'POST') return res.status(200).json({ success: true });

    res.type('html').send(
      '<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>' +
      '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.6">' +
      '<h1>You have been unsubscribed</h1>' +
      `<p><strong>${String(message.to_email || '').replace(/[<>&]/g, '')}</strong> has been removed from this list and will not be contacted again.</p>` +
      '<p style="color:#64748b;font-size:.9rem">Sorry for the interruption.</p></body>'
    );
  } catch (err) {
    logger.warn(`[unsubscribe] failed for token ${token}: ${err.message}`);
    res.status(500).type('html').send(
      '<!doctype html><meta charset="utf-8"><title>Unsubscribe</title>' +
      '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.6">' +
      '<h1>Something went wrong</h1><p>We could not process that just now. Reply to the email with "unsubscribe" and you will be removed.</p></body>'
    );
  }
}

router.get('/unsubscribe/:token', handleUnsubscribe);
router.post('/unsubscribe/:token', handleUnsubscribe);

// ─── Messages: log, editing, sending ────────────────────────────────────────

/** The sent-message log, and the draft/scheduled queue, from one endpoint. */
router.get('/messages', async (req, res) => {
  try {
    const messages = await Message.list({
      status: req.query.status || null,
      leadId: req.query.leadId || null,
      icpId: req.query.icpId || null,
      limit: Math.min(parseInt(req.query.limit, 10) || 100, 500),
      offset: parseInt(req.query.offset, 10) || 0,
    });

    res.json({ messages: messages.map(withLinks), stats: await Message.getStats() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/messages/:id', async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json({ message: withLinks(message) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Edit a draft — including pasting back what Gemini wrote in the handoff flow.
 *
 * Sending `pastedText` runs it through the same parser the API providers use,
 * so a "Subject: ...\n\n..." blob copied out of a chat window lands in the right
 * two fields instead of the whole thing becoming the body.
 */
router.put('/messages/:id', async (req, res) => {
  try {
    const existing = await Message.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Message not found' });

    if (!Message.isEditable(existing.status)) {
      return res.status(409).json({
        error: `This message is "${existing.status}" and can no longer be edited. The sent log records what was actually delivered.`,
      });
    }

    const body = req.body || {};
    const updates = {};

    if (body.pastedText) {
      const parsed = messageGenerator.parseDraft(body.pastedText);
      updates.subject = messageGenerator.tidySubject(parsed.subject, existing);
      updates.body = messageGenerator.tidyBody(parsed.body);
      updates.generated_by = 'handoff';
    } else {
      if (body.subject !== undefined) updates.subject = String(body.subject).trim();
      if (body.body !== undefined) updates.body = String(body.body);
    }

    if (body.to_email !== undefined) {
      const email = String(body.to_email).trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: `"${email}" is not a valid email address.` });
      }
      updates.to_email = email || null;
    }
    if (body.to_name !== undefined) updates.to_name = String(body.to_name).trim() || null;

    const invalid = validateContent(updates);
    if (invalid) return res.status(400).json({ error: invalid });

    // An edit puts a scheduled message back into the queue as a draft, so a
    // half-finished rewrite cannot go out on the old timer.
    if (existing.status === 'scheduled' && (updates.subject !== undefined || updates.body !== undefined)) {
      updates.status = 'draft';
      updates.scheduled_at = null;
    }
    // Editing a failed message is the user fixing the problem; clear the stale
    // error so the row does not keep reporting a fault that has been addressed.
    if (existing.status === 'failed') {
      updates.status = 'draft';
      updates.error_message = null;
    }

    const message = await Message.update(req.params.id, updates);
    res.json({ message: withLinks(message), rescheduled: updates.status === 'draft' && existing.status === 'scheduled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/messages/:id', async (req, res) => {
  try {
    const existing = await Message.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Message not found' });

    // Sent messages are the log. Deleting one would erase the record of an
    // email the recipient still has in their inbox.
    if (existing.status === 'sent') {
      return res.status(409).json({ error: 'Sent messages cannot be deleted — they are the delivery record.' });
    }

    await Message.delete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Send one message now. */
router.post('/messages/:id/send', async (req, res) => {
  try {
    const result = await mailer.sendMessage(req.params.id);
    if (!result.ok) {
      return res.status(result.alreadySent ? 409 : 400).json({
        error: result.reason,
        code: result.code,
        message: withLinks(result.message),
      });
    }
    res.json({ success: true, dryRun: result.dryRun, message: withLinks(result.message) });
  } catch (err) {
    logger.warn(`Send failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** Queue a message for a chosen time. The scheduler polls and sends it. */
router.post('/messages/:id/schedule', async (req, res) => {
  try {
    const existing = await Message.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Message not found' });
    if (existing.status === 'sent') {
      return res.status(409).json({ error: 'This message has already been sent.' });
    }

    const when = new Date(req.body?.scheduledAt);
    if (Number.isNaN(when.getTime())) {
      return res.status(400).json({ error: 'Provide "scheduledAt" as an ISO date-time.' });
    }
    // A time in the past would fire on the very next poll, which is a
    // surprising way to discover a timezone mistake.
    if (when.getTime() < Date.now() - 60000) {
      return res.status(400).json({ error: 'That time is in the past. Pick a future time, or use Send now.' });
    }

    const blocked = await mailer.blockingReason({ ...existing, ...req.body });
    // A missing recipient or an opt-out will not fix itself before the send
    // time, so refuse now rather than failing silently at 9am.
    if (blocked && blocked.code !== 'daily_limit') {
      return res.status(400).json({ error: blocked.reason, code: blocked.code });
    }

    const message = await Message.update(req.params.id, {
      status: 'scheduled',
      scheduled_at: when.toISOString(),
      error_message: null,
    });

    res.json({ message: withLinks(message), scheduledAt: when.toISOString(), scheduler: scheduler.status() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Pull a scheduled message back out of the queue. */
router.post('/messages/:id/cancel', async (req, res) => {
  try {
    const existing = await Message.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Message not found' });
    if (existing.status === 'sent') {
      return res.status(409).json({ error: 'This message has already been sent and cannot be recalled.' });
    }

    const message = await Message.update(req.params.id, {
      status: 'draft',
      scheduled_at: null,
      error_message: null,
    });
    res.json({ message: withLinks(message) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Send several drafts in one action.
 *
 * Capped by OUTREACH_BULK_SEND_LIMIT, and each message still runs the full
 * per-send check — suppression list, valid address, daily cap — so a bulk send
 * cannot bypass a control that a single send would have caught.
 */
router.post('/messages/send-bulk', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'Provide an "ids" array of message ids.' });

    if (ids.length > config.OUTREACH_BULK_SEND_LIMIT) {
      return res.status(400).json({
        error: `Too many messages in one send (${ids.length}). The limit is ${config.OUTREACH_BULK_SEND_LIMIT} — raise OUTREACH_BULK_SEND_LIMIT if you mean it.`,
      });
    }

    const results = [];
    for (const id of ids) {
      try {
        const result = await mailer.sendMessage(id);
        results.push({ id, ok: result.ok, reason: result.reason || null, code: result.code || null });
      } catch (err) {
        results.push({ id, ok: false, reason: err.message, code: 'threw' });
      }
    }

    const sent = results.filter(r => r.ok).length;
    logger.info(`Bulk send: ${sent}/${ids.length} delivered`);

    res.json({
      sent,
      failed: results.length - sent,
      dryRun: config.OUTREACH_DRY_RUN,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
