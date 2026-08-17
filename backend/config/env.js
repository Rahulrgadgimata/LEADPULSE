// backend/config/env.js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

module.exports = {
  // Server
  PORT: parseInt(process.env.PORT) || 3000,

  // Comma-separated origins allowed to call the API from a browser. Empty means
  // same-origin only, which is correct when this server also serves the UI.
  CORS_ORIGIN: process.env.CORS_ORIGIN || '',
  // Enable when running behind a reverse proxy so client IPs (and therefore
  // rate limiting) are read from X-Forwarded-For.
  TRUST_PROXY: process.env.TRUST_PROXY === 'true',

  // Rate limits, per IP per minute.
  RATE_LIMIT_PER_MINUTE: parseInt(process.env.RATE_LIMIT_PER_MINUTE) || 120,
  DISCOVERY_RATE_LIMIT_PER_MINUTE: parseInt(process.env.DISCOVERY_RATE_LIMIT_PER_MINUTE) || 3,
  COPILOT_RATE_LIMIT_PER_MINUTE: parseInt(process.env.COPILOT_RATE_LIMIT_PER_MINUTE) || 15,
  // Drafting spends AI quota; sending spends domain reputation. Both are
  // deliberate, human-paced actions, so a low ceiling costs nothing in normal
  // use and caps the damage from a stuck retry loop in the UI.
  OUTREACH_RATE_LIMIT_PER_MINUTE: parseInt(process.env.OUTREACH_RATE_LIMIT_PER_MINUTE) || 30,

  // SQLite – use absolute path so it always resolves to backend dir
  SQLITE_PATH: process.env.SQLITE_PATH || path.join(__dirname, '../database.sqlite'),

  // JWT
  JWT_SECRET: process.env.JWT_SECRET || 'supersecretjwt',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',

  // Apollo.io (enrichment)
  APOLLO_API_KEY: process.env.APOLLO_API_KEY || '',

  // Hunter.io (enrichment)
  HUNTER_API_KEY: process.env.HUNTER_API_KEY || '',

  // ── Groq: lead generation (scraped-page qualification, news company
  // resolution, score explanations) ────────────────────────────────────────
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  // Optional additional keys, tried when the primary is rate-limited. Each key
  // carries its own quota, so a second key raises effective throughput rather
  // than only covering failures. Accepts one key or a comma-separated list.
  GROQ_API_KEY_FALLBACK: process.env.GROQ_API_KEY_FALLBACK || '',

  // ── Groq: copilot chat ───────────────────────────────────────────────────
  // A separate key keeps the chatbot's quota independent of a long discovery
  // run. Falls back to GROQ_API_KEY when unset.
  GROQ_CHAT_API_KEY: process.env.GROQ_CHAT_API_KEY || '',

  // Per-purpose models. Extraction needs reliable structured JSON; chat is
  // conversational, so the two are tuned separately.
  GROQ_MODEL_EXTRACTION: process.env.GROQ_MODEL_EXTRACTION || process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  GROQ_MODEL_CHAT: process.env.GROQ_MODEL_CHAT || 'qwen/qwen3.6-27b',

  // ── Mistral: cross-provider fallback ─────────────────────────────────────
  // Used only when every Groq key for a purpose is exhausted or rejected, so a
  // Groq outage or quota wall does not take the feature down. Mistral's API is
  // OpenAI-compatible, so the same request shape works.
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
  MISTRAL_MODEL_EXTRACTION: process.env.MISTRAL_MODEL_EXTRACTION || 'mistral-small-latest',
  MISTRAL_MODEL_CHAT: process.env.MISTRAL_MODEL_CHAT || 'mistral-small-latest',
  // Reasoning models burn the output budget thinking before emitting JSON.
  // 'none' keeps extraction fast and cheap; 'default' re-enables reasoning.
  // Ignored automatically by models that do not accept the parameter.
  GROQ_EXTRACTION_REASONING: process.env.GROQ_EXTRACTION_REASONING || 'none',
  // Same for chat: qwen emits a <think> block that can consume the entire
  // output budget before any answer is produced.
  GROQ_CHAT_REASONING: process.env.GROQ_CHAT_REASONING || 'none',
  // Candidates per extraction request, and how many requests run at once.
  // Larger batches amortise the system prompt; tokens-per-minute is the binding
  // limit, not latency, so requests are serialised by default.
  GROQ_BATCH_SIZE: parseInt(process.env.GROQ_BATCH_SIZE) || 12,
  GROQ_CONCURRENCY: parseInt(process.env.GROQ_CONCURRENCY) || 1,
  // Groq's free tier allows 12k tokens/min and 30 requests/min on
  // llama-3.3-70b; pace below both to leave headroom rather than thrashing
  // 429s. Raise these on a paid tier to speed runs up proportionally.
  GROQ_TPM_LIMIT: parseInt(process.env.GROQ_TPM_LIMIT) || 11000,
  GROQ_RPM_LIMIT: parseInt(process.env.GROQ_RPM_LIMIT) || 28,

  // NewsAPI
  NEWS_API_KEY: process.env.NEWS_API_KEY || '',
  // News discovery volume. Google News RSS is keyless and returns up to 100
  // items per query, so it carries the bulk; NewsAPI's free tier is
  // request-capped and is used for only the first few queries.
  NEWS_MAX_QUERIES: parseInt(process.env.NEWS_MAX_QUERIES) || 12,
  NEWS_MAX_ARTICLES: parseInt(process.env.NEWS_MAX_ARTICLES) || 150,
  NEWS_CONCURRENCY: parseInt(process.env.NEWS_CONCURRENCY) || 4,
  NEWSAPI_MAX_QUERIES: parseInt(process.env.NEWSAPI_MAX_QUERIES) || 3,
  NEWSAPI_PAGE_SIZE: parseInt(process.env.NEWSAPI_PAGE_SIZE) || 100,

  // Twitter
  TWITTER_BEARER_TOKEN: process.env.TWITTER_BEARER_TOKEN || '',

  // Reddit (OAuth "script" app – https://www.reddit.com/prefs/apps)
  REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID || '',
  REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET || '',
  REDDIT_USER_AGENT: process.env.REDDIT_USER_AGENT || 'nodejs:leadpulse-ai:1.0 (by /u/leadpulse)',

  // Scraper defaults
  // Must be a real browser UA: search endpoints serve an anti-bot CAPTCHA page
  // to bot-identifying agents, which yields zero results.
  SCRAPER_USER_AGENT: process.env.SCRAPER_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  SCRAPER_DELAY_MS: parseInt(process.env.SCRAPER_DELAY_MS) || 2500,

  // Whether collectors may fall back to a headless Chromium. Each of the three
  // search collectors keeps its own browser, so a run can hold three Chromium
  // process trees at 150-300MB each — enough to get the container OOM-killed on
  // a small instance, which takes the whole run (and, without a disk, the
  // database) with it. Turn this off there: Scrapling's TLS-impersonation
  // fetcher and the plain-HTTP paths still carry search, they just block more
  // often. Every caller already treats a browser failure as an empty result.
  SCRAPER_BROWSER_ENABLED: process.env.SCRAPER_BROWSER_ENABLED !== 'false',

  // ── Scrapling (Python) sidecar — robust fetch/search ─────────────────────
  // https://github.com/D4Vinci/Scrapling  (Fetcher / StealthyFetcher)
  // Node collectors call this first; Puppeteer/axios remain as fallback.
  SCRAPLING_ENABLED: process.env.SCRAPLING_ENABLED !== 'false',
  SCRAPLING_HOST: process.env.SCRAPLING_HOST || '127.0.0.1',
  SCRAPLING_PORT: parseInt(process.env.SCRAPLING_PORT) || 3765,
  // fetcher = curl_cffi TLS impersonation (fast); stealth = Playwright stealth.
  SCRAPLING_DEFAULT_MODE: process.env.SCRAPLING_DEFAULT_MODE || 'fetcher',
  SCRAPLING_PYTHON: process.env.SCRAPLING_PYTHON || 'py',
  SCRAPLING_BOOT_TIMEOUT_MS: parseInt(process.env.SCRAPLING_BOOT_TIMEOUT_MS) || 20000,

  // ── Web search providers ─────────────────────────────────────────────────
  // Scraping a search engine is unreliable: DuckDuckGo, Bing, Mojeek and Ecosia
  // all serve an anti-bot page once a host makes enough requests, and one
  // discovery run makes dozens. Configure either key below and discovery uses a
  // real API instead; scraping stays only as the last resort.
  //   Serper — https://serper.dev  (free tier ~2,500 queries)
  //   Brave  — https://brave.com/search/api  (free tier ~2,000/month)
  SERPER_API_KEY: process.env.SERPER_API_KEY || '',
  BRAVE_API_KEY: process.env.BRAVE_API_KEY || '',
  // Keyless Google answers a discovery run's query volume with 429 /sorry
  // interstitials, costing ~13s per query across three fallback paths while
  // returning nothing. Off by default; Brave + Bing + DuckDuckGo carry search.
  SEARCH_ENABLE_GOOGLE: process.env.SEARCH_ENABLE_GOOGLE === 'true',
  // Consecutive blocked scrapes before the search phase gives up for this run.
  SEARCH_BLOCK_ABORT_THRESHOLD: parseInt(process.env.SEARCH_BLOCK_ABORT_THRESHOLD) || 8,
  // Consecutive blocks before one search source rests, and for how long. A
  // throttled engine still costs its full timeout on every query, so resting it
  // keeps the run fast while the remaining sources carry on.
  SEARCH_SOURCE_COOLDOWN_AFTER: parseInt(process.env.SEARCH_SOURCE_COOLDOWN_AFTER) || 3,
  SEARCH_SOURCE_COOLDOWN_MS: parseInt(process.env.SEARCH_SOURCE_COOLDOWN_MS) || 240000,

  // "Top N companies in <city>" pages found during search are opened and mined
  // for the companies they link to — roughly 20-40 in-niche companies per page
  // against about one per ordinary search result.
  DISCOVERY_DIRECTORY_PAGES: Math.min(parseInt(process.env.DISCOVERY_DIRECTORY_PAGES) || 2, 2),
  DISCOVERY_DIRECTORY_LINKS: Math.min(parseInt(process.env.DISCOVERY_DIRECTORY_LINKS) || 10, 10),
  // Pause before retrying a blocked query. The block is usually a short
  // throttle, so one backoff recovers most of them.
  SEARCH_BLOCK_BACKOFF_MS: parseInt(process.env.SEARCH_BLOCK_BACKOFF_MS) || 6000,

  // Discovery volume. DuckDuckGo yields ~10 unique domains per query and has no
  // working pagination, so reaching the target means running many distinct
  // queries — budget roughly (target / 8) queries.
  // A 'running' job older than this is treated as abandoned (crash/restart),
  // so a dead row cannot block discovery forever.
  // Minutes without a progress heartbeat before a 'running' job is considered
  // dead. Sized above the slowest silent phase (Groq qualification, which can
  // pace for several minutes on a free tier) but short enough that a run killed
  // by a restart does not leave the UI polling a frozen progress bar.
  DISCOVERY_STALE_JOB_MINUTES: parseInt(process.env.DISCOVERY_STALE_JOB_MINUTES) || 10,
  DISCOVERY_TARGET_LEADS: Math.min(parseInt(process.env.DISCOVERY_TARGET_LEADS) || 10, 10),
  DISCOVERY_MAX_QUERIES: Math.min(parseInt(process.env.DISCOVERY_MAX_QUERIES) || 6, 6),
  // Parallel homepage fetches while profiling candidate domains.
  SCRAPER_CONCURRENCY: parseInt(process.env.SCRAPER_CONCURRENCY) || 4,
  SCRAPER_PAGE_TIMEOUT_MS: parseInt(process.env.SCRAPER_PAGE_TIMEOUT_MS) || 6000,
  // Parallel enrich+score workers. Bounded to stay inside Hunter/Apollo limits.
  ENRICHMENT_CONCURRENCY: parseInt(process.env.ENRICHMENT_CONCURRENCY) || 4,

  // LinkedIn public company-page discovery (via search-engine index + soft OG fetch).
  LINKEDIN_TARGET_LEADS: Math.min(parseInt(process.env.LINKEDIN_TARGET_LEADS) || 5, 5),
  LINKEDIN_MAX_QUERIES: Math.min(parseInt(process.env.LINKEDIN_MAX_QUERIES) || 4, 4),
  // Public LinkedIn people/buyer discovery (title + company from search snippets).
  BUYER_TARGET_LEADS: Math.min(parseInt(process.env.BUYER_TARGET_LEADS) || 5, 5),
  BUYER_MAX_QUERIES: Math.min(parseInt(process.env.BUYER_MAX_QUERIES) || 3, 3),

  // Intake quality: only prospects with website or LinkedIn company page enter.
  // LEAD_QUALITY_MIN_SCORE and LEAD_QUALITY_DROP_WEAK_ICP used to live here.
  // Both were read by nothing: the intake rules they described were
  // reimplemented as explicit checks in leadQuality.evaluate(), and the knobs
  // were left behind reading as though they still tuned the filter.

  // Drop a lead whose location is known and falls outside the ICP's
  // geographies. A lead with no location survives either way — location is
  // often only resolved during enrichment, so rejecting unknowns would discard
  // most of the pipeline. Set false to keep out-of-region leads and rely on the
  // scoring penalty alone.
  LEAD_GEO_STRICT: process.env.LEAD_GEO_STRICT !== 'false',

  // X / Twitter search paging (each page costs API quota).
  TWITTER_MAX_PAGES: parseInt(process.env.TWITTER_MAX_PAGES) || 3,
  TWITTER_RESULTS_PER_PAGE: parseInt(process.env.TWITTER_RESULTS_PER_PAGE) || 100,

  // ── Outreach: AI message generation ──────────────────────────────────────
  // Which engine writes the first draft. 'auto' takes the first configured
  // provider in order: Gemini → Claude → Groq → template. The template path
  // has no dependencies, so the Generate button never dead-ends on a missing
  // key; it just produces a plainer draft.
  //   Values: auto | gemini | claude | groq | template
  OUTREACH_AI_PROVIDER: process.env.OUTREACH_AI_PROVIDER || 'auto',

  // Gemini via the Google Generative Language API. Keyless generation is also
  // available through the browser handoff below, which needs nothing set here.
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',

  // Browser handoff: the server builds the prompt, the browser opens Gemini
  // already signed in as the user, and the user pastes the result back. No API
  // key is involved — Google does not expose a way for a server to borrow a
  // browser session, so the human is the bridge.
  GEMINI_WEB_URL: process.env.GEMINI_WEB_URL || 'https://gemini.google.com/app',

  // Anthropic, for the Claude-drafted path named in the Phase 2 spec.
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',

  // Sender identity written into every draft's sign-off.
  OUTREACH_SENDER_NAME: process.env.OUTREACH_SENDER_NAME || '',
  OUTREACH_SENDER_TITLE: process.env.OUTREACH_SENDER_TITLE || '',
  OUTREACH_SENDER_COMPANY: process.env.OUTREACH_SENDER_COMPANY || '',
  // One line describing what you sell. This is the single biggest lever on
  // draft quality: without it the model can only guess why you are writing.
  OUTREACH_VALUE_PROP: process.env.OUTREACH_VALUE_PROP || '',

  // ── Outreach: SMTP delivery ─────────────────────────────────────────────
  // Works with SendGrid (host smtp.sendgrid.net, user "apikey", pass = the API
  // key), Gmail app passwords, or any other SMTP relay.
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT) || 587,
  // Implicit TLS on 465; STARTTLS on 587. Defaults from the port so a wrong
  // combination cannot silently downgrade the connection.
  SMTP_SECURE: process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === 'true'
    : parseInt(process.env.SMTP_PORT) === 465,
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',

  MAIL_FROM_EMAIL: process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER || '',
  MAIL_FROM_NAME: process.env.MAIL_FROM_NAME || 'LeadPulse AI',
  MAIL_REPLY_TO: process.env.MAIL_REPLY_TO || '',

  // Nothing leaves the building while this is on: sends are recorded in the
  // log as usual but no SMTP connection is opened. Useful for demos and for a
  // first run against real leads.
  OUTREACH_DRY_RUN: process.env.OUTREACH_DRY_RUN === 'true',

  // A cold-email mistake is expensive and irreversible, so cap the blast
  // radius: per-run send limit and a rolling 24h ceiling.
  OUTREACH_DAILY_SEND_LIMIT: parseInt(process.env.OUTREACH_DAILY_SEND_LIMIT) || 200,
  OUTREACH_BULK_SEND_LIMIT: parseInt(process.env.OUTREACH_BULK_SEND_LIMIT) || 50,

  // How often the scheduler looks for scheduled messages that have come due.
  OUTREACH_SCHEDULER_INTERVAL_MS: parseInt(process.env.OUTREACH_SCHEDULER_INTERVAL_MS) || 30000,
  OUTREACH_SCHEDULER_ENABLED: process.env.OUTREACH_SCHEDULER_ENABLED !== 'false',

  // Public origin used to build unsubscribe links. Must be reachable by the
  // recipient — localhost produces a link only you can open.
  APP_BASE_URL: (process.env.APP_BASE_URL || '').replace(/\/$/, ''),

  // Scheduler
  CRON_SCHEDULE: process.env.CRON_SCHEDULE || '0 2 * * *', // 02:00 daily

  // Redis (optional – used by Bull queues)
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT) || 6379,
  },
};
