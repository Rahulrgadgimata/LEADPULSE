// backend/models/MessageTemplate.js
const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

/**
 * MessageTemplate — a draft that worked, saved to reuse.
 *
 * Templates keep placeholders like {{contact_name}} rather than the values they
 * were saved with, so applying one to a different lead re-personalises instead
 * of leaking the previous recipient's name into a new email.
 */

// Every field the template engine will substitute. Anything outside this list
// is left as literal text so a stray {{...}} in prose is visible rather than
// silently blanked.
const PLACEHOLDERS = [
  'contact_name', 'contact_first_name', 'contact_title', 'company_name',
  'company_industry', 'company_location', 'company_website', 'signal',
  'sender_name', 'sender_title', 'sender_company',
];

class MessageTemplate {
  static get PLACEHOLDERS() {
    return [...PLACEHOLDERS];
  }

  static async create(data) {
    const id = uuidv4();
    const now = new Date().toISOString();

    await query(
      `INSERT INTO message_templates
         (id, name, subject, body, channel, tags, times_used, source_message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        id,
        data.name || 'Untitled template',
        data.subject || '',
        data.body || '',
        data.channel || 'email',
        JSON.stringify(Array.isArray(data.tags) ? data.tags : []),
        data.source_message_id || null,
        now,
        now,
      ]
    );

    return this.findById(id);
  }

  static async findById(id) {
    const result = await query('SELECT * FROM message_templates WHERE id = ?', [id]);
    return result.rows[0] || null;
  }

  static async list() {
    const result = await query('SELECT * FROM message_templates ORDER BY times_used DESC, created_at DESC');
    return result.rows;
  }

  static async update(id, updates) {
    const allowed = ['name', 'subject', 'body', 'channel', 'tags'];
    const fields = [];
    const params = [];

    for (const [key, value] of Object.entries(updates)) {
      if (!allowed.includes(key)) continue;
      fields.push(`${key} = ?`);
      params.push(Array.isArray(value) ? JSON.stringify(value) : value);
    }

    if (fields.length === 0) return this.findById(id);

    fields.push('updated_at = ?');
    params.push(new Date().toISOString(), id);

    await query(`UPDATE message_templates SET ${fields.join(', ')} WHERE id = ?`, params);
    return this.findById(id);
  }

  static async delete(id) {
    const result = await query('DELETE FROM message_templates WHERE id = ?', [id]);
    return result.rowCount > 0;
  }

  /**
   * Bump the usage counter. Purely informational — it drives the ordering in
   * the picker so the templates that actually get used rise to the top.
   */
  static async recordUse(id) {
    await query('UPDATE message_templates SET times_used = times_used + 1 WHERE id = ?', [id]);
  }

  /**
   * Fill a template's placeholders from a lead.
   *
   * Unknown placeholders are left untouched (see PLACEHOLDERS above). A known
   * placeholder with no value becomes an empty string rather than the literal
   * "undefined", which is what would otherwise reach a prospect's inbox.
   */
  static render(text, values = {}) {
    if (!text) return '';
    return String(text).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, name) => {
      const key = String(name).toLowerCase();
      if (!PLACEHOLDERS.includes(key)) return match;
      const value = values[key];
      return value === undefined || value === null ? '' : String(value);
    });
  }

  /** The substitution values a lead provides, ready for `render`. */
  static valuesFromLead(lead = {}, sender = {}, signal = '') {
    const fullName = lead.contact_name || '';
    return {
      contact_name: fullName,
      contact_first_name: fullName.trim().split(/\s+/)[0] || '',
      contact_title: lead.contact_title || '',
      company_name: lead.company_name || '',
      company_industry: lead.company_industry || '',
      company_location: lead.company_location || '',
      company_website: lead.company_website || '',
      signal: signal || '',
      sender_name: sender.name || '',
      sender_title: sender.title || '',
      sender_company: sender.company || '',
    };
  }
}

module.exports = MessageTemplate;
