const express = require('express');
const ICP = require('../models/ICP');

const router = express.Router();

// GET all ICPs for current user
router.get('/', async (req, res) => {
  try {
    const icps = await ICP.listAll();
    res.json(icps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single ICP
router.get('/:id', async (req, res) => {
  try {
    const icp = await ICP.getById(req.params.id);
    if (!icp) return res.status(404).json({ error: 'ICP not found' });
    res.json(icp);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST new ICP
router.post('/', async (req, res) => {
  try {
    const icpData = { ...req.body, user_id: req.user ? req.user.id : null };
    const icp = await ICP.create(icpData);
    res.status(201).json(icp);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update ICP
router.put('/:id', async (req, res) => {
  try {
    const icp = await ICP.update(req.params.id, req.body);
    if (!icp) return res.status(404).json({ error: 'ICP not found' });
    res.json(icp);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE ICP
router.delete('/:id', async (req, res) => {
  try {
    const success = await ICP.delete(req.params.id);
    if (!success) return res.status(404).json({ error: 'ICP not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
