const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cron = require('node-cron');
const path = require('path');
const config = require('./config/env');
const logger = require('./utils/logger');
const { validateConfig } = require('./config/validate');

// Fail fast on bad production config before anything binds a port.
validateConfig();

// Database readiness, tracked rather than awaited before binding the port.
//
// An earlier version exited when the database was unreachable, on the reasoning
// that serving requests against a half-built schema is worse than not serving
// at all. That was wrong in one specific and costly way: the platform decides a
// service that never opens a port is a failed deploy, so a wrong connection
// string took the whole site down *and* made it impossible to deploy the fix.
// Binding the port keeps the UI up, keeps logs reachable, and lets a corrected
// DATABASE_URL recover the process without a rebuild.
const dbState = { ready: false, error: null, attempts: 0 };

function connectDatabase() {
  dbState.attempts++;
  return require('./config/database').init()
    .then(async () => {
      dbState.ready = true;
      dbState.error = null;
      // Discovery runs in-process, so any job that was executing when the
      // previous process exited is dead. Reconcile immediately rather than
      // leaving rows that report 'running' and block new runs.
      const swept = await require('./services/discovery').sweepStalledJobs(true);
      if (swept > 0) logger.warn(`Reconciled ${swept} discovery job(s) orphaned by a previous shutdown.`);
    })
    .catch(err => {
      dbState.ready = false;
      dbState.error = err.message;
      logger.error(`Database unavailable (attempt ${dbState.attempts}): ${err.message}`);
      // Keep trying: the usual cause is a connection string that is about to be
      // corrected, and recovering on its own beats needing a redeploy.
      const retry = setTimeout(connectDatabase, Math.min(30000 * dbState.attempts, 300000));
      if (typeof retry.unref === 'function') retry.unref();
    });
}

const databaseReady = connectDatabase();

// Route imports
const authRoutes = require('./routes/auth');
const discoveryRoutes = require('./routes/discovery');
const scoringRoutes = require('./routes/scoring');
const leadsRoutes = require('./routes/leads');
const icpRoutes = require('./routes/icp');
const signalsRoutes = require('./routes/signals');
const copilotRoutes = require('./routes/copilot');
const outreachRoutes = require('./routes/outreach');
const importRoutes = require('./routes/import');
const { optionalAuth } = require('./middleware/auth');
const { rateLimit } = require('./middleware/rateLimit');

const app = express();

// Behind a reverse proxy (nginx, Render, Railway…) the client IP arrives in
// X-Forwarded-For; without this, rate limiting would bucket every request under
// the proxy's own address.
if (config.TRUST_PROXY) app.set('trust proxy', 1);

// ─── Middleware ──────────────────────────────────────
// Origins allowed to call the API from a browser. Declared before helmet
// because the CSP's connectSrc reuses this list.
const corsOrigins = String(config.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// The allowlist must match what frontend/index.html actually loads. It
// previously permitted cdnjs.cloudflare.com while the page loaded Chart.js from
// jsdelivr, so the browser blocked it and every analytics chart failed silently.
// Chart.js is now served from /vendor, so no external script origin is needed.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https:'],
      // Allow XHR back to the API; extra origins only when the UI is hosted apart.
      connectSrc: ["'self'", ...corsOrigins.filter(o => o !== '*')],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      baseUri: ["'self'"]
    },
  }
}));
// CORS: same-origin only by default, since the backend also serves this UI.
// Set CORS_ORIGIN (comma-separated) when the UI is hosted elsewhere.
app.use(cors({
  origin: corsOrigins.length === 0
    ? false                                   // same-origin requests only
    : (corsOrigins.includes('*') ? true : corsOrigins),
  credentials: true
}));

// 10mb was sized for file uploads this API does not accept; a smaller cap
// limits how much a single request can make the process allocate.
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', {
  stream: { write: (message) => logger.info(message.trim()) },
}));

// ─── Serve Static Frontend ──────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));

// ─── Health Check ───────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'LeadPulse AI',
    version: '1.0.0',
    // Reported, not enforced: a failing database must not make the service
    // unroutable, or the fix cannot be deployed.
    database: dbState.ready ? 'connected' : 'unavailable',
    databaseError: dbState.error || undefined,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ─── API Routes ─────────────────────────────────────
// General read traffic: generous, just enough to stop a runaway client.
const generalLimiter = rateLimit({
  windowMs: 60000,
  max: config.RATE_LIMIT_PER_MINUTE,
  name: 'api'
});

// Discovery launches Chromium and spends Groq/Hunter/NewsAPI quota on every
// call, so it gets a far tighter budget than the read endpoints.
const discoveryLimiter = rateLimit({
  windowMs: 60000,
  max: config.DISCOVERY_RATE_LIMIT_PER_MINUTE,
  name: 'discovery',
  message: 'Discovery is rate limited because each run consumes scraping and AI quota. Wait a moment and retry.'
});

// Credential endpoints are the classic brute-force target.
const authLimiter = rateLimit({
  windowMs: 15 * 60000,
  max: 10,
  name: 'auth',
  message: 'Too many authentication attempts. Try again later.'
});

