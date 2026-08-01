const express = require('express');
const ScoringService = require('../services/scoring');
const { query } = require('../config/database');

const router = express.Router();

// Manually trigger rescore
router.post('/rescore/:leadId', async (req, res) => {
  try {
    const result = await ScoringService.compute(req.params.leadId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Override score
router.post('/override/:leadId', async (req, res) => {
  try {
    const { newScore, reason } = req.body;
    if (newScore == null) return res.status(400).json({ error: 'newScore required' });

    await ScoringService.manualOverride(req.params.leadId, parseInt(newScore), reason || 'Manual adjustment');
    res.json({ success: true, newScore });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get score history for a lead
router.get('/history/:leadId', async (req, res) => {
  try {
    const result = query('SELECT * FROM score_history WHERE lead_id = ? ORDER BY recorded_at ASC', [req.params.leadId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
