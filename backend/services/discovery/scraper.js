const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');
const config = require('../../config/env');
const logger = require('../../utils/logger');
const { SOURCES } = require('../../utils/constants');
const dedup = require('./deduplication');
const Lead = require('../../models/Lead');
const Signal = require('../../models/Signal');
const aiExtractor = require('./aiEntityExtractor');

/**
 * Deep Web Scraper & Developer Ecosystem Prospector
 * Aggregates prospects from GitHub Organizations API, HackerNews, DuckDuckGo, and Google
 */
class WebScraper {
  constructor() {
    this.browser = null;
    this.rateLimitMs = config.scraping.rateLimitMs;
    this.userAgent = config.scraping.userAgent;
  }

  async init() {
    if (!this.browser) {
      try {
        this.browser = await puppeteer.launch({
          headless: 'new',
          timeout: 4000,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
          ],
        });
        logger.info('Puppeteer browser launched');
      } catch (err) {
        logger.warn(`Puppeteer notice (${err.message}). Using HTTP discovery mode.`);
        this.browser = null;
      }
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => null);
      this.browser = null;
    }
  }

  async delay(ms = 800) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Run deep discovery for a specific ICP
   */
  async discoverForICP(icp) {
    const results = { found: 0, new: 0, duplicate: 0, errors: 0 };

    try {
      const queries = this.buildSearchQueries(icp);
      logger.info(`Built ${queries.length} deep web discovery queries for ICP: ${icp.name}`);

      for (const searchQuery of queries) {
        try {
          const rawItems = await this.searchAndExtract(searchQuery, icp);
          results.found += rawItems.length;

          if (rawItems.length === 0) continue;

          // Process ALL raw web items with AI Entity Extractor
          const extractedCompanies = await aiExtractor.extractEntities(rawItems, icp);

          for (let i = 0; i < extractedCompanies.length; i++) {
            const company = extractedCompanies[i];
            const rawItem = rawItems[i] || {};

            try {
              if (!company.name || company.name.length < 2) continue;

              const hash = dedup.generateHash({
                name: company.name,
                email: '',
                source: SOURCES.WEB_SCRAPE,
              });

              const existing = await Lead.findByHash(hash);

              if (existing) {
                results.duplicate++;
                await Signal.create({
                  lead_id: existing.id,
                  signal_type: 'web_mention',
                  source: 'google_search',
                  source_url: rawItem.url || company.website,
                  title: `Found in web search: ${searchQuery}`,
                  content: company.description,
                  relevance_score: 0.7,
                });
              } else {
                const lead = await Lead.create({
                  icp_id: icp.id,
                  company_name: company.name,
                  company_website: company.website,
                  company_industry: company.industry || icp.industries?.[0] || 'B2B SaaS',
                  company_location: company.location || icp.geographies?.[0] || 'United States',
                  company_description: company.description,
                  contact_title: company.contactTitle || icp.job_titles?.[0] || 'CTO',
                  source: SOURCES.WEB_SCRAPE,
                  source_url: rawItem.url || company.website,
                  raw_signal_data: { search_query: searchQuery, snippet: company.description },
                  dedup_hash: hash,
                });
                results.new++;

                await Signal.create({
                  lead_id: lead.id,
                  signal_type: 'web_mention',
                  source: 'google_search',
                  source_url: rawItem.url || company.website,
                  title: `Discovered via web search: ${searchQuery}`,
                  content: company.description,
                  relevance_score: 0.75,
                });
              }
            } catch (err) {
              logger.error(`Error saving web company ${company.name}:`, err.message);
              results.errors++;
            }
          }

          await this.delay();
        } catch (err) {
          logger.error(`Error with search query "${searchQuery}":`, err.message);
          results.errors++;
        }
      }
    } catch (err) {
      logger.error('Web scraper fatal error:', err.message);
      throw err;
    } finally {
      await this.close();
    }

    logger.info(`Deep web scraper results for ICP "${icp.name}":`, results);
    return results;
  }

  buildSearchQueries(icp) {
    const queries = [];
    const industries = icp.industries || ['B2B SaaS', 'Cloud Computing'];
    const geographies = icp.geographies || ['United States', 'Canada'];
    const keywords = icp.keywords || ['devops', 'kubernetes', 'cloud cost', 'security'];

    for (const industry of industries) {
      for (const geo of geographies.slice(0, 2)) {
        queries.push(`${industry} companies ${geo}`);
        queries.push(`${industry} tech enterprise ${geo}`);
      }
      for (const kw of keywords.slice(0, 2)) {
        queries.push(`${industry} ${kw} startup`);
      }
    }

    return queries.slice(0, 6);
  }

  /**
   * Aggregate search items using Puppeteer DOM navigation + Cheerio parsing,
   * with Axios HTTP fallback and GitHub/HackerNews prospect discovery.
   */
  async searchAndExtract(searchQuery, icp) {
    const items = [];

    // 1. Puppeteer + Cheerio Real Web Search Engine Scraping
    try {
      await this.init();
      if (this.browser) {
        const page = await this.browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 7000 }).catch(() => null);

        const html = await page.content();
        await page.close().catch(() => null);

        if (html && html.length > 500) {
          const $ = cheerio.load(html);

          $('.result').each((i, el) => {
            if (items.length >= 15) return false;
            const title = $(el).find('.result__title').text().trim();
            const snippet = $(el).find('.result__snippet').text().trim();
            const rawUrl = $(el).find('.result__url').text().trim();

            let url = rawUrl;
            if (url && !url.startsWith('http')) {
              url = `https://${url}`;
            }

            if (title && snippet) {
              items.push({
                title,
                snippet,
                url: url || `https://duckduckgo.com/?q=${encodeURIComponent(title)}`,
                source: 'puppeteer_web_scrape'
              });
            }
          });
          logger.info(`Puppeteer + Cheerio scraped ${items.length} live web results for "${searchQuery}"`);
        }
      }
    } catch (err) {
      logger.debug(`Puppeteer web scrape notice (${searchQuery}): ${err.message}`);
    }

    // 2. Axios + Cheerio Fallback Web Scraping (if Puppeteer returned limited items)
    if (items.length < 5) {
      try {
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
        const res = await axios.get(searchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          timeout: 6000,
        });

        if (res.data) {
          const $ = cheerio.load(res.data);
          $('.result').each((i, el) => {
            if (items.length >= 20) return false;
            const title = $(el).find('.result__title').text().trim();
            const snippet = $(el).find('.result__snippet').text().trim();
            const rawUrl = $(el).find('.result__url').text().trim();

            let url = rawUrl;
            if (url && !url.startsWith('http')) {
              url = `https://${url}`;
            }

            if (title && snippet) {
              items.push({
                title,
                snippet,
                url: url || `https://duckduckgo.com/?q=${encodeURIComponent(title)}`,
                source: 'cheerio_http_scrape'
              });
            }
          });
        }
      } catch (err) {
        logger.debug(`Cheerio HTTP scrape notice (${searchQuery}): ${err.message}`);
      }
    }

    // 3. Discover Real Tech Companies via GitHub Organizations API
    try {
      const geo = (icp.geographies?.[0] || 'USA').toLowerCase();
      const keywords = icp.keywords || ['devops', 'saas', 'cloud'];
      
      for (const kw of keywords.slice(0, 2)) {
        const ghUrl = `https://api.github.com/search/users?q=type:org+${encodeURIComponent(kw)}+location:${encodeURIComponent(geo)}&per_page=15`;
        const ghRes = await axios.get(ghUrl, {
          headers: { 'User-Agent': 'LeadPulse-AI-Scraper' },
          timeout: 8000
        });

        const orgs = ghRes.data?.items || [];
        for (const org of orgs) {
          if (org.login) {
            const compName = org.login.replace(/[-_]/g, ' ');
            const capName = compName.charAt(0).toUpperCase() + compName.slice(1);
            items.push({
              title: `${capName} Tech Organization`,
              snippet: `${capName} is an active tech organization on GitHub building ${kw} infrastructure & software solutions.`,
              url: org.html_url || `https://github.com/${org.login}`
            });
          }
        }
      }
    } catch (err) {
      logger.debug(`GitHub Orgs API notice: ${err.message}`);
    }

    // 4. Discover Startups & Products via HackerNews Algolia Search API
    try {
      const queryTerm = icp.keywords?.[0] || icp.industries?.[0] || 'SaaS';
      const hnUrl = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent('Show HN ' + queryTerm)}&tags=story&hitsPerPage=25`;

      const hnRes = await axios.get(hnUrl, { timeout: 8000 });
      const hits = hnRes.data?.hits || [];

      for (const hit of hits) {
        if (hit.title) {
          items.push({
            title: hit.title,
            snippet: hit.title,
            url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`
          });
        }
      }
    } catch (err) {
      logger.debug(`HN Algolia notice: ${err.message}`);
    }

    return items;
  }
}

module.exports = new WebScraper();
