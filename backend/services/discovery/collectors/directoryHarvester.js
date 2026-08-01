const cheerio = require('cheerio');
const axios = require('axios');
const logger = require('../../../utils/logger');
const config = require('../../../config/env');
const scrapling = require('../../scraplingClient');
const { isNonProspect, isMegaCorp, registrableName } = require('./domainFilter');

/**
 * Mines "Top N companies in <city>" pages for the companies they list.
 *
 * Search engines answer ICP-shaped queries mostly with listicles and
 * directories rather than company homepages — "93 Top FinTech Companies in
 * Bangalore", "31 Fintech Companies in Bangalore to Know". Those were being
 * discarded as non-prospects, which threw away the highest-yield pages in the
 * result set: a single listicle links out to 20-40 real, in-niche companies,
 * against roughly one company per ordinary search result.
 *
 * Only outbound links are taken. A directory that links to internal profile
 * pages instead (f6s, startupblink) simply yields nothing and costs one fetch.
 */

// Anchors that describe the link rather than name the company.
const GENERIC_ANCHOR =
  /^(click here|read more|learn more|visit|website|link|here|more|view|see more|apply|join.*|sign ?up|opened|home|offices?|contact|about)$/i;

// Anchor text belonging to the directory's own furniture, not a listed company.
const FURNITURE = /\b(job|jobs|career|hiring|post a|newsletter|subscribe|login|sign in|privacy|terms)\b/i;

/**
 * The company name an anchor gives us, or '' when it gives us none.
 *
 * A wrong name is worse than no name: the homepage profile step reads the real
 * one from the page itself, whereas a bogus one propagates into the lead. Some
 * directories use the bare URL as the link text, which would otherwise become a
 * company called "http://sensibull.com".
 */
function companyNameFromAnchor(anchor) {
  const text = String(anchor || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 45) return '';
  if (GENERIC_ANCHOR.test(text) || FURNITURE.test(text)) return '';
  if (/^https?:\/\//i.test(text) || /^www\./i.test(text)) return '';
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(text)) return '';  // bare domain
  if (!/[a-z]/i.test(text)) return '';
  return text;
}

// Hosts that appear in page furniture and are never prospects.
const INFRASTRUCTURE =
  /^(cdn|static|assets|img|images|media|fonts|analytics|track|pixel|ads?|adservice|doubleclick|googletagmanager|gstatic|cloudfront|akamai|w3|schema|creativecommons|gravatar|paypalobjects|licdn)\b/i;

const SHORTENERS = new Set([
  'bit', 'tinyurl', 'goo', 'ow', 't', 'buff', 'lnkd', 'rebrand', 'cutt', 'shorturl'
]);

/**
 * Does this search result look like a page that lists companies?
 *
 * Deliberately requires listing language: a random blog post that happens to
 * link out would contribute noise, not prospects.
 */
function isDirectoryPage(candidate) {
  const text = `${candidate.title || ''} ${candidate.snippet || ''}`;
  const LISTING =
    /\b(top \d+|\d+ (?:top|best|leading|fastest)|best \d+|list of|\d+\+? (?:companies|startups|firms)|companies in|startups in|firms in|directory|leading .{0,20}(?:companies|startups)|to know|to watch)\b/i;

  if (LISTING.test(text)) return true;

  // Known aggregators are worth opening even when the title is uninformative,
  // because their pages are lists by construction.
  const KNOWN = new Set([
    'f6s', 'wellfound', 'builtin', 'startupblink', 'tracxn', 'crunchbase', 'owler',
    'clutch', 'goodfirms', 'designrush', 'themanifest', 'sortlist', 'inc42',
    'yourstory', '18startup', 'growjo', 'similarweb', 'g2', 'capterra', 'producthunt'
  ]);
  return KNOWN.has(registrableName(candidate.domain));
}

async function fetchHtml(url) {
  const via = await scrapling.fetchHtml(url, {
    timeoutMs: config.SCRAPER_PAGE_TIMEOUT_MS || 30000
  });
  if (via?.html) return via.html;

  const res = await axios.get(url, {
    timeout: config.SCRAPER_PAGE_TIMEOUT_MS,
    maxRedirects: 3,
    maxContentLength: 5 * 1024 * 1024,
    responseType: 'text',
    headers: {
      'User-Agent': config.SCRAPER_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    validateStatus: () => true
  });

  const contentType = String(res.headers?.['content-type'] || '');
  if (res.status >= 400 || !contentType.includes('html') || typeof res.data !== 'string') {
    return null;
  }
  return res.data;
}

class DirectoryHarvester {
  static isDirectoryPage = isDirectoryPage;

  /**
   * Pull the companies a directory page links out to.
   * Never throws: an unreachable or link-free page yields [].
   *
   * @returns {Promise<Array<{domain,url,title,snippet,query,viaDirectory}>>}
   */
  static async harvest(page, limit = config.DISCOVERY_DIRECTORY_LINKS) {
    let host;
    try {
      host = registrableName(new URL(page.url).hostname);
    } catch (e) {
      return [];
    }

    let html;
    try {
      html = await fetchHtml(page.url);
    } catch (err) {
      logger.debug(`Directory fetch failed for ${page.domain}: ${err.message}`);
      return [];
    }
    if (!html) return [];

    const $ = cheerio.load(html);
    $('script, style, noscript, nav, footer, header').remove();

    const found = new Map();

    $('a[href^="http"]').each((_, el) => {
      if (found.size >= limit) return false;

      const $el = $(el);
      const href = $el.attr('href');
      let domain;
      try {
        domain = new URL(href).hostname.replace(/^www\./, '').toLowerCase();
      } catch (e) {
        return;
      }

      const name = registrableName(domain);
      if (!name || name === host) return;                 // the directory itself
      if (found.has(domain)) return;
      if (INFRASTRUCTURE.test(domain) || SHORTENERS.has(name)) return;
      if (isNonProspect(domain) || isMegaCorp(domain)) return;

      const usableName = companyNameFromAnchor($el.text());

      found.set(domain, {
        domain,
        // Target the homepage: a deep link from a listicle is often a press
        // release or pricing page, which profiles badly.
        url: `https://${domain}`,
        title: usableName,
        snippet: usableName ? `${usableName} — listed in "${page.title || 'directory'}"` : '',
        query: page.query,
        viaDirectory: page.domain
      });
    });

    const companies = [...found.values()];
    logger.debug(`Directory ${page.domain} yielded ${companies.length} companies`);
    return companies;
  }
}

module.exports = DirectoryHarvester;
