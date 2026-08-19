const { Pool, types } = require('pg');
const config = require('./env');
const logger = require('../utils/logger');

/**
 * Postgres (Supabase) data layer.
 *
 * Replaces the embedded SQLite file, which could not survive this deployment:
 * the free instance has no disk, so every restart, deploy and idle spin-down
 * emptied the database — discovery runs and imports were repeatedly lost
 * mid-flight, and a saved ICP could vanish minutes later. A hosted database is
 * the only fix that does not depend on the instance staying alive.
 *
 * Two decisions keep the change small and the behaviour identical:
 *
 *  - `?` placeholders are translated to Postgres `$1…$n` here, so the hundred
 *    or so SQL strings across the app did not have to be rewritten. What
 *    changed at the call sites is the `await`.
 *  - Timestamps stay TEXT holding ISO-8601, exactly as before. The app writes
 *    `new Date().toISOString()` and compares those strings in a dozen places;
 *    moving to `timestamptz` would silently change every one of them.
 */

// node-postgres returns BIGINT as a string to protect precision, which turns
// every COUNT(*) into "12" and any arithmetic on it into string concatenation.
// Every count here is small, so read them as numbers.
types.setTypeParser(20, value => (value === null ? null : Number(value)));

if (!config.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required. Use the Supabase connection string from ' +
    'Project Settings → Database → Connection string → URI.'
  );
}

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  // Supabase presents a certificate chain Node has no root for. The connection
  // is still encrypted; this only skips chain verification.
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : false,
  max: config.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000
});

pool.on('error', err => {
  // A pooled connection dropped while idle; the pool replaces it. Logged so a
  // recurring network fault is visible rather than silent.
  logger.warn(`Postgres idle client error: ${err.message}`);
});

/**
 * Translate `?` placeholders into `$1…$n`, ignoring any inside string literals.
 */
function toPgPlaceholders(sql) {
  let index = 0;
  let out = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;

    if (ch === '?' && !inSingle && !inDouble) out += `$${++index}`;
    else out += ch;
  }
  return out;
}

/**
 * Run a statement. Returns `{ rows, rowCount }` — the same shape the SQLite
 * layer returned, so call sites only had to gain an `await`.
 */
async function query(sql, params = []) {
  const start = Date.now();
  try {
    const result = await pool.query(toPgPlaceholders(sql), params);
    const ms = Date.now() - start;
    if (ms > 1500) logger.debug(`Slow query (${ms}ms): ${sql.slice(0, 80)}...`);
    return { rows: result.rows, rowCount: result.rowCount };
  } catch (err) {
    logger.error(`Postgres query failed: ${err.message} — ${sql.slice(0, 120)}`);
    throw err;
  }
}

