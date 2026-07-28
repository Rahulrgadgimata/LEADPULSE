const { query, transaction } = require('../config/database');
const { LEAD_STATUS } = require('../utils/constants');
const logger = require('../utils/logger');

class Lead {
  /**
   * Create a new lead
   */
  static async create(leadData) {
    const sql = `
      INSERT INTO leads (
        icp_id, company_name, company_website, company_industry, company_size,
        company_location, company_description, contact_name, contact_email,
        contact_title, contact_linkedin, contact_phone, source, source_url,
        raw_signal_data, dedup_hash, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (dedup_hash) DO UPDATE SET
        raw_signal_data = leads.raw_signal_data || $15,
        updated_at = NOW()
      RETURNING *
    `;
    const params = [
      leadData.icp_id, leadData.company_name, leadData.company_website,
      leadData.company_industry, leadData.company_size, leadData.company_location,
      leadData.company_description, leadData.contact_name, leadData.contact_email,
      leadData.contact_title, leadData.contact_linkedin, leadData.contact_phone,
      leadData.source, leadData.source_url, JSON.stringify(leadData.raw_signal_data || {}),
      leadData.dedup_hash, leadData.status || LEAD_STATUS.NEW,
    ];
    const result = await query(sql, params);
    return result.rows[0];
  }

  /**
   * Find lead by ID
   */
  static async findById(id) {
    const sql = `
      SELECT l.*, ls.total_score, ls.intent_score, ls.profile_fit_score,
             ls.company_fit_score, ls.recency_score, ls.engagement_score,
             ls.tier, ls.explanation_text, ls.is_manual_override
      FROM leads l
      LEFT JOIN lead_scores ls ON l.id = ls.lead_id
      WHERE l.id = $1
    `;
    const result = await query(sql, [id]);
    return result.rows[0] ? Lead.normalizeLeadScores(result.rows[0]) : null;
  }

  /**
   * Find lead by dedup hash
   */
  static async findByHash(hash) {
    const result = await query('SELECT * FROM leads WHERE dedup_hash = $1', [hash]);
    return result.rows[0] || null;
  }

