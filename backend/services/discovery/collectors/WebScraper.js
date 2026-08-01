const cheerio = require('cheerio');
const axios = require('axios');
const logger = require('../../../utils/logger');
const config = require('../../../config/env');
const Search = require('./search');
const EntityExtractor = require('./entityExtractor');
const DirectoryHarvester = require('./directoryHarvester');
const { isNonProspect, isMegaCorp, registrableName } = require('./domainFilter');
const { mapWithConcurrency } = require('../../../utils/concurrency');
const LeadQuality = require('../../leadQuality');
const scrapling = require('../../scraplingClient');

/**
 * Discovers convertible companies matching an ICP by searching the public web.
 *
 * Bias: startups / SMBs / mid-market that a sales rep can actually close —
 * not FAANG and Fortune giants that dominate generic search results.
 */
class WebScraper {
  static async searchCompanies(icp, options = {}) {
    const target = options.target || config.DISCOVERY_TARGET_LEADS;
    const maxQueries = options.maxQueries || config.DISCOVERY_MAX_QUERIES;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    const queries = this._buildQueries(icp, maxQueries);
    if (queries.length === 0) {
      logger.warn('WebScraper: ICP has no industries or keywords; nothing to search.');
      return [];
    }

    logger.info(`WebScraper: targeting ${target} convertible leads across up to ${queries.length} queries`);

    const candidateGoal = Math.ceil(target * 1.6);
    const candidates = new Map();
    const directoryPages = new Map();
    let queriesRun = 0;

    for (const query of queries) {
      if (candidates.size >= candidateGoal) break;

      queriesRun++;
      const results = await Search.run(query, 10);

      for (const result of results) {
        let domain;
        try {
          domain = new URL(result.url).hostname.replace(/^www\./, '');
        } catch (e) {
          continue;
        }

        if (candidates.has(domain) || isMegaCorp(domain)) continue;

        const entry = { domain, url: result.url, title: result.title, snippet: result.snippet, query };

        // A "Top 30 fintech companies in Bangalore" page is not a prospect, but
        // it lists dozens of them. Keep it for harvesting instead of dropping it.
        if (DirectoryHarvester.isDirectoryPage(entry)) {
          if (!directoryPages.has(result.url)) directoryPages.set(result.url, entry);
          continue;
        }

        if (isNonProspect(domain)) continue;

        candidates.set(domain, entry);
      }

      if (onProgress) {
        onProgress({
          phase: 'search',
          queriesRun,
          totalQueries: queries.length,
          candidates: candidates.size
        });
      }
    }

    logger.info(
      `WebScraper: ${candidates.size} direct candidates and ${directoryPages.size} company-list pages ` +
      `from ${queriesRun} queries`
    );

    await this._harvestDirectories(directoryPages, candidates, candidateGoal, onProgress);

    const candidateList = [...candidates.values()];
    logger.info(`WebScraper: ${candidateList.length} unique candidate domains from ${queriesRun} queries`);

    if (candidateList.length === 0) return [];

    const profiled = await mapWithConcurrency(
      candidateList,
      config.SCRAPER_CONCURRENCY,
      candidate => this._profile(candidate)
    );

    const enrichedCandidates = [];
    for (let i = 0; i < profiled.length; i++) {
      const entry = profiled[i];
      enrichedCandidates.push(entry && entry.ok ? entry.value : candidateList[i]);
    }

    const reachable = enrichedCandidates.filter(c => c.fetched).length;
    logger.info(`WebScraper: profiled ${enrichedCandidates.length} candidates (${reachable} homepages fetched)`);

    if (onProgress) {
      onProgress({ phase: 'profiled', candidates: enrichedCandidates.length, fetched: reachable });
    }

    const leads = await EntityExtractor.extract(enrichedCandidates, icp);

    const byDomain = new Map();
    for (const lead of leads) {
      if (!lead || !lead.company_website) continue;
      if (isMegaCorp(lead.company_website) || isMegaCorp(lead.company_name)) continue;
      if (!byDomain.has(lead.company_website)) byDomain.set(lead.company_website, lead);
    }

    const finalLeads = LeadQuality.filterBest([...byDomain.values()].slice(0, target));
    logger.info(`WebScraper produced ${finalLeads.length} convertible leads`);

    if (onProgress) onProgress({ phase: 'extracted', leads: finalLeads.length });

    return finalLeads;
  }

