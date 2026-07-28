module.exports = {
  // Lead sources
  SOURCES: {
    WEB_SCRAPE: 'web_scrape',
    NEWS: 'news',
    JOB_BOARD: 'job_board',
    SOCIAL: 'social',
    ENRICHMENT: 'enrichment',
  },

  // Signal types
  SIGNAL_TYPES: {
    NEWS_MENTION: 'news_mention',
    JOB_POSTING: 'job_posting',
    SOCIAL_POST: 'social_post',
    WEB_MENTION: 'web_mention',
    FUNDING: 'funding',
  },

  // Lead statuses
  LEAD_STATUS: {
    NEW: 'new',
    SCORED: 'scored',
    REVIEWED: 'reviewed',
    ACCEPTED: 'accepted',
    REJECTED: 'rejected',
  },

  // Score tiers
  TIERS: {
    HOT: 'hot',
    WARM: 'warm',
    COLD: 'cold',
  },

  // Score tier thresholds
  TIER_THRESHOLDS: {
    HOT_MIN: 70,
    WARM_MIN: 40,
  },

  // Scoring weights (must sum to 1.0)
  SCORING_WEIGHTS: {
    INTENT: 0.30,
    PROFILE_FIT: 0.25,
    COMPANY_FIT: 0.20,
    RECENCY: 0.15,
    ENGAGEMENT: 0.10,
  },

  // Discovery job statuses
  JOB_STATUS: {
    QUEUED: 'queued',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
  },

  // Score trigger events
  SCORE_TRIGGERS: {
    INITIAL: 'initial',
    NEW_SIGNAL: 'new_signal',
    MANUAL_OVERRIDE: 'manual_override',
    SCHEDULED_RESCORE: 'scheduled_rescore',
  },

  // Pagination defaults
  PAGINATION: {
    DEFAULT_PAGE: 1,
    DEFAULT_LIMIT: 25,
    MAX_LIMIT: 100,
  },
};
