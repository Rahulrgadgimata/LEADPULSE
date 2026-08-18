const logger = require('../../../utils/logger');
const config = require('../../../config/env');
const Search = require('./search');
const { isNonProspect, isMegaCorp } = require('./domainFilter');
const LeadQuality = require('../../leadQuality');
const runBudget = require('../runBudget');

/**
 * Finds convertible buyer contacts from publicly indexed LinkedIn people pages.
 *
 * LinkedIn profiles themselves are usually login-walled; search engines still
 * index titles like "Jane Doe - CTO at Acme | LinkedIn" with company + role.
 * We turn those into company leads with a named buyer title — ideal for outreach.
 */
class BuyerCollector {
  static async searchBuyers(icp, options = {}) {
    const target = options.target || config.BUYER_TARGET_LEADS || 40;
    const maxQueries = options.maxQueries || config.BUYER_MAX_QUERIES || 16;

    const queries = this._buildQueries(icp, maxQueries);
    if (queries.length === 0) return [];

    logger.info(`BuyerCollector: targeting ${target} buyers across ${queries.length} LinkedIn people queries`);

    const byKey = new Map();
    let queriesRun = 0;

    for (const query of queries) {
      if (byKey.size >= target * 1.5) break;
      if (runBudget.collectExpired()) {
        logger.info(`BuyerCollector stopped after ${queriesRun} queries: collection budget reached.`);
        break;
      }
      queriesRun++;

      const results = await Search.run(query, 10);
      for (const result of results) {
        const parsed = this._parsePersonResult(result, icp);
        if (!parsed) continue;
        const key = `${parsed.company_name}::${parsed.contact_title}`.toLowerCase();
        if (!byKey.has(key)) byKey.set(key, parsed);
      }
    }

    // Resolve websites only for a small subset — person LinkedIn is enough
    // for intake; burning search on every candidate starves Google LinkedIn queries.
    const candidates = [...byKey.values()].slice(0, Math.ceil(target * 1.3));
    const withSites = candidates.slice(0, target);

    const best = LeadQuality.filterBest(withSites);
    logger.info(`BuyerCollector produced ${best.length} convertible buyer leads (from ${queriesRun} queries)`);
    return best;
  }

  static _buildQueries(icp, maxQueries) {
    const industries = parseList(icp.industries);
    const keywords = parseList(icp.keywords);
    const geographies = parseList(icp.geographies);
    const titles = parseList(icp.job_titles);
    if (titles.length === 0 && industries.length === 0) return [];

    const geo = geographies[0] || '';
    const queries = [];
    const seen = new Set();
    const add = (...parts) => {
      const q = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (!q || seen.has(q.toLowerCase())) return;
      seen.add(q.toLowerCase());
      queries.push(q);
    };

    const li = 'linkedin.com/in/';
    for (const title of titles.slice(0, 4)) {
      for (const industry of industries.slice(0, 3)) {
        add(title, industry, 'startup', geo, li);
        add(`"${title} at"`, industry, geo, li);
        add(title, industry, 'SME', geo, li);
      }
      for (const keyword of keywords.slice(0, 3)) {
        add(title, keyword, 'startup', geo, li);
      }
      add(title, industries[0] || keywords[0], 'startup', geo, li);
    }

    return queries.slice(0, maxQueries);
  }