/**
 * Run several statements atomically on one connection. `fn` receives a
 * query-shaped function bound to that connection; anything it throws rolls the
 * whole thing back.
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scoped = async (sql, params = []) => {
      const result = await client.query(toPgPlaceholders(sql), params);
      return { rows: result.rows, rowCount: result.rowCount };
    };
    const value = await fn(scoped);
    await client.query('COMMIT');
    return value;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Schema ──────────────────────────────────────────────────────────────────
// Plain DDL rather than a migration tool: the app owns the whole database, and
// IF NOT EXISTS makes every statement safe to re-run on each boot.
const TABLES = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    password_hash TEXT,
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS icps (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT,
    description TEXT,
    industries TEXT,
    company_size_min INTEGER,
    company_size_max INTEGER,
    geographies TEXT,
    job_titles TEXT,
    keywords TEXT,
    is_active INTEGER DEFAULT 1,
    last_run_at TEXT,
    created_at TEXT,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    icp_id TEXT,
    company_name TEXT,
    company_website TEXT,
    company_industry TEXT,
    company_size INTEGER,
    company_location TEXT,
    company_description TEXT,
    contact_name TEXT,
    contact_email TEXT,
    contact_title TEXT,
    contact_linkedin TEXT,
    contact_phone TEXT,
    source TEXT,
    source_url TEXT,
    raw_signal_data TEXT,
    dedup_hash TEXT UNIQUE,
    status TEXT DEFAULT 'new',
    discovery_timestamp TEXT,
    created_at TEXT,
    updated_at TEXT,
    review_status TEXT DEFAULT 'pending',
    reviewed_at TEXT,
    review_note TEXT,
    user_notes TEXT,
    is_manual INTEGER DEFAULT 0,
    last_contacted_at TEXT,
    extracted_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS lead_scores (
    id TEXT PRIMARY KEY,
    lead_id TEXT UNIQUE,
    total_score INTEGER,
    intent_score INTEGER,
    profile_fit_score INTEGER,
    company_fit_score INTEGER,
    recency_score INTEGER,
    engagement_score INTEGER,
    tier TEXT,
    explanation_text TEXT,
    is_manual_override INTEGER DEFAULT 0,
    scored_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    signal_type TEXT,
    source TEXT,
    source_url TEXT,
    title TEXT,
    content TEXT,
    relevance_score DOUBLE PRECISION,
    detected_at TEXT,
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS score_history (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    total_score INTEGER,
    recorded_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS discovery_jobs (
    id TEXT PRIMARY KEY,
    icp_id TEXT,
    status TEXT,
    trigger_type TEXT,
    started_at TEXT,
    completed_at TEXT,
    progress INTEGER DEFAULT 0,
    status_text TEXT,
    failed_reason TEXT,
    last_progress_at TEXT,
    result_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    icp_id TEXT,
    template_id TEXT,
    channel TEXT DEFAULT 'email',
    to_email TEXT,
    to_name TEXT,
    from_email TEXT,
    subject TEXT,
    body TEXT,
    status TEXT DEFAULT 'draft',
    generated_by TEXT,
    generation_prompt TEXT,
    personalisation TEXT,
    scheduled_at TEXT,
    sent_at TEXT,
    provider_message_id TEXT,
    error_message TEXT,
    send_attempts INTEGER DEFAULT 0,
    unsubscribe_token TEXT,
    created_at TEXT,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS message_templates (
    id TEXT PRIMARY KEY,
    name TEXT,
    subject TEXT,
    body TEXT,
    channel TEXT DEFAULT 'email',
    tags TEXT,
    times_used INTEGER DEFAULT 0,
    source_message_id TEXT,
    created_at TEXT,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS suppressions (
    id TEXT PRIMARY KEY,
    email TEXT,
    domain TEXT,
    reason TEXT,
    source TEXT,
    evidence TEXT,
    lead_id TEXT,
    created_at TEXT
  )`
];

// Columns added after a table first shipped. Postgres supports IF NOT EXISTS
// on ADD COLUMN, so these need none of the try/catch the SQLite version used.
const ADDED_COLUMNS = [
  'ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0',
  'ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS status_text TEXT',
  'ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS failed_reason TEXT',
  'ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS last_progress_at TEXT',
  'ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS result_json TEXT',
  "ALTER TABLE leads ADD COLUMN IF NOT EXISTS review_status TEXT DEFAULT 'pending'",
  'ALTER TABLE leads ADD COLUMN IF NOT EXISTS reviewed_at TEXT',
  'ALTER TABLE leads ADD COLUMN IF NOT EXISTS review_note TEXT',
  'ALTER TABLE leads ADD COLUMN IF NOT EXISTS user_notes TEXT',
  'ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_manual INTEGER DEFAULT 0',
  'ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_contacted_at TEXT',
  // Whatever the user asked an import to find that has no column of its own —
  // "tech stack", "funding stage", "number of branches". The requested fields
  // are theirs, so the storage cannot be a fixed set.
  'ALTER TABLE leads ADD COLUMN IF NOT EXISTS extracted_json TEXT'
];

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_leads_icp_id ON leads(icp_id)',
  'CREATE INDEX IF NOT EXISTS idx_leads_review_status ON leads(review_status)',
  'CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_lead_scores_lead_id ON lead_scores(lead_id)',
  'CREATE INDEX IF NOT EXISTS idx_signals_lead_id ON signals(lead_id)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_icp_status ON discovery_jobs(icp_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id)',
  'CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)',
  'CREATE INDEX IF NOT EXISTS idx_messages_scheduled_at ON messages(scheduled_at)',
  'CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_unsub_token ON messages(unsubscribe_token)',
  'CREATE INDEX IF NOT EXISTS idx_suppressions_email ON suppressions(email)',
  'CREATE INDEX IF NOT EXISTS idx_suppressions_domain ON suppressions(domain)'
];

let readyPromise = null;

/**
 * Create the schema and seed the starter ICP.
 *
 * Safe to call repeatedly: the first call does the work and every later one
 * awaits the same promise, so routes can await it without racing.
 */
function init() {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    for (const ddl of TABLES) await pool.query(ddl);
    for (const ddl of ADDED_COLUMNS) await pool.query(ddl);
    for (const ddl of INDEXES) {
      try {
        await pool.query(ddl);
      } catch (err) {
        logger.warn(`Index skipped: ${err.message}`);
      }
    }

    // Seed a starter ICP only when there is none, so a real deployment's own
    // profiles are never joined by a demo one.
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM icps');
    if (rows[0].count === 0) {
      const now = new Date().toISOString();
      await pool.query(
        `INSERT INTO icps (id, name, description, industries, company_size_min,
           company_size_max, geographies, job_titles, keywords, is_active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11)`,
        [
          'default',
          'US B2B SaaS Enterprise CTOs',
          'High-growth SaaS companies seeking DevOps scaling',
          JSON.stringify(['B2B SaaS', 'Cloud Computing', 'DevOps', 'CyberSecurity']),
          50,
          5000,
          JSON.stringify(['United States', 'Canada', 'United Kingdom']),
          JSON.stringify(['CTO', 'VP of Engineering', 'Director of Infrastructure', 'DevOps Lead']),
          JSON.stringify(['kubernetes', 'cloud cost', 'hiring devops', 'ci/cd pipeline', 'observability']),
          now,
          now
        ]
      );
      logger.info('Database seeded with the default target ICP.');
    }

    logger.info('Postgres schema ready.');
  })();

  return readyPromise;
}

module.exports = { pool, query, transaction, init };
