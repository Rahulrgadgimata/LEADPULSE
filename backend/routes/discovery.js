const express = require('express');
const router = express.Router();
const discoveryQueue = require('../services/queue/discoveryQueue');
const webScraper = require('../services/discovery/scraper');
const newsScraper = require('../services/discovery/newsScraper');
const jobScraper = require('../services/discovery/jobScraper');
const socialScraper = require('../services/discovery/socialScraper');
const enrichment = require('../services/discovery/enrichment');
const scorer = require('../services/scoring/scorer');
const ICP = require('../models/ICP');
const Lead = require('../models/Lead');
const config = require('../config/env');
const { query } = require('../config/database');
const logger = require('../utils/logger');

// In-memory job progress tracker for direct execution fallback
const activeJobs = new Map();

/**
 * POST /api/discovery/run/:icpId
 * Trigger an on-demand discovery run for a specific ICP
 */
router.post('/run/:icpId', async (req, res) => {
  try {
    let { icpId } = req.params;
    const payload = req.body || {};

    // Apply header API keys if present
    if (req.headers['x-groq-api-key']) config.groq.apiKey = req.headers['x-groq-api-key'];
    if (req.headers['x-apollo-api-key']) config.apollo.apiKey = req.headers['x-apollo-api-key'];
    if (req.headers['x-hunter-api-key']) config.hunter.apiKey = req.headers['x-hunter-api-key'];

    // Verify or auto-create ICP from ID or payload
    let icp = null;
    if (icpId && icpId !== 'default') {
      icp = await ICP.findById(icpId).catch(() => null);
    }

    // If payload contains specific ICP configuration (e.g. Fintech, AI/ML, Healthcare, or Custom)
    if (!icp && payload.name) {
      icp = await ICP.create({
        name: payload.name,
        description: payload.description || '',
        industries: payload.industries || ['Technology'],
        company_size_min: payload.company_size_min || 1,
        company_size_max: payload.company_size_max || 10000,
        geographies: payload.geographies || ['United States'],
        job_titles: payload.job_titles || ['CTO', 'VP of Engineering'],
        keywords: payload.keywords || [],
      }).catch(() => null);

      if (!icp) {
        icp = {
          id: payload.id || `icp_${Date.now()}`,
          name: payload.name,
          description: payload.description || '',
          industries: payload.industries || ['Technology'],
          company_size_min: payload.company_size_min || 1,
          company_size_max: payload.company_size_max || 10000,
          geographies: payload.geographies || ['United States'],
          job_titles: payload.job_titles || ['CTO', 'VP of Engineering'],
          keywords: payload.keywords || []
        };
      }
    }

    // Fallback to active ICP list or default ICP
    if (!icp) {
      const activeList = await ICP.listActive().catch(() => []);
      if (activeList && activeList.length > 0) {
        icp = activeList[0];
      } else {
        icp = {
          id: 'default-icp-001',
          name: 'US B2B SaaS Enterprise CTOs',
          industries: ['B2B SaaS', 'Cloud Computing'],
          geographies: ['United States'],
          job_titles: ['CTO', 'VP Engineering'],
          keywords: ['kubernetes', 'cloud cost', 'hiring devops']
        };
      }
    }

    icpId = icp.id;
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    // Initial job tracking state
    const jobState = {
      id: jobId,
      icpId,
      status: 'running',
      progress: 5,
      statusText: `Initializing real-time discovery engine for "${icp.name}"...`,
      results: { found: 0, new: 0, duplicate: 0, errors: 0 },
      createdAt: new Date().toISOString()
    };
    activeJobs.set(jobId, jobState);

    // Try adding to Bull queue if Redis is running (with 1s connection timeout)
    let queuedInBull = false;
    try {
      const bullJob = await Promise.race([
        discoveryQueue.add('run-discovery', { icpId, triggerType: 'on_demand' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Redis connection timeout')), 1000))
      ]);
      if (bullJob) queuedInBull = true;
    } catch (bullErr) {
      logger.warn(`Bull queue bypassed (${bullErr.message}). Running direct background execution.`);
    }

    // Direct real-time background execution runner
    if (!queuedInBull) {
      setImmediate(() => {
        runDiscoveryDirectly(jobId, icp, jobState);
      });
    }

    logger.info(`Discovery job started: ${jobId} for ICP: ${icp.name}`);

    res.status(202).json({
      message: 'Discovery job queued successfully',
      jobId,
      icpId,
      icpName: icp.name
    });
  } catch (err) {
    logger.error('Failed to start discovery job:', err.message);
    res.status(500).json({ error: 'Failed to start discovery' });
  }
});

/**
 * Real-time background runner for scrapers, news, jobs, social, enrichment & scoring
 */
async function runDiscoveryDirectly(jobId, icp, jobState) {
  try {
    // Phase 1: Web scraping (10-30%)
    jobState.progress = 15;
    jobState.statusText = `Scanning Developer Platforms & Web sources for "${icp.name}"...`;
    logger.info(`[Job ${jobId}] Phase 1: Web Scraping...`);
    const webResults = await webScraper.discoverForICP(icp).catch(err => {
      logger.warn(`Web scraper notice: ${err.message}`);
      return { found: 0, new: 0, duplicate: 0, errors: 0 };
    });
    mergeJobResults(jobState.results, webResults);

    // Phase 2: News monitoring (30-50%)
    jobState.progress = 35;
    jobState.statusText = `Monitoring Google News & PR RSS feeds for "${icp.industries?.[0] || 'Tech'}"...`;
    logger.info(`[Job ${jobId}] Phase 2: News Scraper...`);
    const newsResults = await newsScraper.monitorForICP(icp).catch(err => {
      logger.warn(`News scraper notice: ${err.message}`);
      return { found: 0, new: 0, duplicate: 0, errors: 0 };
    });
    mergeJobResults(jobState.results, newsResults);

    // Phase 3: Job postings (50-70%)
    jobState.progress = 55;
    jobState.statusText = `Detecting RemoteOK, Jobicy & HackerNews hiring intent signals...`;
    logger.info(`[Job ${jobId}] Phase 3: Job Scraper...`);
    const jobResults = await jobScraper.monitorForICP(icp).catch(err => {
      logger.warn(`Job scraper notice: ${err.message}`);
      return { found: 0, new: 0, duplicate: 0, errors: 0 };
    });
    mergeJobResults(jobState.results, jobResults);

    // Phase 4: Social signals (70-85%)
    jobState.progress = 75;
    jobState.statusText = `Extracting Reddit & social pain-point mentions...`;
    logger.info(`[Job ${jobId}] Phase 4: Social Scraper...`);
    const socialResults = await socialScraper.monitorForICP(icp).catch(err => {
      logger.warn(`Social scraper notice: ${err.message}`);
      return { found: 0, new: 0, duplicate: 0, errors: 0 };
    });
    mergeJobResults(jobState.results, socialResults);

    // Phase 5: Contact Enrichment & 5-Dimension AI Scoring (85-100%)
    jobState.progress = 90;
    jobState.statusText = `Enriching decision maker contacts & calculating 5-dimension AI scores...`;
    logger.info(`[Job ${jobId}] Phase 5: Enrichment & AI Scoring...`);
    
    // Score all leads for this ICP
    const currentLeads = await Lead.list({ icpId: icp.id, limit: 50 }).catch(() => ({ leads: [] }));
    if (currentLeads.leads && currentLeads.leads.length > 0) {
      await scorer.scoreLeads(currentLeads.leads, icp, 'initial').catch(() => null);
    }

    jobState.progress = 100;
    jobState.status = 'completed';
    jobState.statusText = `Completed! Discovered ${jobState.results.found} real prospects matching target ICP "${icp.name}".`;
    jobState.completedAt = new Date().toISOString();
    logger.info(`[Job ${jobId}] Finished successfully:`, jobState.results);
  } catch (err) {
    logger.error(`[Job ${jobId}] Failed: ${err.message}`);
    jobState.status = 'failed';
    jobState.error = err.message;
  }
}

function mergeJobResults(total, partial) {
  total.found += partial.found || 0;
  total.new += partial.new || 0;
  total.duplicate += partial.duplicate || 0;
  total.errors += partial.errors || 0;
}

/**
 * GET /api/discovery/status/:jobId
 * Check the status of a discovery job
 */
router.get('/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;

    if (activeJobs.has(jobId)) {
      const activeState = activeJobs.get(jobId);
      return res.json({
        jobId: activeState.id,
        state: activeState.status,
        progress: activeState.progress,
        statusText: activeState.statusText,
        result: activeState.results,
        createdAt: activeState.createdAt,
        completedAt: activeState.completedAt
      });
    }

    const job = await discoveryQueue.getJob(jobId).catch(() => null);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const state = await job.getState();
    const progress = job.progress();

    res.json({
      jobId: job.id,
      state,
      progress,
      data: job.data,
      result: job.returnvalue,
      failedReason: job.failedReason,
      createdAt: new Date(job.timestamp),
      processedAt: job.processedOn ? new Date(job.processedOn) : null,
      finishedAt: job.finishedOn ? new Date(job.finishedOn) : null,
    });
  } catch (err) {
    logger.error('Failed to get job status:', err.message);
    res.status(500).json({ error: 'Failed to get job status' });
  }
});

/**
 * GET /api/discovery/jobs
 * List recent discovery jobs
 */
router.get('/jobs', async (req, res) => {
  try {
    const { icpId, status, limit = 20 } = req.query;
    let sql = 'SELECT * FROM discovery_jobs';
    const params = [];
    const conditions = [];

    if (icpId) {
      conditions.push(`icp_id = $${params.length + 1}`);
      params.push(icpId);
    }
    if (status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit, 10));

    const result = await query(sql, params);
    res.json({ jobs: result.rows });
  } catch (err) {
    logger.error('Failed to list discovery jobs:', err.message);
    res.status(500).json({ error: 'Failed to list jobs' });
  }
});

module.exports = router;
