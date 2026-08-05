const express = require('express');
const Lead = require('../models/Lead');
const Signal = require('../models/Signal');
const Message = require('../models/Message');
const logger = require('../utils/logger');
const { query } = require('../config/database');

const router = express.Router();

// A bulk action is one HTTP call, so the only thing stopping a runaway request
// is a cap here. Sized well above a realistic "accept all Hot leads" click.
const MAX_BULK_IDS = 1000;

/**
 * Escape one CSV field.
 *
 * The leading-character check is the important part: a value starting with
 * = + - @ is executed as a formula when the file is opened in Excel or Sheets,
 * and these values come from scraped web pages. Prefixing with a quote makes
 * the cell inert while still reading correctly.
 */
function csvCell(value) {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Read a repeatable query parameter as an array of strings. */
function listParam(value) {
  if (value === undefined || value === null || value === '') return null;
  const items = (Array.isArray(value) ? value : String(value).split(','))
    .map(v => String(v).trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

/** Translate the query string into the shape Lead.listFiltered expects. */
function filtersFromQuery(q) {
  return {
    icpId: q.icpId || null,
    tier: listParam(q.tier),
    source: listParam(q.source),
    industry: listParam(q.industry),
    geography: listParam(q.geography || q.geo),
    reviewStatus: listParam(q.reviewStatus || q.review_status),
    search: q.search || q.q || null,
    minScore: q.minScore ?? null,
    maxScore: q.maxScore ?? null,
    discoveredAfter: q.discoveredAfter || q.from || null,
    discoveredBefore: q.discoveredBefore || q.to || null,
    hasEmail: q.hasEmail ?? null,
    sort: q.sort || 'score',
    direction: q.direction || 'desc',
  };
}

// ─── List ───────────────────────────────────────────────────────────────────

/**
 * List leads.
 *
 * Filtering happens in SQL rather than in the browser. The dashboard used to
 * fetch a page of rows and filter them client-side, which meant a filter could
 * only ever see the rows that had already been fetched — anything past the
 * limit was invisible no matter how well it matched.
 */
router.get('/', async (req, res) => {
  try {
    const { limit = 200, offset = 0 } = req.query;
    const filters = filtersFromQuery(req.query);

    const leads = await Lead.listFiltered({
      ...filters,
      limit: Math.min(parseInt(limit, 10) || 200, 1000),
      offset: parseInt(offset, 10) || 0,
    });

    res.json({
      leads,
      counts: await Lead.getReviewCounts(filters.icpId),
    });
  } catch (err) {
    logger.warn(`Lead list failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Get lead statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await Lead.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * The distinct values behind the filter sidebar.
 *
 * Built from the database rather than from the loaded page, so a filter offers
 * every industry and country in the pipeline instead of only those that
 * happened to fit in the current result set.
 */
router.get('/filter-options', async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.query.icpId) {
      where = 'WHERE icp_id = ?';
      params.push(req.query.icpId);
    }

    const distinct = column => query(
      `SELECT DISTINCT ${column} AS value FROM leads ${where}
       ${where ? 'AND' : 'WHERE'} ${column} IS NOT NULL AND ${column} != ''
       ORDER BY value`,
      params
    ).rows.map(r => r.value);

    // Location is stored free-text ("Austin, TX, United States"); the last
    // comma-separated part is the closest thing to a country the data has.
    const countries = [...new Set(
      distinct('company_location').map(loc => String(loc).split(',').pop().trim()).filter(Boolean)
    )].sort();

    res.json({
      industries: distinct('company_industry'),
      sources: distinct('source'),
      geographies: countries,
      tiers: ['hot', 'warm', 'cold'],
      reviewStatuses: Lead.REVIEW_STATUSES,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * CSV export.
 *
 * Defaults to accepted leads only, which is what the phase calls for — the
 * export exists to hand a reviewed list to a CRM or a colleague, and dumping
 * rejected leads into it would defeat the review. Any filter above still
 * applies, so `?reviewStatus=accepted,hold` or `?tier=hot` work too.
 */
router.get('/export.csv', async (req, res) => {
  try {
    const filters = filtersFromQuery(req.query);
    const leads = await Lead.listFiltered({
      ...filters,
      reviewStatus: filters.reviewStatus || ['accepted'],
      limit: 5000,
      offset: 0,
    });

    const columns = [
      ['Company', l => l.company_name],
      ['Website', l => l.company_website],
      ['Industry', l => l.company_industry],
      ['Company Size', l => l.company_size],
      ['Location', l => l.company_location],
      ['Description', l => l.company_description],
      ['Contact Name', l => l.contact_name],
      ['Contact Title', l => l.contact_title],
      ['Contact Email', l => l.contact_email],
      ['Contact Phone', l => l.contact_phone],
      ['Contact LinkedIn', l => l.contact_linkedin],
      ['Score', l => l.total_score],
      ['Tier', l => l.tier],
      ['Intent', l => l.intent_score],
      ['Profile Fit', l => l.profile_fit_score],
      ['Company Fit', l => l.company_fit_score],
      ['Recency', l => l.recency_score],
      ['Engagement', l => l.engagement_score],
      ['Why This Lead', l => l.explanation_text],
      ['Source', l => l.source],
      ['Source URL', l => l.source_url],
      ['Review Status', l => l.review_status || 'pending'],
      ['Reviewed At', l => l.reviewed_at],
      ['Review Note', l => l.review_note],
      ['Notes', l => l.user_notes],
      ['Added Manually', l => (l.is_manual ? 'yes' : 'no')],
      ['Last Contacted', l => l.last_contacted_at],
      ['Discovered At', l => l.discovery_timestamp],
    ];

    const rows = [
      columns.map(([header]) => csvCell(header)).join(','),
      ...leads.map(lead => columns.map(([, read]) => csvCell(read(lead))).join(',')),
    ];

    const stamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leadpulse_leads_${stamp}.csv"`);
    // Excel assumes the system codepage without a BOM, which mangles any
    // non-ASCII company name.
    res.send('﻿' + rows.join('\r\n'));
  } catch (err) {
    logger.warn(`CSV export failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual entry ───────────────────────────────────────────────────────────

/**
 * Add a lead the user found themselves.
 *
 * Deduplicated against the discovered pipeline on the same hash the collectors
 * use, so typing in a company the crawler already found returns that lead
 * instead of creating a second copy of it.
 */
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const companyName = String(body.company_name || '').trim();

    if (!companyName) {
      return res.status(400).json({ error: 'A company name is required.' });
    }

    const email = String(body.contact_email || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: `"${email}" is not a valid email address.` });
    }

    const size = body.company_size === '' || body.company_size === undefined || body.company_size === null
      ? null
      : parseInt(body.company_size, 10);
    if (size !== null && !Number.isFinite(size)) {
      return res.status(400).json({ error: 'Company size must be a number.' });
    }

    const { lead, isNew } = await Lead.createManual(body.icp_id || null, {
      company_name: companyName,
      company_website: body.company_website || null,
      company_industry: body.company_industry || null,
      company_size: size,
      company_location: body.company_location || null,
      company_description: body.company_description || null,
      contact_name: body.contact_name || null,
      contact_email: email || null,
      contact_title: body.contact_title || null,
      contact_linkedin: body.contact_linkedin || null,
      contact_phone: body.contact_phone || null,
      source: 'manual',
      source_url: body.source_url || null,
      user_notes: body.user_notes || null,
      review_status: body.review_status || 'accepted',
      raw_signal_data: { added_by: 'manual_entry', note: body.signal_note || null },
    });

    // A manual lead has no discovery signal, so the note the user typed becomes
    // the trigger the message generator personalises against.
    if (isNew && body.signal_note) {
      await Signal.create(lead.id, {
        signal_type: 'manual_note',
        source: 'manual',
        title: String(body.signal_note).slice(0, 500),
        content: String(body.signal_note).slice(0, 2000),
        relevance_score: 1,
      });
    }

    res.status(isNew ? 201 : 200).json({
      lead,
      isNew,
      message: isNew
        ? 'Lead added.'
        : 'That company is already in your pipeline — opening the existing lead instead of creating a duplicate.',
    });
  } catch (err) {
    logger.warn(`Manual lead creation failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk review ────────────────────────────────────────────────────────────

/**
 * Apply one review decision to many leads — "accept every Hot lead".
 *
 * Takes explicit ids rather than a filter. A filter would be fewer keystrokes,
 * but it would also mean the set acted on is recomputed server-side and can
 * differ from what the user had selected on screen; for an irreversible-feeling
 * action, acting on exactly the rows they ticked is worth the larger request.
 */
router.post('/bulk-review', async (req, res) => {
  try {
    const { ids, reviewStatus, note = null } = req.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Provide an "ids" array of lead ids.' });
    }
    if (ids.length > MAX_BULK_IDS) {
      return res.status(400).json({ error: `Too many leads in one request (max ${MAX_BULK_IDS}).` });
    }
    if (!Lead.REVIEW_STATUSES.includes(reviewStatus)) {
      return res.status(400).json({
        error: `reviewStatus must be one of: ${Lead.REVIEW_STATUSES.join(', ')}.`,
      });
    }

    const result = await Lead.bulkSetReviewStatus(ids, reviewStatus, note);
    logger.info(`Bulk review: ${result.updated} lead(s) set to "${reviewStatus}"`);

    res.json({
      updated: result.updated,
      reviewStatus,
      counts: await Lead.getReviewCounts(req.body?.icpId || null),
    });
  } catch (err) {
    logger.warn(`Bulk review failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// ─── Single lead ────────────────────────────────────────────────────────────

// Get lead detail (including signals, score history and outreach history)
router.get('/:id', async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const scoreResult = query('SELECT * FROM lead_scores WHERE lead_id = ?', [lead.id]);
    const score = scoreResult.rows[0];

    const historyResult = query('SELECT * FROM score_history WHERE lead_id = ? ORDER BY recorded_at ASC', [lead.id]);
    const history = historyResult.rows;

    const signals = await Signal.listByLead(lead.id);
    const messages = await Message.list({ leadId: lead.id, limit: 50 });

    res.json({ lead, score, history, signals, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Accept / Reject / Hold one lead.
 *
 * Separate from PATCH /:id because this is the decision the whole review
 * dashboard exists to capture: it writes review_status (not status), stamps
 * reviewed_at, and is the one endpoint the UI's action buttons call.
 */
router.patch('/:id/review', async (req, res) => {
  try {
    const { reviewStatus, note = null } = req.body || {};

    if (!Lead.REVIEW_STATUSES.includes(reviewStatus)) {
      return res.status(400).json({
        error: `reviewStatus must be one of: ${Lead.REVIEW_STATUSES.join(', ')}.`,
      });
    }

    const existing = await Lead.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    const lead = await Lead.setReviewStatus(req.params.id, reviewStatus, note);
    res.json({ lead, counts: await Lead.getReviewCounts(lead.icp_id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update a lead
router.patch('/:id', async (req, res) => {
  try {
    const lead = await Lead.update(req.params.id, req.body);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a lead
router.delete('/:id', async (req, res) => {
  try {
    const success = await Lead.delete(req.params.id);
    if (!success) return res.status(404).json({ error: 'Lead not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
