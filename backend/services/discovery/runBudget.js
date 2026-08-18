const logger = require('../../utils/logger');
const config = require('../../config/env');

/**
 * The wall-clock budget for one discovery run.
 *
 * Volume used to be limited by hard caps (10 leads, 6 queries) because nothing
 * else stopped a run from spending an afternoon walking search engines. Capping
 * the counts meant most sources were cut off before they contributed anything;
 * capping the clock instead lets every source run properly and simply ends the
 * collection phase when the time is up.
 *
 * Two deadlines, because they protect different things:
 *
 *   collect — when collectors stop issuing new queries. Reaching it is normal:
 *             the run continues with whatever was found.
 *   hard    — when the whole run must be finished, including enrichment. Search
 *             refuses to run at all past this point, so a slow provider cannot
 *             drag a job past the stale-job threshold and get it killed.
 *
 * Single-run state is safe because the scheduler executes one run at a time.
 */

let startedAt = 0;
let hardDeadline = 0;
let collectDeadline = 0;
let collectWindowMs = 0;
let warnedCollect = false;
let warnedHard = false;

function start(totalMs = config.DISCOVERY_RUN_BUDGET_MS) {
  const ratio = Math.min(Math.max(config.DISCOVERY_COLLECT_BUDGET_RATIO, 0.2), 0.9);
  startedAt = Date.now();
  hardDeadline = startedAt + totalMs;
  collectWindowMs = Math.round(totalMs * ratio);
  collectDeadline = startedAt + collectWindowMs;
  warnedCollect = false;
  warnedHard = false;
  logger.info(
    `Discovery budget: ${Math.round(totalMs / 1000)}s total, ` +
    `${Math.round((totalMs * ratio) / 1000)}s for collection.`
  );
}

function clear() {
  hardDeadline = 0;
  collectDeadline = 0;
}

/**
 * True once collectors should stop starting new work.
 *
 * `share` reserves the tail of the collection window for the phases that run
 * last. LinkedIn company and buyer discovery run after web/news/jobs (they
 * depend on the same search engines and cannot run in parallel with them
 * without tripping rate limits), so without a reserved slice they were reliably
 * cut off having issued zero queries — both sources reported nothing on every
 * run. Passing share=0.65 to the earlier phases leaves them the final third.
 */
function collectExpired(share = 1) {
  if (!collectDeadline) return false;

  const limit = share >= 1
    ? collectDeadline
    : startedAt + Math.round(collectWindowMs * share);

  const over = Date.now() >= limit;
  if (over && share >= 1 && !warnedCollect) {
    warnedCollect = true;
    logger.warn('Discovery collection budget reached; finishing with the prospects gathered so far.');
  }
  return over;
}

/** Share of the collection window reserved for the first, parallel phase. */
const PRIMARY_SHARE = 0.65;

/** True once even enrichment-time lookups must stop. */
function expired() {
  if (!hardDeadline) return false;
  const over = Date.now() >= hardDeadline;
  if (over && !warnedHard) {
    warnedHard = true;
    logger.warn('Discovery run budget reached; skipping remaining network lookups.');
  }
  return over;
}

function collectRemainingMs() {
  return collectDeadline ? Math.max(0, collectDeadline - Date.now()) : Infinity;
}

function remainingMs() {
  return hardDeadline ? Math.max(0, hardDeadline - Date.now()) : Infinity;
}

module.exports = {
  start, clear, collectExpired, expired, collectRemainingMs, remainingMs, PRIMARY_SHARE
};
