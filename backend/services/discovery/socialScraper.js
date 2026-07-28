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
 * Deep Social & Community Signal Collector
 * Monitors Reddit subreddits and tech discussions for public posts expressing buying intent or technical pain points
 */
class SocialScraper {
  constructor() {
    this.rateLimitMs = config.scraping.rateLimitMs;
    this.userAgent = config.scraping.userAgent;
  }

  async delay(ms = 800) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Run deep social monitoring for an ICP
   */
  async monitorForICP(icp) {
    const results = { found: 0, new: 0, duplicate: 0, errors: 0 };

    try {
      const redditResults = await this.monitorReddit(icp);
      results.found += redditResults.found;
      results.new += redditResults.new;
      results.duplicate += redditResults.duplicate;
      results.errors += redditResults.errors;
    } catch (err) {
      logger.error('Social scraper fatal error:', err.message);
      throw err;
    }

    logger.info(`Deep social scraper results for ICP "${icp.name}":`, results);
    return results;
  }

  /**
   * Monitor Reddit for pain-point discussions across multiple tech subreddits
   */
  async monitorReddit(icp) {
    const results = { found: 0, new: 0, duplicate: 0, errors: 0 };

    const subreddits = this.getRelevantSubreddits(icp);
    const queries = this.buildSocialQueries(icp);
    logger.info(`Monitoring ${subreddits.length} subreddits for ICP: ${icp.name}`);

    for (const subreddit of subreddits.slice(0, 5)) {
      for (const searchQuery of queries.slice(0, 2)) {
        try {
          const rawPosts = await this.searchReddit(subreddit, searchQuery);
          results.found += rawPosts.length;

          if (rawPosts.length === 0) continue;

          // AI Entity extraction for social posts
          const extractedCompanies = await aiExtractor.extractEntities(rawPosts, icp);

          for (let i = 0; i < extractedCompanies.length; i++) {
            const company = extractedCompanies[i];
            const rawPost = rawPosts[i] || {};

            try {
              if (!company.name || company.name.length < 2) continue;

              const hash = dedup.generateHash({
                name: company.name,
                email: '',
                source: SOURCES.SOCIAL,
              });

              const existing = await Lead.findByHash(hash);

              if (existing) {
                results.duplicate++;
                await Signal.create({
                  lead_id: existing.id,
                  signal_type: SIGNAL_TYPES.SOCIAL_POST,
                  source: `reddit_${subreddit}`,
                  source_url: rawPost.url || company.website,
                  title: rawPost.title || `Social Mention: ${company.name}`,
                  content: rawPost.body || company.description,
                  relevance_score: 0.75,
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
                  source: SOURCES.SOCIAL,
                  source_url: rawPost.url || company.website,
                  raw_signal_data: {
                    platform: 'reddit',
                    subreddit,
                    post_title: rawPost.title,
                    snippet: (rawPost.body || '').substring(0, 300),
                  },
                  dedup_hash: hash,
                });
                results.new++;

                await Signal.create({
                  lead_id: lead.id,
                  signal_type: SIGNAL_TYPES.SOCIAL_POST,
                  source: `reddit_${subreddit}`,
                  source_url: rawPost.url || company.website,
                  title: rawPost.title || `Pain Point Discussion: ${company.name}`,
                  content: rawPost.body || company.description,
                  relevance_score: 0.8,
                });
              }
            } catch (err) {
              results.errors++;
            }
          }

          await this.delay();
        } catch (err) {
          logger.warn(`Reddit search failed for r/${subreddit}: ${err.message}`);
          results.errors++;
        }
      }
    }

    return results;
  }

  getRelevantSubreddits(icp) {
    const defaultSubs = ['SaaS', 'devops', 'startups', 'entrepreneur', 'cloud', 'sysadmin', 'cybersecurity'];
    const keywords = (icp.industries || []).concat(icp.keywords || []);
    
    for (const kw of keywords) {
      const lower = kw.toLowerCase();
      if (lower.includes('fintech')) defaultSubs.push('fintech');
      if (lower.includes('health')) defaultSubs.push('healthIT');
      if (lower.includes('ai') || lower.includes('machine learning')) defaultSubs.push('MachineLearning');
    }

    return Array.from(new Set(defaultSubs));
  }

  buildSocialQueries(icp) {
    const kw = icp.keywords?.[0] || 'kubernetes';
    return [
      `looking for ${kw}`,
      `alternative to ${kw}`,
      `recommendation for ${icp.industries?.[0] || 'SaaS'}`,
      `struggling with ${kw}`
    ];
  }

  /**
   * Search Reddit using JSON API & RSS feeds with Cheerio parsing
   */
  async searchReddit(subreddit, searchQuery) {
    const posts = [];

    // 1. Try Reddit JSON API
    try {
      const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(searchQuery)}&sort=new&restrict_sr=1&limit=15`;
      const response = await axios.get(url, {
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 8000,
      });

      const children = response.data?.data?.children || [];
      children.forEach(child => {
        if (child.data?.title) {
          posts.push({
            title: child.data.title,
            body: (child.data.selftext || child.data.title).substring(0, 400),
            url: `https://reddit.com${child.data.permalink}`,
            author: child.data.author,
          });
        }
      });
    } catch (err) {
      logger.debug(`Reddit JSON API notice for r/${subreddit}: ${err.message}`);
    }

    // 2. RSS + Cheerio Fallback for Reddit
    if (posts.length === 0) {
      try {
        const rssUrl = `https://www.reddit.com/r/${subreddit}/search.rss?q=${encodeURIComponent(searchQuery)}&sort=new&restrict_sr=1`;
        const rssRes = await axios.get(rssUrl, {
          headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          timeout: 8000,
        });

        if (rssRes.data) {
          const $ = cheerio.load(rssRes.data, { xmlMode: true });
          $('entry').each((i, el) => {
            if (posts.length >= 15) return false;
            const title = $(el).find('title').text().trim();
            const link = $(el).find('link').attr('href') || $(el).find('id').text().trim();
            const content = $(el).find('content').text().replace(/<[^>]*>/g, '').trim();

            if (title) {
              posts.push({
                title,
                body: content.substring(0, 400) || title,
                url: link || `https://reddit.com/r/${subreddit}`,
                author: 'reddit_community'
              });
            }
          });
        }
      } catch (rssErr) {
        logger.debug(`Reddit RSS notice for r/${subreddit}: ${rssErr.message}`);
      }
    }

    return posts;
  }
}

module.exports = new SocialScraper();
