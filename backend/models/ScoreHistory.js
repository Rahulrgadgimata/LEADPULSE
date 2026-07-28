const { query } = require('../config/database');

class ScoreHistory {
  /**
   * Record a score snapshot
   */
  static async record(leadId, scoreData, triggerEvent) {
    const sql = `
      INSERT INTO score_history (lead_id, total_score, intent_score,
        profile_fit_score, company_fit_score, recency_score, engagement_score,
        tier, trigger_event)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `;
    const result = await query(sql, [
      leadId, scoreData.total_score, scoreData.intent_score,
      scoreData.profile_fit_score, scoreData.company_fit_score,
      scoreData.recency_score, scoreData.engagement_score,
      scoreData.tier, triggerEvent,
    ]);
    return result.rows[0];
  }

  /**
   * Get score history for a lead
   */
  static async getByLead(leadId, limit = 30) {
    const result = await query(
      `SELECT * FROM score_history WHERE lead_id = $1
       ORDER BY recorded_at DESC LIMIT $2`,
      [leadId, limit]
    );
    return result.rows;
  }

  /**
   * Get score trend (daily averages) for a lead
   */
  static async getTrend(leadId, days = 30) {
    const sql = `
      SELECT DATE(recorded_at) as date, 
             AVG(total_score)::INTEGER as avg_score,
             MAX(total_score) as max_score,
             MIN(total_score) as min_score
      FROM score_history
      WHERE lead_id = $1 AND recorded_at >= NOW() - INTERVAL '${days} days'
      GROUP BY DATE(recorded_at)
      ORDER BY date ASC
    `;
    const result = await query(sql, [leadId]);
    return result.rows;
  }

  /**
   * Get the latest score change for a lead
   */
  static async getLatestChange(leadId) {
    const result = await query(
      `SELECT * FROM score_history WHERE lead_id = $1
       ORDER BY recorded_at DESC LIMIT 2`,
      [leadId]
    );
    if (result.rows.length < 2) return null;
    return {
      current: result.rows[0],
      previous: result.rows[1],
      change: result.rows[0].total_score - result.rows[1].total_score,
    };
  }
}

module.exports = ScoreHistory;
