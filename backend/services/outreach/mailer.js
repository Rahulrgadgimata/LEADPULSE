// backend/services/outreach/mailer.js
const config = require('../../config/env');
const logger = require('../../utils/logger');
const Message = require('../../models/Message');
const Lead = require('../../models/Lead');
const Suppression = require('../../models/Suppression');
const unsubscribe = require('./unsubscribe');

/**
 * Outbound email delivery over SMTP.
 *
 * Works with SendGrid (smtp.sendgrid.net, user "apikey"), Gmail app passwords,
 * or any other relay — SMTP is the common denominator, so switching provider is
 * a .env change rather than a code change.
 *
 * Everything that can stop a send is checked here rather than at the call
 * sites, because there are several ways to trigger one (manual, bulk, the
 * scheduler) and a check that lives in only some of them is not a check.
 */

// nodemailer is required lazily so the app still boots and the dashboard still
// works when it is not installed — outreach degrades to drafts-only rather than
// taking the whole server down.
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (err) {
  logger.warn('[mailer] nodemailer is not installed — sending is disabled. Run: npm install nodemailer');
}

let transporter = null;
let verifiedAt = null;

function isConfigured() {
  return Boolean(nodemailer && config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS);
}

function fromAddress() {
  const email = config.MAIL_FROM_EMAIL || config.SMTP_USER;
  if (!email) return null;
  return config.MAIL_FROM_NAME ? `"${config.MAIL_FROM_NAME}" <${email}>` : email;
}

function getTransport() {
  if (!isConfigured()) {
    throw new Error(
      'SMTP is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS in .env ' +
      '(SendGrid: host smtp.sendgrid.net, user "apikey", pass = your API key).'
    );
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
      // One connection reused across a bulk send. Relays throttle hard on
      // connection churn, and opening a fresh session per message is the
      // fastest way to look like a spammer to your own provider.
      pool: true,
      maxConnections: 3,
      maxMessages: 50,
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }

  return transporter;
}

/**
 * Check the credentials without sending anything.
 *
 * Runs the real SMTP handshake even in dry-run mode. Dry run means "send no
 * mail", not "open no connection" — and checking that the credentials work is
 * exactly what you want to do *before* turning dry run off. Skipping the check
 * here would mean the first real send is also the first time the login is
 * tested.
 */
async function verify() {
  if (!nodemailer) {
    return { ok: false, message: 'nodemailer is not installed. Run: npm install nodemailer' };
  }
  if (!isConfigured()) {
    return { ok: false, message: 'SMTP_HOST, SMTP_USER and SMTP_PASS must all be set in .env.' };
  }

  try {
    await getTransport().verify();
    verifiedAt = new Date().toISOString();
    return {
      ok: true,
      dryRun: config.OUTREACH_DRY_RUN,
      message: `SMTP ready: ${config.SMTP_USER} via ${config.SMTP_HOST}:${config.SMTP_PORT}` +
        (config.OUTREACH_DRY_RUN ? ' — dry run is on, so nothing will actually be delivered.' : ''),
      verifiedAt,
    };
  } catch (err) {
    // A failed verify leaves a transport that will keep failing; drop it so the
    // next attempt reconnects with whatever the user just fixed.
    transporter = null;

    // Gmail rejects an account password here and only accepts an App Password,
    // which is the mistake this setup invites — name it rather than passing
    // "Username and Password not accepted" straight through.
    const hint = /invalid login|username and password not accepted|badcredentials/i.test(err.message)
      ? ' Gmail needs 2-Step Verification enabled and a 16-character App Password ' +
        '(https://myaccount.google.com/apppasswords) — an ordinary account password is always refused.'
      : '';

    return { ok: false, message: `SMTP check failed: ${err.message}.${hint}` };
  }
}

function status() {
  return {
    configured: isConfigured(),
    dryRun: config.OUTREACH_DRY_RUN,
    host: config.SMTP_HOST || null,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    from: fromAddress(),
    replyTo: config.MAIL_REPLY_TO || null,
    nodemailerInstalled: Boolean(nodemailer),
    verifiedAt,
    dailyLimit: config.OUTREACH_DAILY_SEND_LIMIT,
    unsubscribeLinksEnabled: Boolean(config.APP_BASE_URL),
  };
}

/**
 * Everything that must be true before a message may go out.
 * Returns null when the send may proceed, or {reason, code} when it may not.
 */
