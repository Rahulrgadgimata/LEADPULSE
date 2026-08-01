const express = require('express');
const Lead = require('../models/Lead');
const Signal = require('../models/Signal');
const { query } = require('../config/database');

const router = express.Router();

// List all leads with optional icpId filter and pagination
router.get('/', async (req, res) => {
  try {
    const { icpId, limit = 100, offset = 0 } = req.query;

    let leads;
    if (icpId) {
      leads = await Lead.listByIcp(icpId, parseInt(limit), parseInt(offset));
    } else {
      // Same projection as listByIcp so the UI gets identical fields either way.
      const result = query(
        `SELECT l.*, s.total_score, s.tier, s.explanation_text,
                s.intent_score, s.profile_fit_score, s.company_fit_score,
                s.recency_score, s.engagement_score
         FROM leads l
         LEFT JOIN lead_scores s ON l.id = s.lead_id
         ORDER BY l.discovery_timestamp DESC LIMIT ? OFFSET ?`,
        [parseInt(limit), parseInt(offset)]
      );
      leads = result.rows;
    }
    res.json({ leads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get lead statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await Lead.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get lead detail (including signals and score history)
router.get('/:id', async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const scoreResult = query('SELECT * FROM lead_scores WHERE lead_id = ?', [lead.id]);
    const score = scoreResult.rows[0];

    const historyResult = query('SELECT * FROM score_history WHERE lead_id = ? ORDER BY recorded_at ASC', [lead.id]);
    const history = historyResult.rows;

    const signals = await Signal.listByLead(lead.id);

    res.json({ lead, score, history, signals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a lead
router.patch('/:id', async (req, res) => {
  try {
    const lead = await Lead.update(req.params.id, req.body);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a lead
router.delete('/:id', async (req, res) => {
  try {
    const success = await Lead.delete(req.params.id);
    if (!success) return res.status(404).json({ error: 'Lead not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
