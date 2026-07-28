const { query } = require('../config/database');

class Signal {
  /**
   * Create a new signal
   */
  static async create(signalData) {
    const sql = `
      INSERT INTO signals (lead_id, signal_type, source, source_url,
        title, content, relevance_score, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `;
    const result = await query(sql, [
      signalData.lead_id, signalData.signal_type, signalData.source,
      signalData.source_url, signalData.title, signalData.content,
      signalData.relevance_score || 0, JSON.stringify(signalData.metadata || {}),
    ]);
    return result.rows[0];
  }

  /**
   * Get signals for a lead
   */
  static async getByLead(leadId, limit = 50) {
    const result = await query(
      `SELECT * FROM signals WHERE lead_id = $1
       ORDER BY detected_at DESC LIMIT $2`,
      [leadId, limit]
    );
    return result.rows;
  }

  /**
   * Get signals by type
   */
  static async getByType(signalType, limit = 100) {
    const result = await query(
      `SELECT s.*, l.company_name, l.contact_name
       FROM signals s
       JOIN leads l ON s.lead_id = l.id
       WHERE s.signal_type = $1
       ORDER BY s.detected_at DESC LIMIT $2`,
      [signalType, limit]
    );
    return result.rows;
  }

  /**
   * Count signals by type for a lead
   */
  static async countByTypeForLead(leadId) {
    const result = await query(
      `SELECT signal_type, COUNT(*) as count
       FROM signals WHERE lead_id = $1
       GROUP BY signal_type`,
      [leadId]
    );
    return result.rows.reduce((acc, row) => {
      acc[row.signal_type] = parseInt(row.count, 10);
      return acc;
    }, {});
  }

  /**
   * Get recent signals (for re-scoring triggers)
   */
  static async getRecent(minutes = 60) {
    const result = await query(
      `SELECT * FROM signals
       WHERE detected_at >= NOW() - INTERVAL '${minutes} minutes'
       ORDER BY detected_at DESC`
    );
    return result.rows;
  }
}

module.exports = Signal;