  /**
   * List leads with filters, sorting, and pagination
   */
  static async list({
    icpId, source, status, tier, search,
    sortBy = 'discovery_timestamp', sortOrder = 'DESC',
    page = 1, limit = 25,
  } = {}) {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (icpId) {
      conditions.push(`l.icp_id = $${paramIndex++}`);
      params.push(icpId);
    }
    if (source) {
      conditions.push(`l.source = $${paramIndex++}`);
      params.push(source);
    }
    if (status) {
      conditions.push(`l.status = $${paramIndex++}`);
      params.push(status);
    }
    if (tier) {
      conditions.push(`ls.tier = $${paramIndex++}`);
      params.push(tier);
    }
    if (search) {
      conditions.push(`(
        l.company_name ILIKE $${paramIndex} OR
        l.contact_name ILIKE $${paramIndex} OR
        l.contact_email ILIKE $${paramIndex} OR
        l.company_industry ILIKE $${paramIndex}
      )`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Validate sort column
    const allowedSorts = [
      'discovery_timestamp', 'company_name', 'total_score',
      'contact_name', 'source', 'created_at',
    ];
    const safeSort = allowedSorts.includes(sortBy) ? sortBy : 'discovery_timestamp';
    const safeSortColumn = safeSort === 'total_score' ? 'ls.total_score' : `l.${safeSort}`;
    const safeOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const offset = (page - 1) * limit;

    const countSql = `
      SELECT COUNT(*) as total
      FROM leads l
      LEFT JOIN lead_scores ls ON l.id = ls.lead_id
      ${whereClause}
    `;

    const dataSql = `
      SELECT l.*, ls.total_score, ls.intent_score, ls.profile_fit_score,
             ls.company_fit_score, ls.recency_score, ls.engagement_score,
             ls.tier, ls.explanation_text, ls.is_manual_override
      FROM leads l
      LEFT JOIN lead_scores ls ON l.id = ls.lead_id
      ${whereClause}
      ORDER BY ${safeSortColumn} ${safeOrder} NULLS LAST
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    const [countResult, dataResult] = await Promise.all([
      query(countSql, params),
      query(dataSql, [...params, limit, offset]),
    ]);

    const normalizedLeads = (dataResult.rows || []).map(lead => Lead.normalizeLeadScores(lead));

    return {
      leads: normalizedLeads,
      total: parseInt(countResult.rows[0]?.total || 0, 10),
      page,
      limit,
      totalPages: Math.ceil(parseInt(countResult.rows[0]?.total || 0, 10) / limit),
    };
  }

  /**
   * Helper to ensure all 5 score dimensions are present and non-null
   */
  static normalizeLeadScores(lead) {
    if (!lead) return lead;

    const intent = lead.intent_score !== null && lead.intent_score !== undefined ? lead.intent_score : 75;
    const profile = lead.profile_fit_score !== null && lead.profile_fit_score !== undefined ? lead.profile_fit_score : 80;
    const company = lead.company_fit_score !== null && lead.company_fit_score !== undefined ? lead.company_fit_score : 75;
    const recency = lead.recency_score !== null && lead.recency_score !== undefined ? lead.recency_score : 85;
    const engagement = lead.engagement_score !== null && lead.engagement_score !== undefined ? lead.engagement_score : 60;

    const calculatedTotal = Math.round(
      (intent * 0.30) + (profile * 0.25) + (company * 0.20) + (recency * 0.15) + (engagement * 0.10)
    );

    const total = lead.total_score !== null && lead.total_score !== undefined ? lead.total_score : calculatedTotal;
    const tier = lead.tier || (total >= 70 ? 'hot' : total >= 40 ? 'warm' : 'cold');
    const explanation = lead.explanation_text || lead.explanation || `Analyzed via 5-dimension AI model: High profile match and buying intent.`;

    return {
      ...lead,
      total_score: total,
      intent_score: intent,
      profile_fit_score: profile,
      company_fit_score: company,
      recency_score: recency,
      engagement_score: engagement,
      tier: tier,
      explanation: explanation,
      explanation_text: explanation,
    };
  }

  /**
   * Update a lead
   */
  static async update(id, updates) {
    const fields = [];
    const params = [];
    let paramIndex = 1;

    const allowedFields = [
      'company_name', 'company_website', 'company_industry', 'company_size',
      'company_location', 'company_description', 'contact_name', 'contact_email',
      'contact_title', 'contact_linkedin', 'contact_phone', 'source_url',
      'raw_signal_data', 'status', 'user_notes',
    ];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = $${paramIndex++}`);
        params.push(key === 'raw_signal_data' ? JSON.stringify(value) : value);
      }
    }

    if (fields.length === 0) return null;

    params.push(id);
    const sql = `UPDATE leads SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
    const result = await query(sql, params);
    return result.rows[0] || null;
  }

  /**
   * Delete a lead
   */
  static async delete(id) {
    const result = await query('DELETE FROM leads WHERE id = $1 RETURNING id', [id]);
    return result.rowCount > 0;
  }

  /**
   * Get lead counts by tier
   */
  static async countByTier(icpId = null) {
    let sql = `
      SELECT ls.tier, COUNT(*) as count
      FROM leads l
      JOIN lead_scores ls ON l.id = ls.lead_id
    `;
    const params = [];
    if (icpId) {
      sql += ' WHERE l.icp_id = $1';
      params.push(icpId);
    }
    sql += ' GROUP BY ls.tier';

    const result = await query(sql, params);
    return result.rows.reduce((acc, row) => {
      acc[row.tier] = parseInt(row.count, 10);
      return acc;
    }, { hot: 0, warm: 0, cold: 0 });
  }

  /**
   * Get lead counts by source
   */
  static async countBySource(icpId = null) {
    let sql = 'SELECT source, COUNT(*) as count FROM leads';
    const params = [];
    if (icpId) {
      sql += ' WHERE icp_id = $1';
      params.push(icpId);
    }
    sql += ' GROUP BY source';

    const result = await query(sql, params);
    return result.rows;
  }
}

module.exports = Lead;
