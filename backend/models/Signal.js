// backend/models/Signal.js
const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

/**
 * Signal model – represents a raw discovered signal (news, job, Reddit post, tweet, etc.)
 */
class Signal {
  static async create(leadId, data) {
    const sql = `INSERT INTO signals (id, lead_id, signal_type, source, source_url, title, content, relevance_score, detected_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const id = uuidv4();
    const now = new Date().toISOString();
    const params = [
      id,
      leadId,
      data.signal_type || 'unknown',
      data.source || null,
      data.source_url || null,
      data.title || null,
      data.content || null,
      data.relevance_score || 0,
      data.detected_at || now,
      now,
    ];
    query(sql, params);
    return this.findById(id);
  }

  static async findById(id) {
    const result = query('SELECT * FROM signals WHERE id = ?', [id]);
    return result.rows[0];
  }

  static async listByLead(leadId) {
    const result = query('SELECT * FROM signals WHERE lead_id = ? ORDER BY detected_at DESC', [leadId]);
    return result.rows;
  }

  /**
   * Most recently detected signals across all leads, carrying the company they
   * belong to. Backs the live discovery stream, which otherwise has no way to
   * show what the collectors actually found.
   */
  static async listRecent(limit = 20, icpId = null) {
    const params = [];
    let where = '';
    if (icpId) {
      where = 'WHERE l.icp_id = ?';
      params.push(icpId);
    }
    params.push(limit);

    const result = query(
      `SELECT s.id, s.signal_type, s.source, s.source_url, s.title,
              s.relevance_score, s.detected_at,
              l.id AS lead_id, l.company_name, l.company_website,
              sc.total_score, sc.tier
       FROM signals s
       JOIN leads l ON l.id = s.lead_id
       LEFT JOIN lead_scores sc ON sc.lead_id = l.id
       ${where}
       ORDER BY s.detected_at DESC
       LIMIT ?`,
      params
    );
    return result.rows;
  }
}

module.exports = Signal;
