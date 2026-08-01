const logger = require('../utils/logger');

/**
 * Fixed-window rate limiting, held in process memory.
 *
 * In-memory state is the right scope here: the app stores data in SQLite, which
 * is single-node anyway, so there is no second instance to share counters with.
 * Behind a load balancer or multiple workers this would need Redis instead.
 */
function rateLimit({ windowMs, max, name = 'api', message }) {
  const hits = new Map(); // key -> { count, resetAt }

  // Drop expired buckets so a long-running process cannot grow unbounded.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.max(windowMs, 60000));
  if (typeof sweeper.unref === 'function') sweeper.unref();

  return function rateLimitMiddleware(req, res, next) {
    // req.ip honours trust proxy; fall back to the socket for odd transports.
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count++;

    const remaining = Math.max(0, max - entry.count);
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', remaining);
    res.setHeader('RateLimit-Reset', Math.ceil((entry.resetAt - now) / 1000));

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      logger.warn(`Rate limit hit on ${name} by ${key} (${entry.count}/${max})`);
      return res.status(429).json({
        error: message || 'Too many requests. Please slow down.',
        retryAfterSeconds: retryAfter
      });
    }

    next();
  };
}

module.exports = { rateLimit };
