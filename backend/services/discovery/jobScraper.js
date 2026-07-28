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
 * Deep Job Board Signal Collector
 * Detects live hiring intent from RemoteOK, Jobicy, HackerNews Who's Hiring, and Indeed
 */
class JobScraper {
  constructor() {
    this.rateLimitMs = config.scraping.rateLimitMs;
    this.userAgent = config.scraping.userAgent;
  }

  async delay(ms = 800) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Run deep job posting monitoring for an ICP
   */
  async monitorForICP(icp) {
    const results = { found: 0, new: 0, duplicate: 0, errors: 0 };

    try {
      const queries = this.buildJobQueries(icp);
      logger.info(`Built ${queries.length} deep job queries for ICP: ${icp.name}`);

      for (const searchQuery of queries) {
        try {
          const rawJobs = await this.searchJobs(searchQuery, icp);
          results.found += rawJobs.length;

          if (rawJobs.length === 0) continue;

          // AI entity extraction for job listings
          const extractedCompanies = await aiExtractor.extractEntities(rawJobs, icp);

          for (let i = 0; i < extractedCompanies.length; i++) {
            const company = extractedCompanies[i];
            const rawJob = rawJobs[i] || {};

            try {
              if (!company.name || company.name.length < 2) continue;

              const hash = dedup.generateHash({
                name: company.name,
                email: '',
                source: SOURCES.JOB_BOARD,
              });

              const existing = await Lead.findByHash(hash);

              if (existing) {
                results.duplicate++;
                await Signal.create({
                  lead_id: existing.id,
                  signal_type: SIGNAL_TYPES.JOB_POSTING,
                  source: 'job_board',
                  source_url: rawJob.url || company.sourceUrl,
                  title: `Hiring Signal: ${rawJob.title || company.contactTitle || 'Tech Role'}`,
                  content: rawJob.description || company.description,
                  relevance_score: 0.9,
                  metadata: { job_title: rawJob.title, location: rawJob.location },
                });
              } else {
                const lead = await Lead.create({
                  icp_id: icp.id,
                  company_name: company.name,
                  company_website: company.website,
                  company_location: company.location || rawJob.location || icp.geographies?.[0] || 'United States',
                  company_industry: company.industry || icp.industries?.[0] || 'B2B SaaS',
                  company_description: company.description,
                  contact_title: company.contactTitle || rawJob.title || icp.job_titles?.[0] || 'CTO',
                  source: SOURCES.JOB_BOARD,
                  source_url: rawJob.url || company.sourceUrl,
                  raw_signal_data: {
                    job_title: rawJob.title,
                    job_location: rawJob.location,
                    snippet: (rawJob.description || '').substring(0, 300),
                  },
                  dedup_hash: hash,
                });
                results.new++;

                await Signal.create({
                  lead_id: lead.id,
                  signal_type: SIGNAL_TYPES.JOB_POSTING,
                  source: 'job_board',
                  source_url: rawJob.url || company.sourceUrl,
                  title: `Hiring Intent: ${rawJob.title || 'Technical Leadership Hiring'}`,
                  content: rawJob.description || company.description,
                  relevance_score: 0.95,
                  metadata: { job_title: rawJob.title, location: rawJob.location },
                });
              }
            } catch (err) {
              logger.error('Error processing job lead:', err.message);
              results.errors++;
            }
          }

          await this.delay();
        } catch (err) {
          logger.error(`Job search failed for "${searchQuery}":`, err.message);
          results.errors++;
        }
      }
    } catch (err) {
      logger.error('Job scraper fatal error:', err.message);
      throw err;
    }

    logger.info(`Deep job scraper results for ICP "${icp.name}":`, results);
    return results;
  }

  /**
   * Build queries for job intent discovery
   */
  buildJobQueries(icp) {
    const queries = [];
    const titles = icp.job_titles || ['DevOps', 'CTO', 'VP Engineering', 'Cloud Architect', 'Head of Infrastructure'];
    for (const title of titles.slice(0, 4)) {
      queries.push(`${title} hiring`);
    }
    return queries.slice(0, 4);
  }

  /**
   * Search real job APIs: RemoteOK, Jobicy, HackerNews Who's Hiring
   */
  async searchJobs(searchQuery, icp) {
    const jobs = [];

    // 1. Fetch live jobs from RemoteOK API (expanded)
    try {
      const res = await axios.get('https://remoteok.com/api', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 8000,
      });

      if (Array.isArray(res.data)) {
        const rawItems = res.data.slice(1);
        for (const item of rawItems) {
          if (jobs.length >= 25) break;
          if (item.company && item.position) {
            jobs.push({
              title: item.position,
              company: item.company,
              snippet: `${item.company} is hiring for ${item.position}. Tags: ${(item.tags || []).join(', ')}`,
              description: (item.description || item.position).substring(0, 300),
              url: item.url || `https://remoteok.com/l/${item.id}`,
              location: item.location || 'Remote USA',
            });
          }
        }
      }
    } catch (err) {
      logger.debug(`RemoteOK notice: ${err.message}`);
    }

    // 2. Fetch live jobs from Jobicy API (expanded)
    try {
      const res = await axios.get('https://jobicy.com/api/v2/remote-jobs?count=30', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 8000,
      });

      const rawList = res.data?.jobs || [];
      for (const item of rawList) {
        if (jobs.length >= 40) break;
        if (item.companyName && item.jobTitle) {
          jobs.push({
            title: item.jobTitle,
            company: item.companyName,
            snippet: `${item.companyName} is hiring ${item.jobTitle}. Category: ${item.jobCategory || 'Tech'}`,
            description: (item.jobExcerpt || item.jobTitle).substring(0, 300),
            url: item.url || 'https://jobicy.com',
            location: item.jobGeo || 'Remote',
          });
        }
      }
    } catch (err) {
      logger.debug(`Jobicy notice: ${err.message}`);
    }

    // 3. Fetch HackerNews Algolia Search API for hiring posts (expanded)
    try {
      const hnRes = await axios.get('https://hn.algolia.com/api/v1/search?query=who+is+hiring&tags=story&hitsPerPage=15', {
        timeout: 8000
      });

      const hits = hnRes.data?.hits || [];
      for (const hit of hits) {
        if (hit.title) {
          jobs.push({
            title: hit.title,
            company: '',
            snippet: hit.title,
            url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
            location: 'Remote / US',
          });
        }
      }
    } catch (err) {
      logger.debug(`HN Algolia notice: ${err.message}`);
    }

    return jobs;
  }
}

module.exports = new JobScraper();
