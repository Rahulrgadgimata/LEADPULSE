// backend/services/outreach/unsubscribe.js
const config = require('../../config/env');
const logger = require('../../utils/logger');
const Suppression = require('../../models/Suppression');
const Lead = require('../../models/Lead');

/**
 * Opt-out handling: detecting it in a reply, honouring it on every send.
 *
 * Two routes in. A recipient can click the unsubscribe link in the footer, or
 * they can just reply "take me off your list" — which is what most people
 * actually do. The second route is why the keyword scanner exists.
 */

/**
 * Phrases that mean "stop emailing me".
 *
 * Two tiers, because the cost of the two mistakes is not symmetric. A missed
 * opt-out means emailing someone who told you to stop — a legal and reputational
 * problem. A false positive means one lead goes quiet, which the user can undo
 * in the suppression list. So `STRONG` acts on its own, while `SOFT` phrases —
 * which appear innocently in ordinary replies ("not interested in that one, but
 * tell me about...") — only flag for review.
 */
const STRONG_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bopt(?:ed)?[\s-]?out\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bdo not (?:contact|email|write|reach out)\b/i,
  /\bdon'?t (?:contact|email) me\b/i,
  /\bstop (?:emailing|contacting|messaging)\b/i,
  /\bno longer wish to (?:receive|be contacted)\b/i,
  /\bdelete my (?:data|details|information|email)\b/i,
  /\bcease (?:all )?communication\b/i,
];

