const Bull = require('bull');
const config = require('../../config/env');
const logger = require('../../utils/logger');
const ICP = require('../../models/ICP');
const webScraper = require('../discovery/scraper');
const newsScraper = require('../discovery/newsScraper');
const jobScraper = require('../discovery/jobScraper');
const socialScraper = require('../discovery/socialScraper');
const enrichment = require('../discovery/enrichment');
const Lead = require('../../models/Lead');
const { query } = require('../../config/database');

/**
 * Bull queue for discovery jobs
 * Handles both scheduled daily runs and on-demand triggers
 */
const discoveryQueue = new Bull('discovery', {
  redis: {
    host: config.redis.host,
    port: config.redis.port,
  },
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 20,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
  },
});

/**
 * Process discovery jobs
 */
discoveryQueue.process('run-discovery', async (job) => {
  const { icpId, triggerType } = job.data;
  logger.info(`Starting discovery job for ICP ${icpId} (${triggerType})`);

  const icp = await ICP.findById(icpId);
  if (!icp) {
    throw new Error(`ICP ${icpId} not found`);
  }

  // Create a discovery job record
  const jobRecord = await query(
    `INSERT INTO discovery_jobs (icp_id, status, trigger_type, started_at)
     VALUES ($1, 'running', $2, NOW()) RETURNING *`,
    [icpId, triggerType]
  );
  const jobId = jobRecord.rows[0].id;

  const totalResults = { found: 0, new: 0, duplicate: 0, errors: 0 };

  try {
    // Phase 1: Web scraping
    job.progress(10);
    logger.info(`[Discovery ${jobId}] Phase 1: Web scraping...`);
    const webResults = await webScraper.discoverForICP(icp);
    mergeResults(totalResults, webResults);
    job.progress(30);

    // Phase 2: News monitoring
    logger.info(`[Discovery ${jobId}] Phase 2: News monitoring...`);
    const newsResults = await newsScraper.monitorForICP(icp);
    mergeResults(totalResults, newsResults);
    job.progress(50);

    // Phase 3: Job posting signals
    logger.info(`[Discovery ${jobId}] Phase 3: Job posting monitoring...`);
    const jobResults = await jobScraper.monitorForICP(icp);
    mergeResults(totalResults, jobResults);
    job.progress(70);

    // Phase 4: Social signals
    logger.info(`[Discovery ${jobId}] Phase 4: Social monitoring...`);
    const socialResults = await socialScraper.monitorForICP(icp);
    mergeResults(totalResults, socialResults);
    job.progress(85);

    // Phase 5: Enrichment (for new leads only)
    logger.info(`[Discovery ${jobId}] Phase 5: Contact enrichment...`);
    const newLeads = await query(
      `SELECT * FROM leads WHERE icp_id = $1 AND status = 'new' 
       AND created_at >= NOW() - INTERVAL '1 hour' LIMIT 20`,
      [icpId]
    );
    if (newLeads.rows.length > 0) {
      await enrichment.batchEnrich(newLeads.rows);
    }
    job.progress(95);

    // Update job record
    await query(
      `UPDATE discovery_jobs SET status = 'completed', leads_found = $1,
       leads_new = $2, leads_duplicate = $3, completed_at = NOW()
       WHERE id = $4`,
      [totalResults.found, totalResults.new, totalResults.duplicate, jobId]
    );

    // Update ICP last_run_at
    await ICP.updateLastRun(icpId);

    job.progress(100);
    logger.info(`[Discovery ${jobId}] Completed:`, totalResults);

    // Trigger scoring for new leads
    const scoringQueue = require('./scoringQueue');
    if (totalResults.new > 0) {
      await scoringQueue.add('score-new-leads', {
        icpId,
        triggerEvent: 'initial',
      });
    }

    return totalResults;
  } catch (err) {
    logger.error(`[Discovery ${jobId}] Failed:`, err.message);
    await query(
      `UPDATE discovery_jobs SET status = 'failed', error_message = $1,
       completed_at = NOW() WHERE id = $2`,
      [err.message, jobId]
    );
    throw err;
  }
});

function mergeResults(total, partial) {
  total.found += partial.found || 0;
  total.new += partial.new || 0;
  total.duplicate += partial.duplicate || 0;
  total.errors += partial.errors || 0;
}

// Event handlers
discoveryQueue.on('completed', (job, result) => {
  logger.info(`Discovery job ${job.id} completed:`, result);
});

discoveryQueue.on('failed', (job, err) => {
  logger.error(`Discovery job ${job.id} failed:`, err.message);
});

discoveryQueue.on('progress', (job, progress) => {
  logger.debug(`Discovery job ${job.id} progress: ${progress}%`);
});

discoveryQueue.on('error', (err) => {
  logger.debug(`Bull discovery queue connection notice: ${err.message}`);
});

module.exports = discoveryQueue;
