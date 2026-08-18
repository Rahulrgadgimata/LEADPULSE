const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../../../utils/logger');
const config = require('../../../config/env');
const Search = require('./search');
const { isNonProspect, isMegaCorp } = require('./domainFilter');
const { collectWithConcurrency } = require('../../../utils/concurrency');
const runBudget = require('../runBudget');

/**
 * Discovers companies from publicly indexed LinkedIn company pages.
 *
 * LinkedIn itself blocks most direct scrapes behind a login wall. What is
 * reliably public is the search-engine index: titles, URLs and snippets for
 * linkedin.com/company/* pages. This collector:
 *
 *  1. Queries search engines for ICP-matched LinkedIn company pages
 *  2. Parses company name / size / industry / location from those snippets
 *  3. Soft-fetches the public page for Open Graph metadata when available
 *  4. Resolves an official company website so the lead can be enriched later
 */
class LinkedInCollector {
  static async searchLinkedIn(icp, options = {}) {
    const target = options.target || config.LINKEDIN_TARGET_LEADS || 80;
    const maxQueries = options.maxQueries || config.LINKEDIN_MAX_QUERIES || 24;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    const queries = this._buildQueries(icp, maxQueries);
    if (queries.length === 0) {
      logger.warn('LinkedInCollector: ICP has no industries or keywords; skipping.');
      return [];
    }

    logger.info(`LinkedInCollector: targeting ${target} companies across up to ${queries.length} queries`);

    const bySlug = new Map();
    let queriesRun = 0;

    for (const query of queries) {
      if (bySlug.size >= target * 1.4) break;
      if (runBudget.collectExpired()) {
        logger.info(`LinkedInCollector stopped after ${queriesRun} queries: collection budget reached.`);
        break;
      }
      queriesRun++;

      const results = await Search.run(query, 12);
      for (const result of results) {
        const parsed = this._parseSearchResult(result);
        if (!parsed) continue;
        const existing = bySlug.get(parsed.slug);
        if (!existing) {
          bySlug.set(parsed.slug, parsed);
        } else if (
          (/^read more$/i.test(existing.company_name) || existing.company_name.length < 3) &&
          parsed.company_name &&
          !/^read more$/i.test(parsed.company_name)
        ) {
          bySlug.set(parsed.slug, parsed);
        }
      }

      if (onProgress) {
        onProgress({
          phase: 'search',
          queriesRun,
          totalQueries: queries.length,
          candidates: bySlug.size
        });
      }
    }

    const candidates = [...bySlug.values()].slice(0, Math.ceil(target * 1.3));
    logger.info(`LinkedInCollector: ${candidates.length} unique LinkedIn company pages from ${queriesRun} queries`);
    if (candidates.length === 0) return [];

    if (onProgress) onProgress({ phase: 'enriching', candidates: candidates.length });

    // Soft-fetch is slow and LinkedIn login-walls most pages; OG tags are a
    // bonus. Prefer keeping search-snippet leads even when the page fetch fails.
    const enriched = await collectWithConcurrency(
      candidates,
      Math.min(3, config.SCRAPER_CONCURRENCY || 3),
      candidate => this._enrichCandidate(candidate)
    );

    const leads = [];
    const seenNames = new Set();

    for (const item of enriched) {
      if (!item?.company_name) continue;
      const key = item.company_name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!key || seenNames.has(key)) continue;
      seenNames.add(key);

      leads.push({
        company_name: item.company_name,
        company_website: item.company_website || null,
        company_industry: item.company_industry || null,
        company_size: item.company_size || null,
        company_location: item.company_location || null,
        company_description: item.company_description || null,
        contact_title: item.contact_title || this._firstTitle(icp),
        contact_linkedin: item.linkedin_url,
        source: 'LinkedIn',
        source_url: item.linkedin_url,
        raw_signal_data: {
          linkedin_slug: item.slug,
          linkedin_url: item.linkedin_url,
          snippet: item.snippet || null,
          from_og: !!item.from_og,
          icp_fit: item.company_website ? 'strong' : 'moderate'
        },
        signal: {
          signal_type: 'linkedin',
          source: 'LinkedIn',
          source_url: item.linkedin_url,
          title: `${item.company_name} on LinkedIn`,
          content: item.company_description || item.snippet || `Public LinkedIn company page for ${item.company_name}`,
          relevance_score: item.company_website ? 0.85 : 0.7
        }
      });

      if (leads.length >= target) break;
    }