async function blockingReason(message) {
  if (!message.to_email) {
    return { code: 'no_recipient', reason: 'This lead has no email address. Add one on the lead, or export it and send by hand.' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(message.to_email).trim())) {
    return { code: 'bad_recipient', reason: `"${message.to_email}" is not a valid email address.` };
  }
  if (!message.body || !String(message.body).trim()) {
    return { code: 'empty_body', reason: 'The message body is empty.' };
  }

  const suppressed = await Suppression.isSuppressed(message.to_email);
  if (suppressed) {
    return {
      code: 'suppressed',
      reason: `${message.to_email} is on the do-not-contact list (${suppressed.reason || suppressed.source}).`,
    };
  }

  // The rolling cap is the last line of defence against a bulk action that was
  // bigger than the user realised.
  const sentToday = await Message.sentInLastDay();
  if (sentToday >= config.OUTREACH_DAILY_SEND_LIMIT) {
    return {
      code: 'daily_limit',
      reason: `Daily send limit reached (${sentToday}/${config.OUTREACH_DAILY_SEND_LIMIT} in the last 24h). Raise OUTREACH_DAILY_SEND_LIMIT or wait.`,
    };
  }

  return null;
}

/**
 * Send one message and record the outcome on its row.
 *
 * The row is claimed before the network call (see Message.claimForSending), so
 * a manual send racing the scheduler cannot mail the same prospect twice.
 */
async function sendMessage(messageId) {
  const existing = await Message.findById(messageId);
  if (!existing) throw new Error('Message not found.');

  if (existing.status === 'sent') {
    return { ok: false, alreadySent: true, message: existing, reason: 'This message was already sent.' };
  }

  const blocked = await blockingReason(existing);
  if (blocked) {
    const updated = await Message.update(messageId, {
      status: blocked.code === 'suppressed' ? 'cancelled' : 'failed',
      error_message: blocked.reason,
    });
    return { ok: false, code: blocked.code, reason: blocked.reason, message: updated };
  }

  const claimed = await Message.claimForSending(messageId);
  if (!claimed) {
    const current = await Message.findById(messageId);
    return {
      ok: false,
      code: 'not_claimable',
      reason: `This message is ${current?.status || 'unavailable'} and cannot be sent right now.`,
      message: current,
    };
  }

  const from = fromAddress();
  if (!from && !config.OUTREACH_DRY_RUN) {
    const reason = 'No sender address configured. Set MAIL_FROM_EMAIL (or SMTP_USER) in .env.';
    const updated = await Message.update(messageId, { status: 'failed', error_message: reason });
    return { ok: false, code: 'no_sender', reason, message: updated };
  }

  // The footer is appended at send time, not at draft time: it carries this
  // message's own unsubscribe token, and a user editing the draft should not be
  // able to delete the opt-out line by accident.
  const bodyWithFooter = String(claimed.body).trimEnd() + unsubscribe.footerFor(claimed);
  const unsubscribeUrl = unsubscribe.linkFor(claimed);

  try {
    let providerMessageId = null;

    if (config.OUTREACH_DRY_RUN) {
      providerMessageId = `dry-run-${claimed.id}`;
      logger.info(`[mailer] DRY RUN — would send "${claimed.subject}" to ${claimed.to_email}`);
    } else {
      const info = await getTransport().sendMail({
        from,
        to: claimed.to_name ? `"${claimed.to_name}" <${claimed.to_email}>` : claimed.to_email,
        replyTo: config.MAIL_REPLY_TO || undefined,
        subject: claimed.subject || '(no subject)',
        text: bodyWithFooter,
        // List-Unsubscribe is what makes the native "Unsubscribe" button appear
        // in Gmail and Outlook. Offering it measurably reduces spam reports,
        // which is what protects the sending domain.
        headers: unsubscribeUrl
          ? {
              'List-Unsubscribe': `<${unsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            }
          : undefined,
      });
      providerMessageId = info.messageId || null;
    }

    const sentAt = new Date().toISOString();
    const updated = await Message.update(messageId, {
      status: 'sent',
      sent_at: sentAt,
      provider_message_id: providerMessageId,
      error_message: null,
      send_attempts: (claimed.send_attempts || 0) + 1,
      body: bodyWithFooter,
    });

    if (claimed.lead_id) {
      try {
        await Lead.update(claimed.lead_id, { last_contacted_at: sentAt });
      } catch (err) {
        logger.warn(`[mailer] could not stamp lead ${claimed.lead_id}: ${err.message}`);
      }
    }

    logger.info(`[mailer] sent "${claimed.subject}" to ${claimed.to_email}${config.OUTREACH_DRY_RUN ? ' (dry run)' : ''}`);
    return { ok: true, dryRun: config.OUTREACH_DRY_RUN, message: updated };
  } catch (err) {
    // Failed sends stay visible as 'failed' with the provider's own words, so
    // the user can act on "mailbox full" differently from "auth failed".
    const updated = await Message.update(messageId, {
      status: 'failed',
      error_message: err.message,
      send_attempts: (claimed.send_attempts || 0) + 1,
    });

    // A broken pooled connection poisons every later send; drop it.
    if (/ECONN|ETIMEDOUT|socket|connection/i.test(err.message)) transporter = null;

    logger.warn(`[mailer] send failed for ${claimed.to_email}: ${err.message}`);
    return { ok: false, code: 'send_failed', reason: err.message, message: updated };
  }
}

module.exports = {
  sendMessage,
  verify,
  status,
  isConfigured,
  fromAddress,
  blockingReason,
};
