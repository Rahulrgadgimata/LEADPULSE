const crypto = require('crypto');
const Lead = require('../models/Lead');
const logger = require('../utils/logger');

class DedupService {
  /**
   * Generates a deterministic hash for a lead based on company name and domain/email.
   */
  static generateHash(companyName, email, website) {
    const cleanName = (companyName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let domain = '';

    if (email && email.includes('@')) {
      domain = email.split('@')[1].toLowerCase();
    } else if (website) {
      domain = website.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    }

    const raw = `${cleanName}:${domain}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Checks if a lead exists, and if not, creates it.
   */
  static async checkAndInsert(icpId, leadData) {
    const hash = this.generateHash(leadData.company_name, leadData.contact_email, leadData.company_website);
    leadData.dedup_hash = hash;

    try {
      const existing = await Lead.findByHash(hash);
      if (existing) {
        logger.debug(`Lead duplicated: ${hash}`);
        return { lead: existing, isNew: false };
      }

      const newLead = await Lead.create(icpId, leadData);
      logger.info(`New lead created: ${newLead.id} (${leadData.company_name})`);
      return { lead: newLead, isNew: true };
    } catch (err) {
      logger.error(`Dedup checkAndInsert failed for ${leadData.company_name}:`, err);
      throw err;
    }
  }
}

module.exports = DedupService;
