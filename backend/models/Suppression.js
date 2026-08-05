// backend/models/Suppression.js
const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

/**
 * Suppression — the do-not-contact list.
 *
 * Checked before every send, including scheduled ones, so a message queued
 * yesterday cannot go out to someone who opted out this morning.
 *
 * Deliberately keyed on the email address rather than the lead id: a lead can
 * be deleted and rediscovered by the next crawl, but the person's request to
 * be left alone has to survive that.
 */
class Suppression {
  static normaliseEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  static domainOf(email) {
    const clean = this.normaliseEmail(email);
    return clean.includes('@') ? clean.split('@').pop() : '';
  }

  /**
   * Add an opt-out. Idempotent: re-suppressing an address updates the reason
   * rather than erroring, because the same person may opt out twice by
   * different routes (reply keyword, then unsubscribe link).
   */
  static async add({ email, domain = null, reason = '', source = 'manual', evidence = '', lead_id = null }) {
    const clean = this.normaliseEmail(email);
    const cleanDomain = domain ? String(domain).trim().toLowerCase().replace(/^@/, '') : null;

    if (!clean && !cleanDomain) {
      throw new Error('A suppression needs an email address or a domain.');
    }

    if (clean) {
      const existing = query('SELECT * FROM suppressions WHERE email = ?', [clean]).rows[0];
      if (existing) {
        query(
          'UPDATE suppressions SET reason = ?, source = ?, evidence = ?, lead_id = COALESCE(?, lead_id) WHERE id = ?',
          [reason || existing.reason, source, String(evidence || '').slice(0, 2000), lead_id, existing.id]
        );
        return this.findById(existing.id);
      }
    }

    const id = uuidv4();
    query(
      `INSERT INTO suppressions (id, email, domain, reason, source, evidence, lead_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        clean || null,
        cleanDomain,
        reason || '',
        source,
        String(evidence || '').slice(0, 2000),
        lead_id,
        new Date().toISOString(),
      ]
    );
    return this.findById(id);
  }

  static async findById(id) {
    const result = query('SELECT * FROM suppressions WHERE id = ?', [id]);
    return result.rows[0] || null;
  }

  /**
   * Whether this address must not be contacted.
   *
   * Matches the exact address and its domain separately, so blocking a whole
   * domain (a competitor, a customer's legal team) works without listing every
   * individual mailbox.
   */
  static async isSuppressed(email) {
    const clean = this.normaliseEmail(email);
    if (!clean) return null;

    const byEmail = query('SELECT * FROM suppressions WHERE email = ?', [clean]).rows[0];
    if (byEmail) return byEmail;

    const domain = this.domainOf(clean);
    if (!domain) return null;

    const byDomain = query(
      'SELECT * FROM suppressions WHERE domain IS NOT NULL AND domain = ?',
      [domain]
    ).rows[0];
    return byDomain || null;
  }

  static async list(limit = 500) {
    const result = query(
      'SELECT * FROM suppressions ORDER BY created_at DESC LIMIT ?',
      [Number(limit) || 500]
    );
    return result.rows;
  }

  static async delete(id) {
    const result = query('DELETE FROM suppressions WHERE id = ?', [id]);
    return result.rowCount > 0;
  }
}

module.exports = Suppression;