  /**
   * Parse "Name - Title at Company | LinkedIn" style public search hits.
   */
  static _parsePersonResult(result, icp) {
    if (!result?.url) return null;
    let url;
    try {
      url = new URL(result.url);
    } catch (e) {
      return null;
    }
    if (!/linkedin\.com$/i.test(url.hostname.replace(/^www\./, '')) &&
        !/\.linkedin\.com$/i.test(url.hostname)) {
      return null;
    }
    if (!/^\/in\//i.test(url.pathname)) return null;

    const title = String(result.title || '')
      .replace(/\s*[\|\-–—]\s*LinkedIn.*$/i, '')
      .trim();
    const snippet = String(result.snippet || '');

    // Patterns: "Jane Doe - CTO at Acme" / "Jane Doe | CTO | Acme"
    // Also: "Jane Doe - CTO at Acme · LinkedIn" already stripped above.
    let contactName = null;
    let contactTitle = null;
    let companyName = null;

    const atMatch = title.match(/^(.+?)\s*[-–—|]\s*(.+?)\s+at\s+(.+)$/i);
    if (atMatch) {
      contactName = atMatch[1].trim();
      contactTitle = atMatch[2].trim();
      companyName = atMatch[3].trim();
    } else {
      const parts = title.split(/\s*[|\-–—]\s*/).map(p => p.trim()).filter(Boolean);
      if (parts.length >= 3) {
        contactName = parts[0];
        contactTitle = parts[1];
        companyName = parts[2];
      } else if (parts.length === 2) {
        contactName = parts[0];
        contactTitle = parts[1];
      } else if (parts.length === 1) {
        contactName = parts[0];
      }
    }

    // Snippet often has the real company even when the title is messy:
    // "CTO at Acme · Bengaluru · Experience: ..."
    if (!companyName || looksLikeJobHeadline(companyName)) {
      const snipAt = snippet.match(
        /\b((?:CEO|CTO|CFO|COO|Founder|Co-Founder|VP|Vice President|Head of [A-Za-z &/]+|Director|Chief [A-Za-z ]+))\s+at\s+([A-Za-z0-9][A-Za-z0-9 &'.,-]{1,60})/i
      );
      if (snipAt) {
        contactTitle = contactTitle || snipAt[1].trim();
        companyName = snipAt[2].trim();
      } else {
        const looseAt = snippet.match(/\bat\s+([A-Za-z0-9][A-Za-z0-9 &'.,-]{1,50})(?:\s*[·•|]|\s+in\s|\s*$)/i);
        if (looseAt && !looksLikeJobHeadline(looseAt[1])) {
          companyName = looseAt[1].trim();
        }
      }
    }

    if (!companyName || companyName.length < 2) return null;
    companyName = companyName
      .replace(/\s*\b(inc|llc|ltd|corp)\.?$/i, '')
      .replace(/\s+on LinkedIn.*$/i, '')
      .replace(/\s*[·•|].*$/, '')
      .trim();

    if (contactName && /^(read more|see more|linkedin)$/i.test(contactName)) {
      contactName = null;
    }

    // Job headlines often land in the "company" slot ("AI & Data Science Engineer").
    if (looksLikeJobHeadline(companyName) || !isPlausibleCompanyName(companyName)) return null;
    // Don't treat the person's own name as the company.
    if (contactName && companyName.toLowerCase() === contactName.toLowerCase()) return null;
    if (isMegaCorp(companyName)) return null;

    const icpTitles = parseList(icp.job_titles).map(t => String(t).toLowerCase());
    if (contactTitle && icpTitles.length > 0) {
      const ct = contactTitle.toLowerCase();
      const titleHit = icpTitles.some(t => ct.includes(t) || t.includes(ct) || sharesToken(ct, t));
      if (!titleHit) {
        // Still keep senior-looking titles even if wording differs.
        if (!/\b(ceo|cto|cfo|coo|founder|vp|vice president|head of|director|chief)\b/i.test(contactTitle)) {
          return null;
        }
      }
    }

    const profileUrl = `https://www.linkedin.com${url.pathname.replace(/\/$/, '')}`;

    return {
      company_name: companyName.slice(0, 120),
      company_website: null,
      // Industry and location are left null rather than copied from the ICP.
      // Filling them in from the target profile asserted what was being looked
      // for, not what was found: every buyer lead then claimed to sit in the
      // ICP's geography, which handed it the scoring geography bonus and made
      // the location filter unable to tell a real match from an assumed one.
      company_industry: null,
      company_location: null,
      company_description: snippet.slice(0, 400) || null,
      contact_name: contactName ? contactName.slice(0, 80) : null,
      contact_title: contactTitle
        ? contactTitle.slice(0, 80)
        : (parseList(icp.job_titles)[0] || null),
      contact_linkedin: profileUrl,
      source: 'LinkedInBuyer',
      source_url: profileUrl,
      raw_signal_data: {
        linkedin_person: profileUrl,
        snippet,
        icp_fit: 'strong',
        extracted_by: 'buyer-collector'
      },
      signal: {
        signal_type: 'linkedin',
        source: 'LinkedIn',
        source_url: profileUrl,
        title: contactName && contactTitle
          ? `${contactName} · ${contactTitle} at ${companyName}`
          : `Buyer at ${companyName} on LinkedIn`,
        content: snippet.slice(0, 1500) || title,
        relevance_score: 0.9
      }
    };
  }

  static async _resolveWebsite(companyName) {
    try {
      const results = await Search.run(
        `"${companyName}" official website -site:linkedin.com -site:facebook.com`,
        5
      );
      for (const result of results) {
        let domain;
        try {
          domain = new URL(result.url).hostname.replace(/^www\./, '');
        } catch (e) {
          continue;
        }
        if (!isNonProspect(domain)) return domain;
      }
    } catch (e) { /* soft */ }
    return null;
  }
}

function parseList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function sharesToken(a, b) {
  const stop = new Set(['the', 'and', 'of', 'for', 'vp', 'head', 'chief', 'officer']);
  const tok = s => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2 && !stop.has(t));
  const left = new Set(tok(a));
  return tok(b).some(t => left.has(t));
}

function looksLikeJobHeadline(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  if (/\b(engineer|developer|student|intern|freelancer|consultant|specialist|analyst|manager|entrepreneur|innovator)\b/i.test(s)
      && !/\b(labs?|systems?|technologies|solutions|software|media|inc|llc|ltd|corp|company|studio|group)\b/i.test(s)) {
    return true;
  }
  if (/^(founder|ceo|cto|cfo|coo|vp|director|head of)\b/i.test(s)) return true;
  if (/\b(looking for|open to|hiring)\b/i.test(s)) return true;
  return false;
}

function isPlausibleCompanyName(name) {
  if (name.length < 2 || name.length > 60) return false;
  // Person-style "First Last" alone is not a company.
  if (/^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(name) && name.split(/\s+/).length === 2) return false;
  if (/\b(linkedin|profile|resume|cv)\b/i.test(name)) return false;
  return true;
}

module.exports = BuyerCollector;
