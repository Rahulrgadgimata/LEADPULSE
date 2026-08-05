// backend/services/outreach/scheduler.js
const config = require('../../config/env');
const logger = require('../../utils/logger');
const Message = require('../../models/Message');
const mailer = require('./mailer');

/**
 * Sends scheduled messages once their time arrives.
 *
 * A poll rather than a per-message timer: timers do not survive a restart, and
 * "the server was redeployed at 8:59" is not a reason for a 9:00 send to
 * silently never happen. Polling the table means the queue is the source of
 * truth and a restart costs at most one interval.
 */

let timer = null;
let running = false;
let lastTickAt = null;
let lastError = null;

/**
 * Send everything that has come due.
 *
 * Overlapping ticks are skipped rather than queued. A slow SMTP relay can make
 * a batch outlast the interval, and letting a second tick start would hand the
 * same rows to two senders — the row claim in Message would catch it, but not
 * starting the race is simpler than winning it.
 */
async function tick() {
  if (running) return { skipped: true };
  running = true;
  lastTickAt = new Date().toISOString();

  let sent = 0;
  let failed = 0;

  try {
    const due = await Message.listDue(new Date().toISOString(), 25);
    if (due.length === 0) return { sent: 0, failed: 0, due: 0 };

    logger.info(`[outreach-scheduler] ${due.length} scheduled message(s) due`);

    for (const message of due) {
      try {
        const result = await mailer.sendMessage(message.id);
        if (result.ok) sent += 1;
        else {
          failed += 1;
          logger.warn(`[outreach-scheduler] ${message.id} not sent: ${result.reason}`);
        }
      } catch (err) {
        // One bad row must not stop the rest of the batch.
        failed += 1;
        logger.warn(`[outreach-scheduler] ${message.id} threw: ${err.message}`);
        await Message.update(message.id, { status: 'failed', error_message: err.message }).catch(() => {});
      }
    }

    lastError = null;
    return { sent, failed, due: due.length };
  } catch (err) {
    lastError = err.message;
    logger.error(`[outreach-scheduler] tick failed: ${err.message}`);
    return { sent, failed, error: err.message };
  } finally {
    running = false;
  }
}

function start() {
  if (!config.OUTREACH_SCHEDULER_ENABLED) {
    logger.info('[outreach-scheduler] disabled (OUTREACH_SCHEDULER_ENABLED=false) — scheduled messages will not send.');
    return;
  }
  if (timer) return;

  const interval = Math.max(config.OUTREACH_SCHEDULER_INTERVAL_MS, 5000);
  timer = setInterval(() => { tick(); }, interval);
  // Do not hold the process open on this alone; a poller should not be the
  // reason a shutdown hangs.
  if (typeof timer.unref === 'function') timer.unref();

  logger.info(`[outreach-scheduler] polling every ${Math.round(interval / 1000)}s for scheduled sends`);

  // A restart may have left messages that came due while the process was down.
  tick();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function status() {
  return {
    enabled: config.OUTREACH_SCHEDULER_ENABLED,
    running: Boolean(timer),
    intervalMs: config.OUTREACH_SCHEDULER_INTERVAL_MS,
    lastTickAt,
    lastError,
  };
}

module.exports = { start, stop, tick, status };
