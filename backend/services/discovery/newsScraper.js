const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../../config/env');
const logger = require('../../utils/logger');
const { SOURCES, SIGNAL_TYPES } = require('../../utils/constants');
const dedup = require('./deduplication');
const Lead = require('../../models/Lead');
const Signal = require('../../models/Signal');
const aiExtractor = require('./aiEntityExtractor');

/**
 * Deep News & PR Article Monitoring Service
 * Aggregates live industry news across global feeds and extracts company leads matching ICP criteria
 */
class NewsScraper {
  constructor() {
    this.rateLimitMs = config.scraping.rateLimitMs;
    this.userAgent = config.scraping.userAgent;
  }

  async delay(ms = 800) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Run deep news monitoring for an ICP
   * @param {Object} icp - Target ICP configuration
   * @returns {Object} Discovery summary
   */
  async monitorForICP(icp) {
    const results = { found: 0, new: 0, duplicate: 0, errors: 0 };

    try {
      const queries = this.buildNewsQueries(icp);
      logger.info(`Built ${queries.length} deep news queries for ICP: ${icp.name}`);

      for (const searchQuery of queries) {
        try {
          const rawArticles = await this.searchNews(searchQuery);
          results.found += rawArticles.length;

          if (rawArticles.length === 0) continue;

          // Extract company entities using Groq AI / Fallback extractor
          const extractedCompanies = await aiExtractor.extractEntities(rawArticles, icp);

          for (const company of extractedCompanies) {
            try {
              if (!company.name || company.name.length < 2) continue;

              const hash = dedup.generateHash({
                name: company.name,
                email: '',
                source: SOURCES.NEWS,
              });

              const existing = await Lead.findByHash(hash);

              if (existing) {
                results.duplicate++;
                await Signal.create({
                  lead_id: existing.id,
                  signal_type: SIGNAL_TYPES.NEWS_MENTION,
                  source: 'google_news',
                  source_url: company.sourceUrl,
                  title: `News Signal: ${company.name} expansion / funding`,
                  content: company.description,
                  relevance_score: 0.8,
                  metadata: { query: searchQuery },
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
                  source: SOURCES.NEWS,
                  source_url: company.sourceUrl,
                  raw_signal_data: {
                    query: searchQuery,
                    description: company.description,
                  },
                  dedup_hash: hash,
                });
                results.new++;

                await Signal.create({
                  lead_id: lead.id,
                  signal_type: SIGNAL_TYPES.NEWS_MENTION,
                  source: 'google_news',
                  source_url: company.sourceUrl,
                  title: `News Signal: ${company.name} market growth`,
                  content: company.description,
                  relevance_score: 0.85,
                  metadata: { query: searchQuery },
                });
              }
            } catch (err) {
              logger.error('Error processing news company:', err.message);
              results.errors++;
            }
          }

          await this.delay();
        } catch (err) {
          logger.error(`News search failed for "${searchQuery}":`, err.message);
          results.errors++;
        }
      }
    } catch (err) {
      logger.error('News scraper fatal error:', err.message);
      throw err;
    }

    logger.info(`Deep news scraper results for ICP "${icp.name}":`, results);
    return results;
  }

  /**
   * Build comprehensive news search queries from ICP parameters
   */
  buildNewsQueries(icp) {
    const queries = [];
    const industries = icp.industries || ['B2B SaaS', 'Technology'];
    const keywords = icp.keywords || ['cloud cost', 'kubernetes', 'funding', 'infrastructure'];

    for (const industry of industries) {
      queries.push(`${industry} funding growth 2026`);
      queries.push(`${industry} tech expansion`);
      for (const kw of keywords.slice(0, 2)) {
        queries.push(`${industry} ${kw} news`);
      }
    }

    return queries.slice(0, 6);
  }

  /**
   * Fetch live articles from Google News RSS feeds
   */
  async searchNews(searchQuery) {
    const articles = [];

    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=en-US&gl=US&ceid=US:en`;
      const response = await axios.get(url, {
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml'
        },
        timeout: 10000,
      });

      const $ = cheerio.load(response.data, { xmlMode: true });

      $('item').each((i, el) => {
        if (i >= 25) return false; // Up to 25 articles per query
        const title = $(el).find('title').text().trim();
        const link = $(el).find('link').text().trim();
        const snippet = $(el).find('description').text().replace(/<[^>]*>/g, '').trim();
        const pubDate = $(el).find('pubDate').text().trim();

        if (title && link) {
          articles.push({
            title,
            url: link,
            snippet,
            date: pubDate,
          });
        }
      });
    } catch (err) {
      logger.warn(`Google News RSS fetch notice (${searchQuery}): ${err.message}`);
    }

    return articles;
  }
}

module.exports = new NewsScraper();
