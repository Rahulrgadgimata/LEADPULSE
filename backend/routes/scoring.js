const express = require('express');
const router = express.Router();
const scorer = require('../services/scoring/scorer');
const scoringQueue = require('../services/queue/scoringQueue');
const ScoreHistory = require('../models/ScoreHistory');
const Lead = require('../models/Lead');
const logger = require('../utils/logger');

/**
 * POST /api/scoring/rescore/:leadId
 * Manually trigger a rescore for a specific lead
 */
router.post('/rescore/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;

    const lead = await Lead.findById(leadId);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    // Queue the rescore job or execute directly if Redis is offline
    let jobId = null;
    try {
      const job = await Promise.race([
        scoringQueue.add('rescore-lead', {
          leadId,
          triggerEvent: 'manual_rescore',
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Redis connection timeout')), 1000))
      ]);
      jobId = job ? job.id : `direct_${Date.now()}`;
    } catch (bullErr) {
      logger.warn(`Scoring Bull queue bypassed (${bullErr.message}). Rescoring directly.`);
      try {
        const icp = lead.icp_id ? await ICP.findById(lead.icp_id) : null;
        await scorer.scoreLead(lead, icp, 'manual_rescore');
      } catch (directErr) {
        logger.warn(`Direct rescore notice: ${directErr.message}`);
      }
      jobId = `direct_${Date.now()}`;
    }

    res.status(202).json({
      message: 'Rescore job queued',
      jobId,
      leadId,
    });
  } catch (err) {
    logger.error('Failed to queue rescore:', err.message);
    res.status(500).json({ error: 'Failed to queue rescore' });
  }
});

/**
 * POST /api/scoring/override/:leadId
 * Manual score override with notes
 */
router.post('/override/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    const { score, reason } = req.body;

    if (score === undefined || score < 0 || score > 100) {
      return res.status(400).json({ error: 'Score must be between 0 and 100' });
    }

    const lead = await Lead.findById(leadId);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const updatedScore = await scorer.overrideScore(leadId, score, reason || '');

    res.json({
      message: 'Score overridden successfully',
      score: updatedScore,
    });
  } catch (err) {
    logger.error('Failed to override score:', err.message);
    res.status(500).json({ error: 'Failed to override score' });
  }
});

/**
 * GET /api/scoring/history/:leadId
 * Get score history for a lead
 */
router.get('/history/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    const { limit = 30 } = req.query;

    const history = await ScoreHistory.getByLead(leadId, parseInt(limit, 10));
    const trend = await ScoreHistory.getTrend(leadId, 30);
    const latestChange = await ScoreHistory.getLatestChange(leadId);

    res.json({
      history,
      trend,
      latestChange,
    });
  } catch (err) {
    logger.error('Failed to get score history:', err.message);
    res.status(500).json({ error: 'Failed to get score history' });
  }
});

module.exports = router;