    const LeadQuality = require('../../leadQuality');
    const best = LeadQuality.filterBest(leads);
    logger.info(`LinkedInCollector produced ${best.length} best leads (from ${leads.length} candidates)`);
    if (onProgress) onProgress({ phase: 'done', leads: best.length });
    return best;
  }

  /**
   * Build search queries that surface public LinkedIn company pages.
   *
   * Prefer "linkedin.com/company" phrasing over site: — DuckDuckGo's HTML
   * endpoint breaks on site: operators, while Serper/Brave accept both.
   */
  static _buildQueries(icp, maxQueries) {
    const industries = this._parseList(icp.industries);
    const keywords = this._parseList(icp.keywords);
    const geographies = this._parseList(icp.geographies);
    const jobTitles = this._parseList(icp.job_titles);

    if (industries.length === 0 && keywords.length === 0) return [];

    const geo = geographies[0] || '';
    const queries = [];
    const seen = new Set();

    const add = (...parts) => {
      const q = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (!q) return;
      const key = q.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      queries.push(q);
    };

    const li = 'linkedin.com/company/';

    // Prefer startups / SMBs — national "AI company" queries surface giants.
    // Trailing slash + keyword order matters: Google ranks real /company/ pages;
    // bare "linkedin.com/company Artificial Intelligence" mostly returns login hubs.
    for (const industry of industries) {
      add(industry, 'startup', geo, li);
      add(industry, 'SME', geo, li);
      for (const keyword of keywords.slice(0, 4)) {
        add(industry, keyword, 'startup', geo, li);
      }
    }

    for (const keyword of keywords) {
      add(keyword, 'startup', geo, li);
      add(keyword, 'scaleup', geo, li);
    }

    for (const title of jobTitles.slice(0, 3)) {
      add(industries[0] || keywords[0], 'startup', title, geo, li);
    }

    for (const extraGeo of geographies.slice(0, 3)) {
      for (const industry of industries.slice(0, 2)) {
        add(industry, 'startup', extraGeo, li);
      }
    }

    for (const industry of industries.slice(0, 2)) {
      add(industry, 'hiring', 'startup', geo, li);
      add(industry, 'seed', 'startup', geo, li);
    }

    return queries.slice(0, maxQueries);
  }

  /**
   * Turn a search hit into a LinkedIn company candidate, or null if not usable.
   */
  static _parseSearchResult(result) {
    if (!result?.url) return null;

    let url;
    try {
      url = new URL(result.url);
      url.hash = '';
    } catch (e) {
      return null;
    }

    if (!/linkedin\.com$/i.test(url.hostname.replace(/^www\./, '')) &&
        !/\.linkedin\.com$/i.test(url.hostname)) {
      return null;
    }

    // Only company pages — people/jobs/posts are not firmographic leads.
    const match = url.pathname.match(/^\/company\/([^/?#]+)/i);
    if (!match) return null;

    const slug = decodeURIComponent(match[1]).toLowerCase().replace(/\/+$/, '');
    if (!slug || slug === 'showcase') return null;
    // Skip LinkedIn's own page and government portals that dominate broad queries.
    if (/^(linkedin|startup-india|indiaai)$/i.test(slug)) return null;

    const linkedinUrl = `https://www.linkedin.com/company/${slug}`;
    const companyName = this._nameFromTitle(result.title, slug);
    if (!companyName) return null;
    if (isMegaCorp(companyName) || isMegaCorp(slug)) return null;

    const snippet = result.snippet || '';
    const fromSnippet = this._parseSnippet(snippet);

    // Skip obviously giant headcounts from LinkedIn snippets.
    if (fromSnippet.size && fromSnippet.size >= 10000) return null;

    return {
      slug,
      linkedin_url: linkedinUrl,
      company_name: companyName,
      company_industry: fromSnippet.industry,
      company_size: fromSnippet.size,
      company_location: fromSnippet.location,
      company_description: fromSnippet.description || snippet.slice(0, 280) || null,
      snippet,
      company_website: null,
      from_og: false,
      contact_title: null
    };
  }

  static _nameFromTitle(title, slug) {
    let name = String(title || '')
      .replace(/\s*[\|\-–—]\s*LinkedIn.*$/i, '')
      .replace(/\s*\|.*$/i, '')
      .replace(/\s*[-–—]\s*(Overview|About|Home|Jobs|Posts|Life).*$/i, '')
      .replace(/\s+on\s+LinkedIn.*$/i, '')
      .trim();

    if (!name || /^linkedin$/i.test(name) || name.length < 2) {
      name = slug
        .replace(/-inc$|-llc$|-ltd$|-corp$/i, '')
        .split('-')
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }

    // Drop junk titles that are clearly not company names.
    if (!name || /^(home|search|feed|login|sign in|read more|overview|about)$/i.test(name)) return null;
    // Strip marketing taglines: "StartupMandi AI - Transforming Businesses With AI"
    name = name.split(/\s+[-–—|]\s+/)[0].trim();
    if (!name || name.length < 2) return null;
    return name.slice(0, 120);
  }

  /**
   * LinkedIn search snippets often look like:
   * "Acme · Software Development · San Francisco, CA · 201-500 employees · ..."
   */
  static _parseSnippet(snippet) {
    const out = { industry: null, size: null, location: null, description: null };
    if (!snippet) return out;

    const sizeMatch = snippet.match(/([\d,]+\s*-\s*[\d,]+|\d[\d,]+\+?)\s*employees?/i);
    if (sizeMatch) {
      const nums = sizeMatch[1].replace(/,/g, '').match(/\d+/g);
      if (nums?.length) out.size = parseInt(nums[nums.length - 1], 10);
    }

    const parts = snippet.split(/\s*[·•|]\s*/).map(p => p.trim()).filter(Boolean);
    for (const part of parts) {
      if (/employees?/i.test(part)) continue;
      if (/followers?/i.test(part)) continue;
      if (/\d/.test(part) && /(CA|NY|TX|UK|USA|India|London|Bangalore|San Francisco|New York|remote)/i.test(part)) {
        out.location = out.location || part.slice(0, 80);
        continue;
      }
      if (!out.industry && part.length > 2 && part.length < 60 && !/https?:/i.test(part)) {
        // First short non-location fragment is usually the industry.
        if (!/^(about|overview|see more)/i.test(part)) out.industry = part;
      }
    }

    out.description = snippet.slice(0, 300);
    return out;
  }

  /**
   * Soft-fetch OG tags from the public LinkedIn page, then find a website.
   */
  static async _enrichCandidate(candidate) {
    let enriched = { ...candidate };

    try {
      const res = await axios.get(candidate.linkedin_url, {
        timeout: config.SCRAPER_PAGE_TIMEOUT_MS,
        maxRedirects: 3,
        maxContentLength: 2 * 1024 * 1024,
        responseType: 'text',
        headers: {
          'User-Agent': config.SCRAPER_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        validateStatus: () => true
      });

      if (res.status < 400 && typeof res.data === 'string' && /text\/html/i.test(String(res.headers?.['content-type'] || 'text/html'))) {
        const $ = cheerio.load(res.data);
        const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
        const ogDesc = $('meta[property="og:description"]').attr('content')?.trim();
        const ogSite = $('meta[property="og:url"]').attr('content')?.trim();

        if (ogTitle) {
          const cleaned = this._nameFromTitle(ogTitle, candidate.slug);
          if (cleaned) enriched.company_name = cleaned;
        }
        if (ogDesc && ogDesc.length > 20) {
          enriched.company_description = ogDesc.slice(0, 400);
          const fromOg = this._parseSnippet(ogDesc);
          if (fromOg.size) enriched.company_size = enriched.company_size || fromOg.size;
          if (fromOg.industry) enriched.company_industry = enriched.company_industry || fromOg.industry;
          if (fromOg.location) enriched.company_location = enriched.company_location || fromOg.location;
        }
        if (ogSite && /linkedin\.com\/company\//i.test(ogSite)) {
          enriched.linkedin_url = ogSite.split('?')[0];
        }
        enriched.from_og = !!(ogTitle || ogDesc);
      }
    } catch (err) {
      logger.debug(`LinkedIn page fetch soft-failed for ${candidate.slug}: ${err.message}`);
    }

    // Do not burn search quota resolving websites here — company LinkedIn URL
    // is enough for LeadQuality intake; enrichment fills domains later.
    return enriched;
  }

  /**
   * Find the company's real website from public search results.
   */
  static async _resolveWebsite(companyName, slug) {
    if (!companyName) return null;

    try {
      const results = await Search.run(
        `"${companyName}" official website -site:linkedin.com -site:facebook.com -site:crunchbase.com`,
        8
      );

      for (const result of results) {
        let domain;
        try {
          domain = new URL(result.url).hostname.replace(/^www\./, '');
        } catch (e) {
          continue;
        }
        if (isNonProspect(domain)) continue;
        // Prefer domains that vaguely resemble the LinkedIn slug.
        const base = domain.split('.')[0].replace(/[^a-z0-9]/gi, '');
        const slugBase = String(slug || '').replace(/[^a-z0-9]/gi, '');
        if (slugBase && base && (slugBase.includes(base) || base.includes(slugBase.slice(0, 6)))) {
          return domain;
        }
      }

      // Fall back to first clean corporate domain.
      for (const result of results) {
        let domain;
        try {
          domain = new URL(result.url).hostname.replace(/^www\./, '');
        } catch (e) {
          continue;
        }
        if (!isNonProspect(domain)) return domain;
      }
    } catch (err) {
      logger.debug(`Website resolve failed for ${companyName}: ${err.message}`);
    }

    return null;
  }

  static _firstTitle(icp) {
    const titles = this._parseList(icp.job_titles);
    return titles[0] || null;
  }

  static _parseList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }
}

module.exports = LinkedInCollector;
