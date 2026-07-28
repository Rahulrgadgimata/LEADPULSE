const crypto = require('crypto');
const logger = require('../../utils/logger');

/**
 * Lead deduplication logic
 * Ensures the same lead never appears twice across sources or runs
 */
class Deduplication {
  /**
   * Generate a SHA-256 dedup hash from lead data
   * Hash is based on normalized company_name + contact_email + source
   */
  generateHash(leadData) {
    const companyNormalized = this.normalizeCompanyName(leadData.name || leadData.company_name || '');
    const emailNormalized = (leadData.email || leadData.contact_email || '').toLowerCase().trim();
    const source = (leadData.source || '').toLowerCase().trim();

    const hashInput = `${companyNormalized}|${emailNormalized}|${source}`;
    return crypto.createHash('sha256').update(hashInput).digest('hex');
  }

  /**
   * Normalize company name for comparison
   * Strips suffixes, lowercases, removes punctuation
   */
  normalizeCompanyName(name) {
    return name
      .toLowerCase()
      .trim()
      // Remove common suffixes
      .replace(/\b(inc|llc|ltd|corp|corporation|company|co|gmbh|sa|bv|ag|plc|pvt|private|limited)\.?\b/gi, '')
      // Remove punctuation
      .replace(/[.,\-_'"()]/g, '')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Check if two leads are likely duplicates
   * Used for fuzzy matching when hash match fails
   */
  isProbableDuplicate(lead1, lead2) {
    // Exact email match
    if (lead1.contact_email && lead2.contact_email &&
        lead1.contact_email.toLowerCase() === lead2.contact_email.toLowerCase()) {
      return true;
    }

    // Company name similarity
    const name1 = this.normalizeCompanyName(lead1.company_name || '');
    const name2 = this.normalizeCompanyName(lead2.company_name || '');

    if (name1 === name2 && name1.length > 0) {
      return true;
    }

    // Website match
    if (lead1.company_website && lead2.company_website) {
      const domain1 = this.extractDomain(lead1.company_website);
      const domain2 = this.extractDomain(lead2.company_website);
      if (domain1 === domain2 && domain1.length > 0) {
        return true;
      }
    }

    // Levenshtein distance check for company names
    if (name1.length > 3 && name2.length > 3) {
      const distance = this.levenshteinDistance(name1, name2);
      const maxLen = Math.max(name1.length, name2.length);
      const similarity = 1 - (distance / maxLen);
      if (similarity >= 0.85) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extract domain from URL for comparison
   */
  extractDomain(url) {
    try {
      return new URL(url).hostname.replace('www.', '').toLowerCase();
    } catch {
      return url.replace(/^https?:\/\//, '').replace('www.', '').split('/')[0].toLowerCase();
    }
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  levenshteinDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,       // deletion
          dp[i][j - 1] + 1,       // insertion
          dp[i - 1][j - 1] + cost // substitution
        );
      }
    }

    return dp[m][n];
  }
}

module.exports = new Deduplication();
