const { query } = require('../config/database');

class ICP {
  /**
   * Create a new ICP
   */
  static async create(icpData) {
    const sql = `
      INSERT INTO icps (user_id, name, description, industries, company_size_min,
        company_size_max, geographies, job_titles, keywords)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `;
    const result = await query(sql, [
      icpData.user_id, icpData.name, icpData.description,
      icpData.industries || [], icpData.company_size_min || 1,
      icpData.company_size_max || 10000, icpData.geographies || [],
      icpData.job_titles || [], icpData.keywords || [],
    ]);
    return result.rows[0];
  }

  /**
   * Find ICP by ID
   */
  static async findById(id) {
    const result = await query('SELECT * FROM icps WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  /**
   * List all ICPs for a user
   */
  static async listByUser(userId) {
    const result = await query(
      'SELECT * FROM icps WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return result.rows;
  }

  /**
   * List all active ICPs (for scheduled runs)
   */
  static async listActive() {
    const result = await query(
      'SELECT * FROM icps WHERE is_active = true ORDER BY created_at DESC'
    );
    return result.rows;
  }

  /**
   * Update an ICP
   */
  static async update(id, updates) {
    const fields = [];
    const params = [];
    let paramIndex = 1;

    const allowedFields = [
      'name', 'description', 'industries', 'company_size_min',
      'company_size_max', 'geographies', 'job_titles', 'keywords', 'is_active',
    ];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = $${paramIndex++}`);
        params.push(value);
      }
    }

    if (fields.length === 0) return null;

    params.push(id);
    const sql = `UPDATE icps SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
    const result = await query(sql, params);
    return result.rows[0] || null;
  }

  /**
   * Update last run timestamp
   */
  static async updateLastRun(id) {
    const result = await query(
      'UPDATE icps SET last_run_at = NOW() WHERE id = $1 RETURNING *',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Delete an ICP
   */
  static async delete(id) {
    const result = await query('DELETE FROM icps WHERE id = $1 RETURNING id', [id]);
    return result.rowCount > 0;
  }
}

module.exports = ICP;