app.use('/api', generalLimiter);

// Anything that reads or writes data says so plainly while the database is
// unreachable, instead of failing request by request with a driver error.
app.use('/api', (req, res, next) => {
  if (dbState.ready) return next();
  if (req.path === '/status' || req.path === '' || req.path === '/') return next();
  res.status(503).json({
    error: 'The database is unreachable, so no data can be read or written right now.',
    detail: dbState.error,
    retrying: true
  });
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/discovery/run', discoveryLimiter);
app.use('/api/discovery', optionalAuth, discoveryRoutes);
app.use('/api/scoring', optionalAuth, scoringRoutes);
app.use('/api/leads', optionalAuth, leadsRoutes);
app.use('/api/icp', optionalAuth, icpRoutes);
app.use('/api/signals', optionalAuth, signalsRoutes);

// Spreadsheet import. Rate limited like discovery: each upload enriches every
// row, which spends the same page-fetch and AI budget a discovery run does.
app.use('/api/import', discoveryLimiter, optionalAuth, importRoutes);

// Each copilot message costs Groq quota, so it gets its own tighter budget.
app.use('/api/copilot', rateLimit({
  windowMs: 60000,
  max: config.COPILOT_RATE_LIMIT_PER_MINUTE,
  name: 'copilot',
  message: 'Too many copilot messages. Please wait a moment.'
}), optionalAuth, copilotRoutes);

// Outreach. Drafting spends AI quota and sending spends domain reputation, so
// those two paths get a tight budget of their own — mounted on the specific
// prefixes rather than on /api/outreach as a whole, because a recipient
// clicking an unsubscribe link must never be turned away by a rate limit.
const outreachWriteLimiter = rateLimit({
  windowMs: 60000,
  max: config.OUTREACH_RATE_LIMIT_PER_MINUTE,
  name: 'outreach',
  message: 'Too many outreach requests. Each draft costs AI quota and each send costs deliverability — wait a moment.'
});
app.use('/api/outreach/generate', outreachWriteLimiter);
app.use('/api/outreach/messages', outreachWriteLimiter);
app.use('/api/outreach', optionalAuth, outreachRoutes);

// ─── Provider status ────────────────────────────────
// Reports which integrations are configured so the UI can show real state
// instead of a hardcoded "active" badge. Booleans only — never key values.
app.get('/api/status', optionalAuth, (req, res) => {
  res.json({
    providers: {
      groq: { configured: Boolean(config.GROQ_API_KEY), purpose: `Lead conversion from scraped data (${config.GROQ_MODEL_EXTRACTION})` },
      groqChat: { configured: Boolean(config.GROQ_CHAT_API_KEY || config.GROQ_API_KEY), purpose: `Sales copilot chat (${config.GROQ_MODEL_CHAT})` },
      mistral: { configured: Boolean(config.MISTRAL_API_KEY), purpose: `Fallback for both AI purposes (${config.MISTRAL_MODEL_CHAT})` },
      newsapi: { configured: Boolean(config.NEWS_API_KEY), purpose: 'News signals' },
      hunter: { configured: Boolean(config.HUNTER_API_KEY), purpose: 'Contact email enrichment' },
      apollo: { configured: Boolean(config.APOLLO_API_KEY), purpose: 'Firmographic enrichment' },
      twitter: { configured: Boolean(config.TWITTER_BEARER_TOKEN), purpose: 'X/Twitter social signals' },
      firecrawl: {
        configured: Boolean(config.FIRECRAWL_API_KEY),
        purpose: 'Google-backed search + JavaScript page rendering (the only working Google route from this host)'
      },
      serper: { configured: Boolean(config.SERPER_API_KEY), purpose: 'Google results API' },
      reddit: { configured: Boolean(config.REDDIT_CLIENT_ID && config.REDDIT_CLIENT_SECRET), purpose: 'Reddit social signals' }
    },
    // Live provider/model/key wiring per purpose, including fallback tiers.
    ai: require('./services/groqClient').describe(),
    models: {
      extraction: config.GROQ_MODEL_EXTRACTION,
      chat: config.GROQ_MODEL_CHAT
    },
    discovery: {
      targetLeads: config.DISCOVERY_TARGET_LEADS,
      maxQueries: config.DISCOVERY_MAX_QUERIES,
      runBudgetMs: config.DISCOVERY_RUN_BUDGET_MS,
      // What the scheduler is doing right now, so a queued run is explainable.
      scheduler: require('./services/discovery').schedulerStatus()
    },
    // Providers parked because their quota or plan says calling them is
    // pointless. Empty is the healthy state.
    quotaBlocked: require('./services/providerHealth').snapshot(),
    // Phase 2. Which engine drafts messages and whether mail can actually
    // leave — the UI needs both to avoid offering a Send button that cannot
    // work. See /api/outreach/status for the full picture.
    outreach: {
      ai: require('./services/outreach/messageGenerator').describe(),
      smtp: require('./services/outreach/mailer').status(),
      scheduler: require('./services/outreach/scheduler').status()
    }
  });
});

// ─── API Documentation Endpoint ─────────────────────
app.get('/api', (req, res) => {
  res.json({
    name: 'LeadPulse AI API',
    version: '1.0.0',
    endpoints: {
      auth: {
        'POST /api/auth/register': 'Register a new user',
        'POST /api/auth/login': 'Login and get JWT token',
        'GET /api/auth/me': 'Get current user info',
      },
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
        'GET /api/leads': 'List leads (filter by tier, industry, geography, source, review status, date, score)',
        'GET /api/leads/stats': 'Get lead statistics',
        'GET /api/leads/filter-options': 'Distinct industries / sources / geographies for the filter sidebar',
        'GET /api/leads/export.csv': 'CSV export (accepted leads by default; any list filter applies)',
        'POST /api/leads': 'Add a lead manually',
        'POST /api/leads/bulk-review': 'Accept / reject / hold many leads at once',
        'GET /api/leads/:id': 'Get lead details, signals and outreach history',
        'PATCH /api/leads/:id/review': 'Accept / reject / hold one lead',
        'PATCH /api/leads/:id': 'Update a lead',
        'DELETE /api/leads/:id': 'Delete a lead',
      },
      outreach: {
        'GET /api/outreach/status': 'Which AI engine drafts, whether SMTP can send, scheduler state',
        'POST /api/outreach/generate/:leadId': 'Draft a message (mode=generate) or build the Gemini handoff prompt (mode=handoff)',
        'GET /api/outreach/prompt/:leadId': 'The generation prompt for a lead, without generating',
        'GET /api/outreach/messages': 'Sent log and draft queue (filter by status / lead / ICP)',
        'PUT /api/outreach/messages/:id': 'Edit a draft, or paste back what Gemini wrote',
        'POST /api/outreach/messages/:id/send': 'Send now',
        'POST /api/outreach/messages/:id/schedule': 'Send at a chosen time',
        'POST /api/outreach/messages/:id/cancel': 'Pull a scheduled message back to draft',
        'POST /api/outreach/messages/send-bulk': 'Send several drafts at once',
        'GET /api/outreach/templates': 'List saved templates',
        'POST /api/outreach/templates': 'Save a draft as a reusable template',
        'POST /api/outreach/templates/:id/apply/:leadId': 'Apply a template to a lead',
        'GET /api/outreach/suppressions': 'The do-not-contact list',
        'POST /api/outreach/replies/scan': 'Scan a reply for opt-out language and suppress the sender',
        'GET /api/outreach/unsubscribe/:token': 'Public one-click unsubscribe',
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
if (config.CRON_SCHEDULE) {
  const DiscoveryService = require('./services/discovery');
  const ICP = require('./models/ICP');

  cron.schedule(config.CRON_SCHEDULE, async () => {
    logger.info('Running scheduled discovery for all active ICPs...');
    try {
      const activeICPs = await ICP.listActive();
      for (const icp of activeICPs) {
        // Queued, not started: the scheduler runs them one at a time with the
        // cooldown in between, so a nightly sweep over many ICPs no longer
        // launches every run at once and has them throttle each other out.
        const job = await DiscoveryService.run(icp.id, 'scheduled');
        logger.info(`Scheduled discovery ${job.state} for ICP: ${icp.name} (job ${job.jobId})`);
      }
    } catch (err) {
      logger.error('Scheduled discovery failed:', err.message);
    }
  });

  logger.info(`Discovery cron scheduled: ${config.CRON_SCHEDULE}`);
}

// ─── 404 Handler for API ────────────────────────────
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API Endpoint not found' });
});

// ─── Fallback for SPA/UI routing ────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─── Error Handler ──────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
  });
});

// ─── Start Server ───────────────────────────────────
const PORT = config.PORT;
// Bind the port only once the schema exists. Serving requests against a
// half-built database would fail them one by one with confusing errors; a
// database that cannot be reached at all should stop the boot outright, so the
// platform restarts us rather than running a broken instance.
// Bound immediately; the database connects (and reconnects) alongside.
{
  app.listen(PORT, () => {
    logger.info(`═══════════════════════════════════════════════`);
    logger.info(`  LeadPulse AI Server running on port ${PORT}`);
    logger.info(`  UI: http://localhost:${PORT}`);
    logger.info(`  API: http://localhost:${PORT}/api`);
    logger.info(`═══════════════════════════════════════════════`);

    databaseReady.then(() => {
      if (dbState.ready) logger.info('Database connected.');
      else logger.warn('Serving without a database until the connection recovers.');
    });

    // Scheduled sends are polled from the database rather than held in memory,
    // so messages that came due while the process was down still go out — the
    // first tick runs immediately on boot for exactly that case.
    require('./services/outreach/scheduler').start();

    // Warm the Scrapling sidecar so the first discovery run is not cold-starting
    // Python + curl_cffi mid-search.
    if (config.SCRAPLING_ENABLED) {
      require('./services/scraplingClient').ensureStarted().then(ok => {
        if (ok) logger.info('Scrapling scrape engine ready.');
        else logger.warn('Scrapling unavailable — Node scrapers will run without it.');
      }).catch(err => logger.warn(`Scrapling boot: ${err.message}`));
    }
  });
}

module.exports = app;
