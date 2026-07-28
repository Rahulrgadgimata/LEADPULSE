const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cron = require('node-cron');
const config = require('./config/env');
const logger = require('./utils/logger');

// Route imports
const discoveryRoutes = require('./routes/discovery');
const scoringRoutes = require('./routes/scoring');
const leadsRoutes = require('./routes/leads');
const icpRoutes = require('./routes/icp');
const { optionalAuth } = require('./middleware/auth');

const app = express();

// ─── Middleware ──────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', {
  stream: { write: (message) => logger.info(message.trim()) },
}));

// ─── Health Check ───────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'LeadPulse AI',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ─── API Routes ─────────────────────────────────────
app.use('/api/discovery', optionalAuth, discoveryRoutes);
app.use('/api/scoring', optionalAuth, scoringRoutes);
app.use('/api/leads', optionalAuth, leadsRoutes);
app.use('/api/icp', optionalAuth, icpRoutes);

// ─── API Documentation Endpoint ─────────────────────
app.get('/api', (req, res) => {
  res.json({
    name: 'LeadPulse AI API',
    version: '1.0.0',
    endpoints: {
      discovery: {
        'POST /api/discovery/run/:icpId': 'Trigger discovery for an ICP',
        'GET /api/discovery/status/:jobId': 'Check discovery job status',
        'GET /api/discovery/jobs': 'List recent discovery jobs',
      },
      scoring: {
        'POST /api/scoring/rescore/:leadId': 'Manually trigger rescore',
        'POST /api/scoring/override/:leadId': 'Override a lead score',
        'GET /api/scoring/history/:leadId': 'Get score history',
      },
      leads: {
        'GET /api/leads': 'List leads (with filters)',
        'GET /api/leads/stats': 'Get lead statistics',
        'GET /api/leads/:id': 'Get lead details',
        'PATCH /api/leads/:id': 'Update a lead',
        'DELETE /api/leads/:id': 'Delete a lead',
      },
      icp: {
        'POST /api/icp': 'Create an ICP',
        'GET /api/icp': 'List ICPs',
        'GET /api/icp/:id': 'Get ICP details',
        'PUT /api/icp/:id': 'Update an ICP',
        'DELETE /api/icp/:id': 'Delete an ICP',
      },
    },
  });
});

// ─── Scheduled Discovery (Cron) ─────────────────────
if (config.nodeEnv !== 'test') {
  const discoveryQueue = require('./services/queue/discoveryQueue');
  const ICP = require('./models/ICP');

  cron.schedule(config.discovery.cron, async () => {
    logger.info('Running scheduled discovery for all active ICPs...');
    try {
      const activeICPs = await ICP.listActive();
      for (const icp of activeICPs) {
        await discoveryQueue.add('run-discovery', {
          icpId: icp.id,
          triggerType: 'scheduled',
        });
        logger.info(`Queued scheduled discovery for ICP: ${icp.name}`);
      }
    } catch (err) {
      logger.error('Scheduled discovery failed:', err.message);
    }
  });

  logger.info(`Discovery cron scheduled: ${config.discovery.cron}`);
}

// ─── 404 Handler ────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ─── Error Handler ──────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: config.nodeEnv === 'development' ? err.message : 'Internal server error',
  });
});

// ─── Start Server ───────────────────────────────────
const PORT = config.port;
app.listen(PORT, () => {
  logger.info(`═══════════════════════════════════════════════`);
  logger.info(`  LeadPulse AI Server running on port ${PORT}`);
  logger.info(`  Environment: ${config.nodeEnv}`);
  logger.info(`  API docs: http://localhost:${PORT}/api`);
  logger.info(`═══════════════════════════════════════════════`);
});

module.exports = app;
