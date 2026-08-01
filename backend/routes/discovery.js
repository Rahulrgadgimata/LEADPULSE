const express = require('express');
const DiscoveryService = require('../services/discovery');
const { query } = require('../config/database');

const router = express.Router();

// Trigger discovery for an ICP
router.post('/run/:icpId', async (req, res) => {
  try {
    const jobId = await DiscoveryService.run(req.params.icpId, 'manual');
    res.status(202).json({ jobId, message: 'Discovery job started' });
  } catch (err) {
    // A run already in flight is a conflict, not a failure — return the
    // existing job so the UI can attach to it instead of starting a duplicate.
    if (err.code === 'DISCOVERY_ALREADY_RUNNING') {
      return res.status(409).json({ error: err.message, jobId: err.jobId });
    }
    // An unknown ICP is a bad request, not a server fault — surface it so the
    // UI can tell the user to pick a target instead of showing a failed job.
    const notFound = /not found|No active ICP/i.test(err.message);
    res.status(notFound ? 404 : 500).json({ error: err.message });
  }
});

// Check job status
router.get('/status/:jobId', async (req, res) => {
  try {
    const job = await DiscoveryService.getJobStatus(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List recent jobs
router.get('/jobs', async (req, res) => {
  try {
    // Reconcile first: a run killed by a restart leaves status='running' in the
    // table, which would otherwise be listed as if it were still working.
    DiscoveryService.sweepStalledJobs();
    const jobs = query('SELECT * FROM discovery_jobs ORDER BY started_at DESC LIMIT 50');
    res.json(jobs.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
