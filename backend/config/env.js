require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  db: {
    connectionString: process.env.DATABASE_URL,
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    name: process.env.DB_NAME || 'leadpulse',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
  },

  redis: {
    url: process.env.REDIS_URL,
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  groq: {
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  },

  claude: {
    apiKey: process.env.CLAUDE_API_KEY,
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
  },

  apollo: {
    apiKey: process.env.APOLLO_API_KEY,
  },

  hunter: {
    apiKey: process.env.HUNTER_API_KEY,
  },

  scraping: {
    rateLimitMs: parseInt(process.env.SCRAPE_RATE_LIMIT_MS, 10) || 2000,
    maxConcurrent: parseInt(process.env.SCRAPE_MAX_CONCURRENT, 10) || 3,
    userAgent: process.env.SCRAPE_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  },

  discovery: {
    cron: process.env.DISCOVERY_CRON || '0 6 * * *',
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
};
