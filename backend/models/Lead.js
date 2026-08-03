// backend/models/Lead.js
const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

/**
 * Lead model
 */
class Lead {
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
   * Leads for one ICP, joined with their score.
   *
   * The join matters: the UI renders score and tier for every lead, so without
   * it an ICP-filtered view shows unscored cards while the unfiltered view
   * (which does join) looks fine.
   */
  static async listByIcp(icpId, limit = 100, offset = 0) {
    const result = query(
      `SELECT l.*, s.total_score, s.tier, s.explanation_text,
              s.intent_score, s.profile_fit_score, s.company_fit_score,
              s.recency_score, s.engagement_score
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

  static async updateScore(id, scoreData) {
    const sql = `UPDATE leads SET updated_at = ?, status = ? WHERE id = ?`;
    const now = new Date().toISOString();
    query(sql, [now, scoreData.status || 'scored', id]);
    return this.findById(id);
  }

  static async update(id, updates) {
    const fields = [];
    const params = [];
    const allowed = ['company_name', 'company_website', 'company_industry', 'company_size', 'company_location', 'company_description', 'contact_name', 'contact_email', 'contact_title', 'contact_linkedin', 'contact_phone', 'status'];
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
    const result = query('DELETE FROM leads WHERE id = ?', [id]);
    return result.rowCount > 0;
  }

  static async getStats() {
    const total = query('SELECT COUNT(*) as count FROM leads').rows[0].count;
    const byTier = query('SELECT tier, COUNT(*) as count FROM lead_scores GROUP BY tier').rows;
    const recent = query(`SELECT COUNT(*) as count FROM leads WHERE created_at >= datetime('now', '-7 days')`).rows[0].count;
    return { total, byTier, recent };
  }
}

module.exports = Lead;
