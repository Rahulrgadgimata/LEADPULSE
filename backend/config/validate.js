const config = require('./env');
const logger = require('../utils/logger');

const INSECURE_JWT_DEFAULT = 'supersecretjwt';

/**
 * Validate configuration at boot.
 *
 * In production a bad config should stop the process rather than surface later
 * as a silent capability gap (a collector quietly returning nothing) or, worse,
 * a forgeable auth token. In development the same problems are warnings so the
 * app stays easy to run.
 */
function validateConfig({ exitOnError = true } = {}) {
  const isProduction = process.env.NODE_ENV === 'production';
  const errors = [];
  const warnings = [];

  // ── Secrets that must never keep their default in production ──────────────
  if (!process.env.JWT_SECRET || config.JWT_SECRET === INSECURE_JWT_DEFAULT) {
    const message =
      'JWT_SECRET is unset or still the built-in default. Anyone can forge auth ' +
      'tokens. Set a long random value: openssl rand -base64 48';
    if (isProduction) errors.push(message);
    else warnings.push(message);
  } else if (config.JWT_SECRET.length < 32) {
    warnings.push(`JWT_SECRET is only ${config.JWT_SECRET.length} characters; use at least 32.`);
  }

  // ── Provider keys: each missing key silently disables a capability ─────────
  const providers = [
    ['GROQ_API_KEY', 'AI lead qualification and score explanations'],
    ['NEWS_API_KEY', 'news signal collection'],
    ['HUNTER_API_KEY', 'contact email enrichment'],
    ['APOLLO_API_KEY', 'firmographic enrichment'],
    ['TWITTER_BEARER_TOKEN', 'X/Twitter social signals'],
  ];
  for (const [key, capability] of providers) {
    if (!config[key]) warnings.push(`${key} not set — ${capability} is disabled.`);
  }

  if (config.GROQ_API_KEY && !/^gsk_/.test(config.GROQ_API_KEY)) {
    warnings.push('GROQ_API_KEY does not start with "gsk_"; it will be rejected by Groq.');
  }

  // ── Numeric sanity: a zero or negative limit would stall or flood ─────────
  const positives = [
    'DISCOVERY_TARGET_LEADS', 'DISCOVERY_MAX_QUERIES', 'SCRAPER_CONCURRENCY',
    'ENRICHMENT_CONCURRENCY', 'GROQ_BATCH_SIZE', 'GROQ_CONCURRENCY',
    'GROQ_TPM_LIMIT', 'GROQ_RPM_LIMIT', 'SCRAPER_DELAY_MS', 'PORT',
  ];
  for (const key of positives) {
    const value = Number(config[key]);
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`${key} must be a positive number (got "${config[key]}").`);
    }
  }

  if (isProduction && config.CORS_ORIGIN === '*') {
    warnings.push(
      'CORS_ORIGIN is "*" — any website can call this API from a browser. ' +
      'Set it to your UI origin, or leave it unset for same-origin only.'
    );
  }

  warnings.forEach(w => logger.warn(`[config] ${w}`));

  if (errors.length > 0) {
    errors.forEach(e => logger.error(`[config] ${e}`));
    if (exitOnError && isProduction) {
      logger.error('[config] Refusing to start with invalid production configuration.');
      process.exit(1);
    }
  }

  logger.info(
    `[config] Environment: ${process.env.NODE_ENV || 'development'} — ` +
    `${errors.length} error(s), ${warnings.length} warning(s)`
  );

  return { errors, warnings };
}

module.exports = { validateConfig };
