const express = require('express');
const router = express.Router();
const Lead = require('../models/Lead');
const Signal = require('../models/Signal');
const ScoreHistory = require('../models/ScoreHistory');
const { PAGINATION } = require('../utils/constants');
const logger = require('../utils/logger');

/**
 * GET /api/leads
 * List leads with filters, sorting, and pagination
 */
router.get('/', async (req, res) => {
  try {
    const {
      icpId, source, status, tier, search,
      sortBy = 'discovery_timestamp',
      sortOrder = 'DESC',
      page = PAGINATION.DEFAULT_PAGE,
      limit = PAGINATION.DEFAULT_LIMIT,
    } = req.query;

    const result = await Lead.list({
      icpId, source, status, tier, search,
      sortBy, sortOrder,
      page: parseInt(page, 10),
      limit: Math.min(parseInt(limit, 10), PAGINATION.MAX_LIMIT),
    });

    res.json(result);
  } catch (err) {
    logger.error('Failed to list leads:', err.message);
    res.status(500).json({ error: 'Failed to list leads' });
  }
});

/**
 * GET /api/leads/stats
 * Get lead statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const { icpId } = req.query;

    const tierCounts = await Lead.countByTier(icpId);
    const sourceCounts = await Lead.countBySource(icpId);

    const totalLeads = Object.values(tierCounts).reduce((a, b) => a + b, 0);

    res.json({
      total: totalLeads,
      byTier: tierCounts,
      bySource: sourceCounts,
    });
  } catch (err) {
    logger.error('Failed to get lead stats:', err.message);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/**
 * GET /api/leads/:id
 * Get a single lead with full details
 */
router.get('/:id', async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    // Get signals and score history
    const [signals, scoreHistory] = await Promise.all([
      Signal.getByLead(lead.id),
      ScoreHistory.getByLead(lead.id, 30),
    ]);

    res.json({
      ...lead,
      signals,
      scoreHistory,
    });
  } catch (err) {
    logger.error('Failed to get lead:', err.message);
    res.status(500).json({ error: 'Failed to get lead' });
  }
});

/**
 * PATCH /api/leads/:id
 * Update a lead
 */
router.patch('/:id', async (req, res) => {
  try {
    const updated = await Lead.update(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json(updated);
  } catch (err) {
    logger.error('Failed to update lead:', err.message);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

/**
 * DELETE /api/leads/:id
 * Delete a lead
 */
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Lead.delete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json({ message: 'Lead deleted successfully' });
  } catch (err) {
    logger.error('Failed to delete lead:', err.message);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
});

module.exports = router;