  /**
   * Open the company-list pages found during search and add the companies they
   * link to as candidates.
   *
   * Mutates `candidates` in place. Pages are fetched in parallel and the whole
   * step is best-effort: harvesting is upside on top of the direct results, so
   * a failure here must not cost the run its normal candidates.
   */
  static async _harvestDirectories(directoryPages, candidates, candidateGoal, onProgress) {
    if (directoryPages.size === 0 || candidates.size >= candidateGoal) return;

    // Highest-yield pages first: an explicit count in the title ("93 Top
    // FinTech Companies…") reliably means a long list.
    const ranked = [...directoryPages.values()].sort(
      (a, b) => this._listingSize(b) - this._listingSize(a)
    );

    // At most two pages per aggregator. One site can match a dozen queries —
    // f6s alone claimed four of six slots on a test run and, being
    // client-rendered, returned nothing from any of them.
    const perSite = new Map();
    const pages = [];
    for (const page of ranked) {
      if (pages.length >= config.DISCOVERY_DIRECTORY_PAGES) break;
      const site = registrableName(page.domain);
      const used = perSite.get(site) || 0;
      if (used >= 2) continue;
      perSite.set(site, used + 1);
      pages.push(page);
    }

    if (onProgress) {
      onProgress({ phase: 'directories', pages: pages.length, candidates: candidates.size });
    }

    const harvested = await mapWithConcurrency(
      pages,
      config.SCRAPER_CONCURRENCY,
      page => DirectoryHarvester.harvest(page)
    );

    let added = 0;
    for (const entry of harvested) {
      if (!entry?.ok) continue;
      for (const company of entry.value) {
        if (candidates.size >= candidateGoal) break;
        if (candidates.has(company.domain)) continue;
        candidates.set(company.domain, company);
        added++;
      }
    }

    logger.info(
      `WebScraper: harvested ${added} companies from ${pages.length} company-list pages ` +
      `(${candidates.size} candidates total)`
    );

    if (onProgress) {
      onProgress({ phase: 'harvested', pages: pages.length, added, candidates: candidates.size });
    }
  }

  /** Companies promised by a listing title, used only to rank pages. */
  static _listingSize(page) {
    const match = /\b(\d{1,4})\b/.exec(`${page.title || ''} ${page.snippet || ''}`);
    return match ? Math.min(Number(match[1]), 500) : 0;
  }

  /**
   * Queries biased toward startups / SMBs / scale-ups in the ICP niche.
   * City + "startup"/"SME" phrasing avoids the same Fortune-500 SERP monopoly.
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
      const query = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (!query) return;
      const key = query.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      queries.push(query);
    };

    // Convertible-company modifiers (not "enterprise" — that pulls giants).
    const modifiers = [
      'startup', 'scaleup', 'SME', 'SMB', 'mid market company',
      'software startup', 'saas startup', 'bootstrapped company', 'series a startup'
    ];

    const cities = this._citiesFor(geographies);

    // 1. Listing queries first — they are the highest-yield queries available.
    // Search engines answer these with "Top 30 <industry> companies in <city>"
    // pages, and DirectoryHarvester turns each one into 20-40 real companies,
    // against roughly one company per ordinary result.
    for (const city of cities.slice(0, 6)) {
      for (const industry of industries.slice(0, 3)) {
        add('top', industry, 'startups in', city);
        add('list of', industry, 'companies in', city);
      }
    }
    for (const industry of industries) {
      add('top', industry, 'startups in', geo);
      add('best', industry, 'companies', geo, 'list');
    }

    // 2. Industry x keyword x startup/SME — highest conversion intent.
    for (const industry of industries) {
      for (const keyword of keywords) {
        add(industry, keyword, 'startup', geo);
        add(industry, keyword, 'SME company', geo);
      }
    }

    // 3. City-scoped — avoids national SERPs dominated by giants.
    for (const city of cities) {
      for (const industry of industries) {
        add(industry, 'startup', city);
        add(industry, 'company', city, '-google -microsoft -amazon');
      }
    }

    // 4. Industry x convertible modifier.
    for (const industry of industries) {
      for (const modifier of modifiers) {
        add(industry, modifier, geo);
      }
    }

    // 5. Keyword x modifier.
    for (const keyword of keywords) {
      for (const modifier of modifiers.slice(0, 5)) {
        add(keyword, modifier, geo);
      }
    }

    // 6. Hiring at smaller companies (conversion signal).
    for (const title of jobTitles.slice(0, 3)) {
      add(industries[0] || keywords[0], 'startup hiring', title, geo);
      add(industries[0] || keywords[0], 'SME', title, geo);
    }

    // 7. Secondary geos.
    for (const extraGeo of geographies.slice(1, 3)) {
      for (const industry of industries.slice(0, 2)) {
        add(industry, 'startup', extraGeo);
      }
    }

    return queries.slice(0, maxQueries);
  }

  /**
   * Major business cities for a geography, used to widen the candidate pool.
   * Unknown geographies simply contribute no city queries.
   */
  static _citiesFor(geographies) {
    const cities = [];
    for (const geo of geographies) {
      const key = String(geo).trim().toLowerCase();
      const known = CITY_HINTS[key];
      if (known) cities.push(...known);
    }
    return [...new Set(cities)];
  }

