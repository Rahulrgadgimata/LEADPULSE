const logger = require('../utils/logger');

/**
 * Which third-party APIs are worth calling right now.
 *
 * Every paid provider in this app is on a free plan with a hard ceiling, and
 * three of them are currently past it: Hunter's 50 monthly searches are spent,
 * Apollo's free plan excludes the enrichment endpoints outright, and the X
 * bearer token reports "credits depleted". Left unchecked each of those still
 * cost a full HTTP round trip *per lead* — a 40-lead run spent minutes waiting
 * on calls that could only fail, which is a large part of why discovery felt
 * broken rather than merely limited.
 *
 * A provider is parked here the moment its response says the quota is gone, and
 * the reason is logged once instead of once per lead. Nothing is parked on a
 * transient error: a timeout or a 500 is retried as before.
 */

const providers = new Map(); // name -> { until, reason, permanent, logged }

// Quota resets are monthly or account-level, so a park lasts until the process
// restarts unless the provider told us exactly when it recovers.
const FOREVER = Number.MAX_SAFE_INTEGER;

function entry(name) {
  if (!providers.has(name)) providers.set(name, null);
  return providers.get(name);
}

/**
 * @param {string} name       provider label, e.g. 'hunter'
 * @param {string} reason     human-readable, shown once in the log and in /api/status
 * @param {number} [untilMs]  epoch ms when it may be retried; omit for "not this process"
 */
function disable(name, reason, untilMs) {
  const existing = entry(name);
  const until = untilMs || FOREVER;

  // Keep the longest park: a monthly quota wall must not be shortened by a
  // later 429 that only reported a 60-second retry-after.
  if (existing && existing.until >= until) return;

  providers.set(name, { until, reason, logged: false });
  const when = until === FOREVER
    ? 'for the rest of this process'
    : `until ${new Date(until).toISOString()}`;
  logger.warn(`[quota] ${name} disabled ${when}: ${reason}`);
}

/** True when calls to this provider should be skipped entirely. */
function isDisabled(name) {
  const state = entry(name);
  if (!state) return false;
  if (Date.now() >= state.until) {
    providers.set(name, null);
    logger.info(`[quota] ${name} cooldown expired; retrying it.`);
    return false;
  }
  return true;
}

/** Why a provider is parked, or null. */
function reasonFor(name) {
  const state = entry(name);
  return state && Date.now() < state.until ? state.reason : null;
}

/**
 * Classify a failed provider call and park the provider when the failure is a
 * quota or permission wall rather than a blip.
 *
 * Returns true when the provider was parked, so callers can stop retrying.
 */
function noteFailure(name, err, { quotaPatterns = [] } = {}) {
  const status = err?.response?.status;
  const body = JSON.stringify(err?.response?.data || '').toLowerCase();
  const message = String(err?.message || '').toLowerCase();

  // Payment / permission / plan walls never clear on retry.
  if (status === 401 || status === 402 || status === 403) {
    disable(name, `HTTP ${status} — ${describe(err)}`);
    return true;
  }

  if (status === 429) {
    const quotaExhausted =
      /limit for the number|billing period|quota|monthly|credits/.test(body) ||
      quotaPatterns.some(pattern => pattern.test(body) || pattern.test(message));

    if (quotaExhausted) {
      // A plan-period quota is gone until the reset date, not for 60 seconds.
      disable(name, `plan quota exhausted — ${describe(err)}`);
      return true;
    }

    // An ordinary burst limit: rest briefly and carry on.
    const retryAfter = Number(err?.response?.headers?.['retry-after']);
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 300000)
      : 60000;
    disable(name, `rate limited — ${describe(err)}`, Date.now() + waitMs);
    return true;
  }

  return false;
}

function describe(err) {
  const data = err?.response?.data;
  return String(
    data?.error?.message ||
    data?.error ||
    data?.detail ||
    data?.errors?.[0]?.details ||
    err?.message ||
    'no detail'
  ).slice(0, 200);
}

/** Snapshot for /api/status, so the UI can show why a source is quiet. */
function snapshot() {
  const out = {};
  for (const [name, state] of providers) {
    if (!state || Date.now() >= state.until) continue;
    out[name] = {
      reason: state.reason,
      until: state.until === FOREVER ? 'process restart' : new Date(state.until).toISOString()
    };
  }
  return out;
}

module.exports = { disable, isDisabled, reasonFor, noteFailure, snapshot };
