// backend/models/ScoreHistory.js
const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

/**
 * ScoreHistory model – tracks historical total scores for a lead.
 */
class ScoreHistory {
  static async add(leadId, totalScore) {
    const sql = `INSERT INTO score_history (id, lead_id, total_score, recorded_at)
                 VALUES (?, ?, ?, ?)`;
    const id = uuidv4();
    const now = new Date().toISOString();
    query(sql, [id, leadId, totalScore, now]);
    return { id, lead_id: leadId, total_score: totalScore, recorded_at: now };
  }

  static async listByLead(leadId) {
    const result = query('SELECT * FROM score_history WHERE lead_id = ? ORDER BY recorded_at DESC', [leadId]);
    return result.rows;
  }
}

module.exports = ScoreHistory;
