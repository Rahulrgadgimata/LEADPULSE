const logger = require('../utils/logger');
const { isNonProspect, isMegaCorp } = require('./discovery/collectors/domainFilter');

/**
 * Intake filter — keep convertible companies, skip junk and mega-giants.
 *
 * Does NOT drop moderate/weak ICP labels aggressively: those still convert when
 * the company is a real SMB/startup. Only clear non-prospects are removed.
 */
class LeadQuality {
  static isBestProspect(item) {
    return this.evaluate(item).ok;
  }

  static evaluate(item) {
    if (!item?.company_name) return fail('missing name');

    const name = String(item.company_name).trim();
    if (!isCleanName(name)) return fail(`bad name "${name}"`);
    if (/^@/.test(name) || /^u\//i.test(name)) return fail('social handle');

    // Big giants almost never convert from cold outbound — skip them.
    if (isMegaCorp(name)) return fail(`mega-corp ${name}`);

    const website = cleanDomain(item.company_website);
    if (website && isMegaCorp(website)) return fail(`mega-corp domain ${website}`);
    if (website && isNonProspect(website)) return fail(`aggregator ${website}`);

    const linkedin = String(item.contact_linkedin || '').trim();
    const sourceUrl = String(item.source_url || '').trim();
    const hasCompanyLinkedIn =
      /linkedin\.com\/company\//i.test(linkedin) ||
      /linkedin\.com\/company\//i.test(sourceUrl);
    const hasPersonLinkedIn = /linkedin\.com\/in\//i.test(linkedin);

    // Need some public footprint — website, company LinkedIn, or buyer profile.
    if (!website && !hasCompanyLinkedIn && !hasPersonLinkedIn) {
      return fail('no website or LinkedIn');
    }

    // Huge headcount outside a reasonable conversion band (unless ICP says enterprise).
    const size = Number(item.company_size);
    if (Number.isFinite(size) && size >= 10000) {
      return fail(`too large to convert cold (${size} employees)`);
    }

    return { ok: true };
  }

  static filterBest(items) {
    const kept = [];
    let dropped = 0;
    for (const item of items || []) {
      const verdict = this.evaluate(item);
      if (verdict.ok) kept.push(item);
      else {
        dropped++;
        logger.debug(`Quality intake dropped ${item?.company_name || '?'}: ${verdict.reason}`);
      }
    }
    if (dropped > 0) {
      logger.info(`LeadQuality: kept ${kept.length} convertible leads, skipped ${dropped} (giants/junk)`);
    }
    return kept;
  }
}

function fail(reason) {
  return { ok: false, reason };
}

function cleanDomain(website) {
  if (!website) return null;
  return String(website)
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase() || null;
}

function isCleanName(name) {
  if (name.length < 2 || name.length > 70) return false;
  if (name.split(/\s+/).length > 7) return false;
  if (!/[a-z0-9]/i.test(name)) return false;
  if (/^(home|about|contact|linkedin|twitter|facebook|reddit|indeed|jobs|careers|blog|news)$/i.test(name)) {
    return false;
  }
  if (/\b(top \d+|best \d+|list of|how to)\b/i.test(name)) return false;
  return true;
}

module.exports = LeadQuality;
