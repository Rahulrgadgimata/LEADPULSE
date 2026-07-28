const express = require('express');
const router = express.Router();
const ICP = require('../models/ICP');
const logger = require('../utils/logger');

/**
 * POST /api/icp
 * Create a new ICP
 */
router.post('/', async (req, res) => {
  try {
    const {
      name, description, industries, company_size_min,
      company_size_max, geographies, job_titles, keywords,
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'ICP name is required' });
    }

    const icp = await ICP.create({
      user_id: req.user?.id || '00000000-0000-0000-0000-000000000000',
      name, description, industries, company_size_min,
      company_size_max, geographies, job_titles, keywords,
    });

    res.status(201).json(icp);
  } catch (err) {
    logger.error('Failed to create ICP:', err.message);
    res.status(500).json({ error: 'Failed to create ICP' });
  }
});

/**
 * GET /api/icp
 * List all ICPs
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';
    const icps = await ICP.listByUser(userId);
    res.json({ icps });
  } catch (err) {
    logger.error('Failed to list ICPs:', err.message);
    res.status(500).json({ error: 'Failed to list ICPs' });
  }
});

/**
 * GET /api/icp/:id
 * Get a single ICP
 */
router.get('/:id', async (req, res) => {
  try {
    const icp = await ICP.findById(req.params.id);
    if (!icp) {
      return res.status(404).json({ error: 'ICP not found' });
    }
    res.json(icp);
  } catch (err) {
    logger.error('Failed to get ICP:', err.message);
    res.status(500).json({ error: 'Failed to get ICP' });
  }
});

/**
 * PUT /api/icp/:id
 * Update an ICP
 */
router.put('/:id', async (req, res) => {
  try {
    const updated = await ICP.update(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ error: 'ICP not found' });
    }
    res.json(updated);
  } catch (err) {
    logger.error('Failed to update ICP:', err.message);
    res.status(500).json({ error: 'Failed to update ICP' });
  }
});

/**
 * DELETE /api/icp/:id
 * Delete an ICP
 */
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await ICP.delete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'ICP not found' });
    }
    res.json({ message: 'ICP deleted successfully' });
  } catch (err) {
    logger.error('Failed to delete ICP:', err.message);
    res.status(500).json({ error: 'Failed to delete ICP' });
  }
});

module.exports = router;
