const Bull = require('bull');
const config = require('../../config/env');
const logger = require('../../utils/logger');
const scorer = require('../scoring/scorer');
const explainer = require('../scoring/explainer');
const Lead = require('../../models/Lead');
const ICP = require('../../models/ICP');
const { query } = require('../../config/database');

/**
 * Bull queue for scoring jobs
 * Triggered after discovery inserts new leads, and on new-signal events
 */
const scoringQueue = new Bull('scoring', {
  redis: {
    host: config.redis.host,
    port: config.redis.port,
  },
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 20,
    attempts: 2,
    backoff: {
      type: 'fixed',
      delay: 3000,
    },
  },
});

/**
 * Process scoring for new leads
 */
scoringQueue.process('score-new-leads', async (job) => {
  const { icpId, triggerEvent } = job.data;
  logger.info(`Starting scoring job for ICP ${icpId} (trigger: ${triggerEvent})`);

  const icp = await ICP.findById(icpId);
  if (!icp) {
    throw new Error(`ICP ${icpId} not found`);
  }

  // Get unscored leads for this ICP
  const result = await query(
    `SELECT l.* FROM leads l
     LEFT JOIN lead_scores ls ON l.id = ls.lead_id
     WHERE l.icp_id = $1 AND ls.id IS NULL
     ORDER BY l.created_at DESC LIMIT 100`,
    [icpId]
  );

  const leads = result.rows;
  logger.info(`Found ${leads.length} unscored leads for ICP ${icpId}`);

  const scoreResults = await scorer.scoreLeads(leads, icp, triggerEvent);

  // Generate explanations for scored leads
  const scoredLeads = [];
  for (const sr of scoreResults) {
    if (sr.success) {
      const lead = leads.find(l => l.id === sr.leadId);
      if (lead) {
        scoredLeads.push({ lead, scoreData: sr.score });
      }
    }
  }

  if (scoredLeads.length > 0 && config.claude.apiKey) {
    logger.info(`Generating explanations for ${scoredLeads.length} leads...`);
    await explainer.batchGenerateExplanations(scoredLeads);
  }

  const summary = {
    total: leads.length,
    scored: scoreResults.filter(r => r.success).length,
    failed: scoreResults.filter(r => !r.success).length,
  };

  logger.info(`Scoring job completed for ICP ${icpId}:`, summary);
  return summary;
});

/**
 * Process re-scoring for a specific lead (new signal detected)
 */
scoringQueue.process('rescore-lead', async (job) => {
  const { leadId, triggerEvent } = job.data;
  logger.info(`Re-scoring lead ${leadId} (trigger: ${triggerEvent})`);

  const lead = await Lead.findById(leadId);
  if (!lead) {
    throw new Error(`Lead ${leadId} not found`);
  }

  let icp = null;
  if (lead.icp_id) {
    icp = await ICP.findById(lead.icp_id);
  }

  const scoreData = await scorer.scoreLead(lead, icp, triggerEvent);

  // Generate explanation
  if (config.claude.apiKey) {
    await explainer.generateExplanation(lead, scoreData);
  }

  logger.info(`Re-scored lead ${leadId}: ${scoreData.total_score} [${scoreData.tier}]`);
  return scoreData;
});

// Event handlers
scoringQueue.on('completed', (job, result) => {
  logger.info(`Scoring job ${job.id} completed`);
});

scoringQueue.on('failed', (job, err) => {
  logger.error(`Scoring job ${job.id} failed:`, err.message);
});

scoringQueue.on('error', (err) => {
  logger.debug(`Bull scoring queue connection notice: ${err.message}`);
});

module.exports = scoringQueue;
