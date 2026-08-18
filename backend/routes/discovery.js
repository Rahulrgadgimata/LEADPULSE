const express = require('express');
const DiscoveryService = require('../services/discovery');
const { query } = require('../config/database');

const router = express.Router();

// Trigger discovery for an ICP.
//
// Always 202: a request that arrives while another run is in flight is queued
// rather than refused. The response says which it was, so the UI can show
// "starting" or "waiting behind another run" instead of an error the user can
// do nothing about.
router.post('/run/:icpId', async (req, res) => {
  try {
    // Only a deliberate press of Discover Leads supersedes a run in progress.
    // The dashboard also starts a run by itself after an ICP is saved, and that
    // must never kill a run the user is watching — it queues instead.
    const auto = String(req.query.auto || req.body?.auto || '') === 'true';
    const job = await DiscoveryService.run(req.params.icpId, auto ? 'auto' : 'manual');

    const startsInMin = Math.ceil((job.startsInMs || 0) / 60000);
    let message;
    if (job.state === 'running') {
      message = job.attached
        ? 'Attached to the discovery run already in progress'
        : 'Discovery job started';
    } else if (job.preempted) {
      // Not a queue wait: the run it replaced is unwinding, which takes seconds.
      message = 'Stopping the previous run and starting yours';
    } else {
      message = `Queued behind ${job.position} run${job.position === 1 ? '' : 's'} — starts in about ${startsInMin} min`;
    }

    res.status(202).json({ ...job, message });
  } catch (err) {
    if (err.code === 'DISCOVERY_QUEUE_FULL') {
      return res.status(429).json({ error: err.message });
    }
    // An unknown ICP is a bad request, not a server fault — surface it so the
    // UI can tell the user to pick a target instead of showing a failed job.
    const notFound = /not found|No active ICP/i.test(err.message);
    res.status(notFound ? 404 : 500).json({ error: err.message });
  }
});

// Scheduler state: what is running, what is waiting, how long the cooldown has
// left to run. The dashboard uses it to explain a queued run.
router.get('/queue', (req, res) => {
  res.json(DiscoveryService.schedulerStatus());
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
