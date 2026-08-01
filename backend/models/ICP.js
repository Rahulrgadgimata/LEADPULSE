const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

const INTEGER_FIELDS = new Set(['company_size_min', 'company_size_max', 'is_active']);

/**
 * Coerce a value into something SQLite can bind.
 *
 * better-sqlite3 accepts only numbers, strings, bigints, buffers and null — it
 * throws on booleans, which is exactly what an HTML checkbox sends for
 * `is_active`, and on NaN from a blank numeric input.
 */
function toSqliteValue(key, value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;

  if (INTEGER_FIELDS.has(key) && value !== null) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.trunc(num) : null;
  }

  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
}

class ICP {
  /**
   * Create a new ICP
   */
  static async create(icpData) {
    const id = uuidv4();
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO icps (id, user_id, name, description, industries, company_size_min,
        company_size_max, geographies, job_titles, keywords, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    query(sql, [
      id,
      icpData.user_id || null,
      icpData.name,
      icpData.description || '',
      icpData.industries ? JSON.stringify(icpData.industries) : '[]',
      toSqliteValue('company_size_min', icpData.company_size_min) ?? 1,
      toSqliteValue('company_size_max', icpData.company_size_max) ?? 10000,
      icpData.geographies ? JSON.stringify(icpData.geographies) : '[]',
      icpData.job_titles ? JSON.stringify(icpData.job_titles) : '[]',
      icpData.keywords ? JSON.stringify(icpData.keywords) : '[]',
      // Previously hardcoded to 1, so an ICP saved as inactive came back active.
      icpData.is_active === undefined ? 1 : toSqliteValue('is_active', icpData.is_active),
      now,
      now,
    ]);
    return this.findById(id);
  }

  /**
   * Find ICP by ID
   */
  static async getById(id) {
    return this.findById(id);
  }

  static async findById(id) {
    const result = query('SELECT * FROM icps WHERE id = ?', [id]);
    return result.rows[0] || null;
  }

  /**
   * List all ICPs
   */
  static async listAll() {
    const result = query('SELECT * FROM icps ORDER BY created_at DESC');
    return result.rows;
  }

  /**
   * List all ICPs for a user
   */
  static async listByUser(userId) {
    const result = query(
      'SELECT * FROM icps WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    return result.rows;
  }

  /**
   * List all active ICPs (for scheduled runs)
   */
  static async listActive() {
    const result = query(
      'SELECT * FROM icps WHERE is_active = 1 ORDER BY created_at DESC'
    );
    return result.rows;
  }

  /**
   * Update an ICP
   */
  static async update(id, updates) {
    const fields = [];
    const params = [];

    const allowedFields = [
      'name', 'description', 'industries', 'company_size_min',
      'company_size_max', 'geographies', 'job_titles', 'keywords', 'is_active',
    ];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = ?`);
        params.push(toSqliteValue(key, value));
      }
    }

    if (fields.length === 0) return this.findById(id);

    fields.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    query(`UPDATE icps SET ${fields.join(', ')} WHERE id = ?`, params);
    return this.findById(id);
  }

  /**
   * Delete an ICP
   */
  static async delete(id) {
    const result = query('DELETE FROM icps WHERE id = ?', [id]);
    return result.rowCount > 0;
  }
}

module.exports = ICP;
