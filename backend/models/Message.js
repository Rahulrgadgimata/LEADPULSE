// backend/models/Message.js
const crypto = require('crypto');
const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

/**
 * Message model — one row per outbound message, from first draft to sent log.
 *
 * Drafts and sent mail share this table so the editor and the history read the
 * same record. That is what makes the log trustworthy: whatever the user edited
 * before hitting send is literally the row the log later shows, rather than a
 * copy made at send time that could drift.
 */

const STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'];

// Statuses a user edit may still change. Once a message is sent it is a
// historical record, and rewriting it would make the log lie about what the
// recipient actually received.
const EDITABLE_STATUSES = new Set(['draft', 'scheduled', 'failed', 'cancelled']);

class Message {
  static get STATUSES() {
    return STATUSES;
  }

  static isEditable(status) {
    return EDITABLE_STATUSES.has(String(status || 'draft'));
  }

  static async create(data) {
    const id = uuidv4();
    const now = new Date().toISOString();

    const sql = `INSERT INTO messages (
      id, lead_id, icp_id, template_id, channel, to_email, to_name, from_email,
      subject, body, status, generated_by, generation_prompt, personalisation,
      scheduled_at, sent_at, provider_message_id, error_message, send_attempts,
      unsubscribe_token, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    query(sql, [
      id,
      data.lead_id || null,
      data.icp_id || null,
      data.template_id || null,
      data.channel || 'email',
      data.to_email || null,
      data.to_name || null,
      data.from_email || null,
      data.subject || null,
      data.body || null,
      data.status || 'draft',
      data.generated_by || null,
      data.generation_prompt || null,
      JSON.stringify(data.personalisation || {}),
      data.scheduled_at || null,
      data.sent_at || null,
      data.provider_message_id || null,
      data.error_message || null,
      data.send_attempts || 0,
      // Every message carries its own opt-out token, so a recipient can
      // unsubscribe from a single send without us having to trust that the
      // email address in a click matches the one we mailed.
      data.unsubscribe_token || crypto.randomBytes(24).toString('hex'),
      now,
      now,
    ]);

    return this.findById(id);
  }

  static async findById(id) {
    const result = query('SELECT * FROM messages WHERE id = ?', [id]);
    return result.rows[0] || null;
  }

  static async findByUnsubscribeToken(token) {
    if (!token) return null;
    const result = query('SELECT * FROM messages WHERE unsubscribe_token = ?', [token]);
    return result.rows[0] || null;
  }

  /**
   * The sent-message log, newest first, joined with the company it went to so
   * the UI does not need a second query per row.
   */
  static async list({ status = null, leadId = null, icpId = null, limit = 100, offset = 0 } = {}) {
    const where = [];
    const params = [];

    if (status) {
      // Accepts 'sent' or 'draft,scheduled'.
      const wanted = String(status).split(',').map(s => s.trim()).filter(Boolean);
      if (wanted.length > 0) {
        where.push(`m.status IN (${wanted.map(() => '?').join(', ')})`);
        params.push(...wanted);
      }
    }
    if (leadId) {
      where.push('m.lead_id = ?');
      params.push(leadId);
    }
    if (icpId) {
      where.push('m.icp_id = ?');
      params.push(icpId);
    }

    params.push(Number(limit) || 100, Number(offset) || 0);

    const result = query(
      `SELECT m.*, l.company_name, l.contact_name, l.contact_title,
              l.company_website, s.total_score, s.tier
       FROM messages m
       LEFT JOIN leads l ON l.id = m.lead_id
       LEFT JOIN lead_scores s ON s.lead_id = m.lead_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY COALESCE(m.sent_at, m.scheduled_at, m.created_at) DESC
       LIMIT ? OFFSET ?`,
      params
    );
    return result.rows;
  }

  /**
   * Scheduled messages whose send time has passed. Ordered oldest-first so a
   * backlog drains in the order the user asked for.
   */
  static async listDue(now = new Date().toISOString(), limit = 25) {
    const result = query(
      `SELECT * FROM messages
       WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
       ORDER BY scheduled_at ASC
       LIMIT ?`,
      [now, limit]
    );
    return result.rows;
  }

  /** How many messages actually went out in the last 24 hours. */
  static async sentInLastDay() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = query(
      `SELECT COUNT(*) AS count FROM messages WHERE status = 'sent' AND sent_at >= ?`,
      [since]
    );
    return result.rows[0]?.count || 0;
  }

  static async update(id, updates) {
    const allowed = [
      'template_id', 'channel', 'to_email', 'to_name', 'from_email', 'subject',
      'body', 'status', 'generated_by', 'generation_prompt', 'personalisation',
      'scheduled_at', 'sent_at', 'provider_message_id', 'error_message',
      'send_attempts',
    ];

    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(updates)) {
      if (!allowed.includes(key)) continue;
      fields.push(`${key} = ?`);
      // better-sqlite3 rejects objects and booleans, so anything structured is
      // stored as JSON text — matching how personalisation is written.
      if (value !== null && typeof value === 'object') params.push(JSON.stringify(value));
      else if (typeof value === 'boolean') params.push(value ? 1 : 0);
      else params.push(value === undefined ? null : value);
    }

    if (fields.length === 0) return this.findById(id);

    fields.push('updated_at = ?');
    params.push(new Date().toISOString(), id);

    query(`UPDATE messages SET ${fields.join(', ')} WHERE id = ?`, params);
    return this.findById(id);
  }

  static async delete(id) {
    const result = query('DELETE FROM messages WHERE id = ?', [id]);
    return result.rowCount > 0;
  }

  /**
   * Claim a scheduled message for sending.
   *
   * The status change is the lock: the UPDATE only matches while the row is
   * still 'scheduled', so if a manual send and the scheduler tick race, exactly
   * one of them gets a rowCount of 1 and the other sends nothing. Without this
   * a message could go out twice.
   */
  static async claimForSending(id) {
    const now = new Date().toISOString();
    const result = query(
      `UPDATE messages SET status = 'sending', updated_at = ?
       WHERE id = ? AND status IN ('draft', 'scheduled', 'failed')`,
      [now, id]
    );
    if (result.rowCount === 0) return null;
    return this.findById(id);
  }

  /** Counts for the outreach dashboard header. */
  static async getStats() {
    const rows = query('SELECT status, COUNT(*) AS count FROM messages GROUP BY status').rows;
    const byStatus = {};
    for (const row of rows) byStatus[row.status] = row.count;

    return {
      byStatus,
      total: rows.reduce((sum, r) => sum + r.count, 0),
      sentLast24h: await this.sentInLastDay(),
    };
  }
}

module.exports = Message;
