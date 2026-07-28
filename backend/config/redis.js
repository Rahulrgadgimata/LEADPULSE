const Redis = require('ioredis');
const config = require('./env');
const logger = require('../utils/logger');

let redis = null;

const getRedis = () => {
  if (!redis) {
    redis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      enableReadyCheck: false,
      retryStrategy(times) {
        if (times > 3) return null; // stop retrying if offline
        const delay = Math.min(times * 200, 1000);
        logger.debug(`Redis reconnecting... attempt ${times}`);
        return delay;
      },
    });

    redis.on('connect', () => {
      logger.info('Redis connected');
    });

    redis.on('error', (err) => {
      logger.error('Redis error:', err.message);
    });
  }
  return redis;
};

module.exports = { getRedis };
