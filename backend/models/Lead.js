// backend/models/Lead.js
const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// The four states a human review can leave a lead in. Anything else is
// rejected at the model boundary so a typo in a request body cannot create a
// fifth state that no filter or count knows about.
const REVIEW_STATUSES = ['pending', 'accepted', 'rejected', 'hold'];

// Columns the list view is allowed to sort by. Sort keys arrive from the query
// string and are interpolated into SQL (bind parameters cannot name a column),
// so they must come from a fixed list rather than from the request.
const SORTABLE = {
  score: 'COALESCE(s.total_score, 0)',
  discovered: 'l.discovery_timestamp',
  company: 'l.company_name',
  reviewed: 'l.reviewed_at',
};

// Projection shared by every lead list, so the UI gets identical fields no
// matter which filter path produced the rows.
const LIST_COLUMNS = `l.*, s.total_score, s.tier, s.explanation_text,
              s.intent_score, s.profile_fit_score, s.company_fit_score,
              s.recency_score, s.engagement_score`;

/**
 * Lead model
 */
class Lead {
  static get REVIEW_STATUSES() {
    return [...REVIEW_STATUSES];
  }

  static async create(icpId, data) {
    const sql = `INSERT INTO leads (id, icp_id, company_name, company_website, company_industry, company_size, company_location, company_description, contact_name, contact_email, contact_title, contact_linkedin, contact_phone, source, source_url, raw_signal_data, dedup_hash, status, discovery_timestamp, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const id = uuidv4();
    const now = new Date().toISOString();
    const params = [
      id,
      icpId,
      data.company_name || null,
      data.company_website || null,
      data.company_industry || null,
      data.company_size || null,
      data.company_location || null,
      data.company_description || null,
      data.contact_name || null,
      data.contact_email || null,
      data.contact_title || null,
      data.contact_linkedin || null,
      data.contact_phone || null,
      data.source || null,
      data.source_url || null,
      JSON.stringify(data.raw_signal_data || {}),
      data.dedup_hash || null,
      data.status || 'new',
      data.discovery_timestamp || now,
      now,
      now,
    ];
    query(sql, params);
    return this.findById(id);
  }

  static async findById(id) {
    const result = query('SELECT * FROM leads WHERE id = ?', [id]);
    return result.rows[0];
  }

  static async findByHash(hash) {
    const result = query('SELECT * FROM leads WHERE dedup_hash = ?', [hash]);
    return result.rows[0];
  }

  /**
   * One lead with its score dimensions attached.
   *
   * The message generator personalises against the score explanation when a
   * lead has no signal rows, and a plain findById does not carry it — score
   * fields live on lead_scores.
   */
  static async findByIdWithScore(id) {
    const result = query(
      `SELECT ${LIST_COLUMNS}
       FROM leads l
       LEFT JOIN lead_scores s ON l.id = s.lead_id
       WHERE l.id = ?`,
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Leads for one ICP, joined with their score.
   *
   * The join matters: the UI renders score and tier for every lead, so without
   * it an ICP-filtered view shows unscored cards while the unfiltered view
   * (which does join) looks fine.
   */
  static async listByIcp(icpId, limit = 100, offset = 0) {
    const result = query(
      `SELECT ${LIST_COLUMNS}
       FROM leads l
       LEFT JOIN lead_scores s ON l.id = s.lead_id
       WHERE l.icp_id = ?
         AND (l.status IS NULL OR l.status != 'discarded')
       ORDER BY COALESCE(s.total_score, 0) DESC, l.discovery_timestamp DESC
       LIMIT ? OFFSET ?`,
      [icpId, limit, offset]
    );
    return result.rows;
  }

  /**
   * The Lead Review Dashboard's list query: every filter the sidebar offers,
   * resolved in SQL rather than in the browser.
   *
   * Filtering server-side matters once a pipeline outgrows one page — the UI
   * used to pull 500 rows and filter them in JavaScript, so anything past the
   * limit was invisible to a filter no matter what it matched.
   *
   * Multi-value filters (`tier`, `source`, `industry`) accept an array or a
   * comma-separated string and are OR'd within a group, AND'd across groups.
   */
  static async listFiltered({
    icpId = null, tier = null, source = null, industry = null, geography = null,
    reviewStatus = null, search = null, minScore = null, maxScore = null,
    discoveredAfter = null, discoveredBefore = null,
    hasEmail = null, sort = 'score', direction = 'desc',
    limit = 200, offset = 0,
  } = {}) {
    const where = ['(l.status IS NULL OR l.status != \'discarded\')'];
    const params = [];

    const asList = value => {
      if (value === null || value === undefined || value === '') return [];
      const items = Array.isArray(value) ? value : String(value).split(',');
      return items.map(v => String(v).trim()).filter(Boolean);
    };

    const addInClause = (column, value) => {
      const items = asList(value);
      if (items.length === 0) return;
      where.push(`${column} IN (${items.map(() => '?').join(', ')})`);
      params.push(...items);
    };

    if (icpId) {
      where.push('l.icp_id = ?');
      params.push(icpId);
    }

    addInClause('s.tier', tier);
    addInClause('l.source', source);
    addInClause('l.company_industry', industry);

    // review_status predates its own backfill in some databases; treat NULL as
    // pending so old rows are still reachable by the default filter.
    const reviewList = asList(reviewStatus);
    if (reviewList.length > 0) {
      const clause = reviewList.map(() => '?').join(', ');
      where.push(
        reviewList.includes('pending')
          ? `(COALESCE(l.review_status, 'pending') IN (${clause}))`
          : `(l.review_status IN (${clause}))`
      );
      params.push(...reviewList);
    }

    // Geography is a free-text location string, so match on substrings rather
    // than equality: "Austin, TX, United States" has to match "United States".
    const geoList = asList(geography);
    if (geoList.length > 0) {
      where.push(`(${geoList.map(() => 'l.company_location LIKE ?').join(' OR ')})`);
      params.push(...geoList.map(g => `%${g}%`));
    }

    if (search) {
      const term = `%${String(search).trim()}%`;
      where.push(`(l.company_name LIKE ? OR l.contact_name LIKE ? OR l.contact_title LIKE ?
                   OR l.company_industry LIKE ? OR l.company_location LIKE ?
                   OR l.contact_email LIKE ?)`);
      params.push(term, term, term, term, term, term);
    }

    if (minScore !== null && minScore !== '' && Number.isFinite(Number(minScore))) {
      where.push('COALESCE(s.total_score, 0) >= ?');
      params.push(Number(minScore));
    }
    if (maxScore !== null && maxScore !== '' && Number.isFinite(Number(maxScore))) {
      where.push('COALESCE(s.total_score, 0) <= ?');
      params.push(Number(maxScore));
    }

    // Timestamps are ISO-8601 strings, which sort lexicographically in the same
    // order they sort chronologically, so a plain string comparison is correct.
    if (discoveredAfter) {
      where.push('COALESCE(l.discovery_timestamp, l.created_at) >= ?');
      params.push(discoveredAfter);
    }
    if (discoveredBefore) {
      where.push('COALESCE(l.discovery_timestamp, l.created_at) <= ?');
      params.push(discoveredBefore);
    }

    if (hasEmail === true || hasEmail === 'true') {
      where.push("l.contact_email IS NOT NULL AND l.contact_email != ''");
    }

    const orderColumn = SORTABLE[sort] || SORTABLE.score;
    const orderDirection = String(direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    params.push(Number(limit) || 200, Number(offset) || 0);

    const result = query(
      `SELECT ${LIST_COLUMNS}
       FROM leads l
       LEFT JOIN lead_scores s ON l.id = s.lead_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderColumn} ${orderDirection}, l.discovery_timestamp DESC
       LIMIT ? OFFSET ?`,
      params
    );
    return result.rows;
  }

  /**
   * Record a human review decision.
   *
   * Writes review_status rather than status so a later rescore, which sets
   * status to 'scored', cannot quietly undo an accept.
   */
  static async setReviewStatus(id, reviewStatus, note = null) {
    if (!REVIEW_STATUSES.includes(reviewStatus)) {
      throw new Error(`Unknown review status "${reviewStatus}". Expected one of: ${REVIEW_STATUSES.join(', ')}.`);
    }

    const now = new Date().toISOString();
    // Returning to 'pending' is an un-review, so the timestamp goes with it —
    // leaving a stale reviewed_at would make the lead look decided.
    const reviewedAt = reviewStatus === 'pending' ? null : now;

    query(
      `UPDATE leads
       SET review_status = ?, reviewed_at = ?, review_note = COALESCE(?, review_note), updated_at = ?
       WHERE id = ?`,
      [reviewStatus, reviewedAt, note, now, id]
    );
    return this.findById(id);
  }

  /**
   * Apply one decision to many leads at once — "accept every Hot lead".
   *
   * Runs as a single transaction so a bulk accept either lands completely or
   * not at all; a half-applied bulk action would leave the user unsure which
   * leads they had actually decided on.
   */
  static async bulkSetReviewStatus(ids, reviewStatus, note = null) {
    if (!REVIEW_STATUSES.includes(reviewStatus)) {
      throw new Error(`Unknown review status "${reviewStatus}". Expected one of: ${REVIEW_STATUSES.join(', ')}.`);
    }

    const unique = [...new Set((ids || []).map(String).filter(Boolean))];
    if (unique.length === 0) return { updated: 0, ids: [] };

    const now = new Date().toISOString();
    const reviewedAt = reviewStatus === 'pending' ? null : now;

    const { db } = require('../config/database');
    const statement = db.prepare(
      `UPDATE leads
       SET review_status = ?, reviewed_at = ?, review_note = COALESCE(?, review_note), updated_at = ?
       WHERE id = ?`
    );

    const applyAll = db.transaction(leadIds => {
      let updated = 0;
      for (const leadId of leadIds) {
        updated += statement.run(reviewStatus, reviewedAt, note, now, leadId).changes;
      }
      return updated;
    });

    return { updated: applyAll(unique), ids: unique };
  }

  /**
   * A lead the user found themselves, outside the AI pipeline.
   *
   * Manual leads are marked with is_manual and start at review_status
   * 'accepted': the user typing a lead in by hand has already made the decision
   * the review queue exists to capture.
   */
  static async createManual(icpId, data) {
    const DedupService = require('../services/dedup');
    const hash = DedupService.generateHash(
      data.company_name,
      data.contact_email,
      data.company_website
    );

    const existing = await this.findByHash(hash);
    if (existing) {
      return { lead: existing, isNew: false };
    }

    const lead = await this.create(icpId, {
      ...data,
      dedup_hash: hash,
      source: data.source || 'manual',
      status: 'scored',
    });

    const now = new Date().toISOString();
    query(
      `UPDATE leads SET is_manual = 1, review_status = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
      [data.review_status || 'accepted', now, now, lead.id]
    );

    return { lead: await this.findById(lead.id), isNew: true };
  }

  /** Review-queue counts for the dashboard header. */
  static async getReviewCounts(icpId = null) {
    const params = [];
    let where = '';
    if (icpId) {
      where = 'WHERE icp_id = ?';
      params.push(icpId);
    }

    const rows = query(
      `SELECT COALESCE(review_status, 'pending') AS review_status, COUNT(*) AS count
       FROM leads ${where} GROUP BY COALESCE(review_status, 'pending')`,
      params
    ).rows;

    const counts = { pending: 0, accepted: 0, rejected: 0, hold: 0 };
    for (const row of rows) {
      if (row.review_status in counts) counts[row.review_status] = row.count;
    }
    return counts;
  }

  static async updateScore(id, scoreData) {
    const sql = `UPDATE leads SET updated_at = ?, status = ? WHERE id = ?`;
    const now = new Date().toISOString();
    query(sql, [now, scoreData.status || 'scored', id]);
    return this.findById(id);
  }

  static async update(id, updates) {
    const fields = [];
    const params = [];
    const allowed = ['company_name', 'company_website', 'company_industry', 'company_size', 'company_location', 'company_description', 'contact_name', 'contact_email', 'contact_title', 'contact_linkedin', 'contact_phone', 'status', 'user_notes', 'review_note', 'last_contacted_at'];
    for (const [key, value] of Object.entries(updates)) {
      if (allowed.includes(key)) {
        fields.push(`${key} = ?`);
        params.push(value);
      }
    }
    if (fields.length === 0) return this.findById(id);
    fields.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    query(`UPDATE leads SET ${fields.join(', ')} WHERE id = ?`, params);
    return this.findById(id);
  }

  static async delete(id) {
    // SQLite schema has no ON DELETE CASCADE — clear dependents first.
    query('DELETE FROM signals WHERE lead_id = ?', [id]);
    query('DELETE FROM lead_scores WHERE lead_id = ?', [id]);
    query('DELETE FROM score_history WHERE lead_id = ?', [id]);

    // Drafts and scheduled sends go with the lead: leaving a scheduled message
    // behind would mail a prospect the user had just deleted. Messages already
    // sent are kept — the log is a record of what happened, and deleting the
    // lead does not un-send them.
    query(`DELETE FROM messages WHERE lead_id = ? AND status != 'sent'`, [id]);

    const result = query('DELETE FROM leads WHERE id = ?', [id]);
    return result.rowCount > 0;
  }

  static async getStats() {
    const total = query('SELECT COUNT(*) as count FROM leads').rows[0].count;
    const byTier = query('SELECT tier, COUNT(*) as count FROM lead_scores GROUP BY tier').rows;
    const recent = query(`SELECT COUNT(*) as count FROM leads WHERE created_at >= datetime('now', '-7 days')`).rows[0].count;
    const review = await this.getReviewCounts();
    return { total, byTier, recent, review };
  }
}

module.exports = Lead;