  /**
   * Fetch a candidate's homepage and pull the signals the extractor needs.
   * Never throws: an unreachable page degrades to search-result data only.
   */
  static async _profile(candidate) {
    try {
      let html = null;
      let contentType = 'text/html';
      let status = 200;

      const via = await scrapling.fetchHtml(candidate.url, {
        timeoutMs: config.SCRAPER_PAGE_TIMEOUT_MS || 30000,
      });
      if (via?.html) {
        html = via.html;
      } else {
        const res = await axios.get(candidate.url, {
          timeout: config.SCRAPER_PAGE_TIMEOUT_MS,
          maxRedirects: 3,
          maxContentLength: 3 * 1024 * 1024,
          responseType: 'text',
          headers: {
            'User-Agent': config.SCRAPER_USER_AGENT,
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          // Handle error statuses inline instead of as thrown exceptions.
          validateStatus: () => true
        });
        contentType = String(res.headers?.['content-type'] || '');
        status = res.status;
        if (status >= 400 || !contentType.includes('html') || typeof res.data !== 'string') {
          logger.debug(`WebScraper skipped body for ${candidate.domain} (status ${status}, type "${contentType}")`);
          return { ...candidate, fetched: false };
        }
        html = res.data;
      }

      const $ = cheerio.load(html);
      $('script, style, noscript, svg').remove();

      const headings = $('h1, h2')
        .slice(0, 6)
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(Boolean)
        .join(' | ');

      return {
        ...candidate,
        fetched: true,
        title: $('title').first().text().trim() || candidate.title,
        siteName: $('meta[property="og:site_name"]').attr('content')?.trim() || null,
        metaDescription:
          $('meta[name="description"]').attr('content')?.trim() ||
          $('meta[property="og:description"]').attr('content')?.trim() ||
          null,
        headings: headings || null
      };
    } catch (err) {
      logger.debug(`WebScraper could not profile ${candidate.domain}: ${err.message}`);
      return { ...candidate, fetched: false };
    }
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

// Business hubs per geography. National queries converge on the same handful of
// large companies, so city-scoped variants are what actually grow the pool.
const CITY_HINTS = {
  india: ['Bangalore', 'Mumbai', 'Delhi NCR', 'Pune', 'Hyderabad', 'Chennai', 'Gurugram', 'Noida'],
  'united states': ['New York', 'San Francisco', 'Austin', 'Chicago', 'Boston', 'Seattle', 'Atlanta'],
  usa: ['New York', 'San Francisco', 'Austin', 'Chicago', 'Boston', 'Seattle', 'Atlanta'],
  us: ['New York', 'San Francisco', 'Austin', 'Chicago', 'Boston', 'Seattle'],
  'united kingdom': ['London', 'Manchester', 'Edinburgh', 'Birmingham', 'Leeds'],
  uk: ['London', 'Manchester', 'Edinburgh', 'Birmingham', 'Leeds'],
  canada: ['Toronto', 'Vancouver', 'Montreal', 'Calgary'],
  australia: ['Sydney', 'Melbourne', 'Brisbane', 'Perth'],
  germany: ['Berlin', 'Munich', 'Frankfurt', 'Hamburg'],
  france: ['Paris', 'Lyon', 'Toulouse'],
  netherlands: ['Amsterdam', 'Rotterdam', 'Utrecht'],
  singapore: ['Singapore'],
  uae: ['Dubai', 'Abu Dhabi'],
  'united arab emirates': ['Dubai', 'Abu Dhabi'],
  japan: ['Tokyo', 'Osaka'],
  brazil: ['Sao Paulo', 'Rio de Janeiro'],
};

module.exports = WebScraper;
