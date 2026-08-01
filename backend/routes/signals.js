const express = require('express');
const Signal = require('../models/Signal');

const router = express.Router();

/**
 * Recent signals across all leads — the data behind the live discovery stream.
 * Optional ?icpId= scopes the feed to the active target ICP.
 */
router.get('/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const icpId = req.query.icpId && req.query.icpId !== 'default' ? req.query.icpId : null;
    const signals = await Signal.listRecent(limit, icpId);
    res.json({ signals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