const SOFT_PATTERNS = [
  /\bnot interested\b/i,
  /\bplease stop\b/i,
  /\bwrong person\b/i,
  /\bno thanks?\b/i,
  /\bi(?:'m| am) not the right (?:person|contact)\b/i,
];

/**
 * Reduce a pasted reply to the part the person actually just wrote.
 *
 * This has to happen before any keyword matching. Our own emails carry an
 * unsubscribe footer, so every reply in a thread quotes the word
 * "unsubscribe" — scanning the raw paste would suppress the people who replied
 * "sure, let's talk", which is the worst possible outcome for this feature.
 *
 * Three passes, in this order:
 *   1. Drop a leading header block. People paste replies starting with
 *      "From: ... / Subject: ...", and a `from:` line is also a quote marker,
 *      so cutting at the first marker without this would discard the entire
 *      message and leave only the quoted history to scan.
 *   2. Cut at the first quoted-history marker.
 *   3. Drop any remaining "> " quoted lines.
 */
function newContentOf(text) {
  const original = String(text || '');

  const withoutHeaders = original.replace(
    /^(?:[ \t]*(?:from|to|cc|bcc|date|sent|subject|reply-to)[ \t]*:.*(?:\r?\n|$))+/i,
    ''
  );

  const markerAt = withoutHeaders.search(
    /^[ \t]*(?:on\b.{0,300}\bwrote:|-{2,}\s*original message\s*-{2,}|_{5,}|from[ \t]*:[ \t])/im
  );
  const beforeQuote = markerAt === -1 ? withoutHeaders : withoutHeaders.slice(0, markerAt);

  return beforeQuote
    .split('\n')
    .filter(line => !/^\s*>/.test(line))
    .join('\n')
    .trim();
}

/**
 * Read a reply for opt-out intent.
 */
function scanText(text) {
  const original = String(text || '');
  const body = newContentOf(original);

  // If stripping left nothing, the paste was quoted history only. Scan it
  // anyway — the user deliberately submitted it — but there is no fresh reply
  // to weigh, so this is exactly the case the caller reviews before acting.
  const haystack = body || original;

  const strong = STRONG_PATTERNS.filter(p => p.test(haystack));
  const soft = SOFT_PATTERNS.filter(p => p.test(haystack));

  const matched = [...strong, ...soft].map(pattern => {
    const found = haystack.match(pattern);
    return found ? found[0] : String(pattern);
  });

  return {
    isOptOut: strong.length > 0,
    needsReview: strong.length === 0 && soft.length > 0,
    confidence: strong.length > 0 ? 'high' : soft.length > 0 ? 'low' : 'none',
    matchedPhrases: matched,
    // A short excerpt is stored as evidence so a suppression can be explained
    // — and reversed — months later.
    excerpt: haystack.slice(0, 400),
  };
}

/**
 * Find the email address a reply came from, so a pasted reply can be matched to
 * a lead without the user retyping the address.
 */
function extractSenderEmail(text) {
  const raw = String(text || '');

  const fromHeader = raw.match(/^\s*from:\s*.*?<([^>]+@[^>]+)>/im) ||
                     raw.match(/^\s*from:\s*([^\s<>@]+@[^\s<>,;]+)/im);
  if (fromHeader) return fromHeader[1].trim().toLowerCase();

  const anyAddress = raw.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return anyAddress ? anyAddress[0].toLowerCase() : null;
}

/**
 * Process a reply: suppress the sender when the intent is unambiguous, and
 * take the lead out of future sends.
 *
 * Cancels the lead's queued messages too. Suppression alone would block them at
 * send time, but leaving them sitting in the queue marked "scheduled" tells the
 * user a message is going out when it never will.
 */
async function processReply({ replyText, email = null, leadId = null }) {
  const scan = scanText(replyText);
  const address = (email || extractSenderEmail(replyText) || '').toLowerCase();

  const result = {
    ...scan,
    email: address || null,
    suppressed: false,
    cancelledMessages: 0,
    leadId: leadId || null,
  };

  if (!scan.isOptOut) return result;

  if (!address) {
    // The intent is clear but there is nobody to suppress. Say so rather than
    // reporting a success the user would reasonably read as "handled".
    result.error = 'Opt-out language detected, but no email address was found in the reply. Add the address manually to suppress it.';
    return result;
  }

  const { query } = require('../../config/database');

  // Match the reply back to a lead when the caller did not name one, so the
  // lead's own review status can be updated too.
  let resolvedLeadId = leadId;
  if (!resolvedLeadId) {
    const found = (await query('SELECT id FROM leads WHERE LOWER(contact_email) = ? LIMIT 1', [address])).rows[0];
    resolvedLeadId = found?.id || null;
  }

  await Suppression.add({
    email: address,
    reason: 'Opt-out detected in a reply',
    source: 'reply_keyword',
    evidence: `${scan.matchedPhrases.join(', ')} — "${scan.excerpt.slice(0, 200)}"`,
    lead_id: resolvedLeadId,
  });

  const cancelled = await query(
    `UPDATE messages SET status = 'cancelled',
            error_message = 'Cancelled: recipient opted out',
            updated_at = ?
     WHERE LOWER(to_email) = ? AND status IN ('draft', 'scheduled')`,
    [new Date().toISOString(), address]
  );

  if (resolvedLeadId) {
    try {
      await Lead.setReviewStatus(resolvedLeadId, 'rejected', 'Recipient opted out of further contact.');
    } catch (err) {
      logger.warn(`[unsubscribe] could not update lead ${resolvedLeadId}: ${err.message}`);
    }
  }

  logger.info(`[unsubscribe] suppressed ${address} (${cancelled.rowCount} queued message(s) cancelled)`);

  result.suppressed = true;
  result.cancelledMessages = cancelled.rowCount;
  result.leadId = resolvedLeadId;
  return result;
}

/** The one-click unsubscribe URL for a message, or null if no public origin is set. */
function linkFor(message) {
  if (!config.APP_BASE_URL || !message?.unsubscribe_token) return null;
  return `${config.APP_BASE_URL}/api/outreach/unsubscribe/${message.unsubscribe_token}`;
}

/**
 * The footer appended to every outbound email.
 *
 * When APP_BASE_URL is unset there is no link that would work for a recipient,
 * so the footer falls back to a reply instruction — which the scanner above
 * then handles. An unsubscribe line that 404s is worse than no link at all.
 */
function footerFor(message) {
  const link = linkFor(message);
  return link
    ? `\n\n—\nNot the right person, or would you rather not hear from me? Unsubscribe: ${link}`
    : '\n\n—\nIf you would rather not hear from me, just reply "unsubscribe" and I will remove you.';
}

module.exports = {
  scanText,
  newContentOf,
  extractSenderEmail,
  processReply,
  linkFor,
  footerFor,
  STRONG_PATTERNS,
  SOFT_PATTERNS,
};
