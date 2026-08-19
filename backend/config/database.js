const Database = require('better-sqlite3');
const path = require('path');
const config = require('./env');
const logger = require('../utils/logger');

// Resolve SQLite database file path; fallback to a default location if not set
const dbPath = config.SQLITE_PATH ? config.SQLITE_PATH : path.join(__dirname, '../database.sqlite');
const db = new Database(dbPath);

// Initialize required tables if they do not exist
function init() {
  const createUsers = `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    password_hash TEXT,
    created_at TEXT
  );`;

  const createIcp = `CREATE TABLE IF NOT EXISTS icps (
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
  );`;

  const createLeads = `CREATE TABLE IF NOT EXISTS leads (
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
    updated_at TEXT
  );`;

  const createLeadScores = `CREATE TABLE IF NOT EXISTS lead_scores (
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
  );`;

  const createSignals = `CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    signal_type TEXT,
    source TEXT,
    source_url TEXT,
    title TEXT,
    content TEXT,
    relevance_score REAL,
    detected_at TEXT,
    created_at TEXT
  );`;

  const createScoreHistory = `CREATE TABLE IF NOT EXISTS score_history (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    total_score INTEGER,
    recorded_at TEXT
  );`;

  const createDiscoveryJobs = `CREATE TABLE IF NOT EXISTS discovery_jobs (
    id TEXT PRIMARY KEY,
    icp_id TEXT,
    status TEXT,
    trigger_type TEXT,
    started_at TEXT,
    completed_at TEXT
  );`;

  // ── Phase 2: outreach ───────────────────────────────────────────────────
  // A draft the user has not sent is still a message row; `status` is what
  // separates a draft from something that actually left the building. Keeping
  // both in one table means the sent log and the editor read the same record,
  // so an edit made before sending is exactly what the log later shows.
  const createMessages = `CREATE TABLE IF NOT EXISTS messages (
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
  );`;

  const createMessageTemplates = `CREATE TABLE IF NOT EXISTS message_templates (
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
  );`;

  // Opt-outs are checked on every send, so they live apart from leads: a lead
  // can be deleted and re-discovered, but the person's "do not contact me"
  // must outlive that.
  const createSuppressions = `CREATE TABLE IF NOT EXISTS suppressions (
    id TEXT PRIMARY KEY,
    email TEXT,
    domain TEXT,
    reason TEXT,
    source TEXT,
    evidence TEXT,
    lead_id TEXT,
    created_at TEXT
  );`;

  db.exec(createUsers);
  db.exec(createIcp);
  db.exec(createLeads);
  db.exec(createLeadScores);
  db.exec(createSignals);
  db.exec(createScoreHistory);
  db.exec(createDiscoveryJobs);
  db.exec(createMessages);
  db.exec(createMessageTemplates);
  db.exec(createSuppressions);

  // Safely add any missing columns for existing databases
  try {
    db.prepare("ALTER TABLE discovery_jobs ADD COLUMN progress INTEGER DEFAULT 0").run();
  } catch (e) {}
  try {
    db.prepare("ALTER TABLE discovery_jobs ADD COLUMN status_text TEXT").run();
  } catch (e) {}
  try {
    db.prepare("ALTER TABLE discovery_jobs ADD COLUMN failed_reason TEXT").run();
  } catch (e) {}
  // Heartbeat: lets a stalled job be told apart from a merely long one. A run
  // killed by a restart leaves status='running' forever without this.
  try {
    db.prepare("ALTER TABLE discovery_jobs ADD COLUMN last_progress_at TEXT").run();
  } catch (e) {}
  // Per-row outcome of a spreadsheet import: which contact details were found
  // for each company and which were not. Kept on the job rather than the lead
  // because it describes one run's attempt, and the user needs to see "we
  // looked and did not find an email" as distinct from "we never looked".
  try {
    db.prepare("ALTER TABLE discovery_jobs ADD COLUMN result_json TEXT").run();
  } catch (e) {}

  // Review state is deliberately separate from `status`. `status` tracks where
  // a lead sits in the discovery pipeline ('new' → 'scored'); review_status
  // records the human decision. Overloading one column would have made a
  // rescore silently erase an accept.
  const leadColumns = [
    "ALTER TABLE leads ADD COLUMN review_status TEXT DEFAULT 'pending'",
    'ALTER TABLE leads ADD COLUMN reviewed_at TEXT',
    'ALTER TABLE leads ADD COLUMN review_note TEXT',
    'ALTER TABLE leads ADD COLUMN user_notes TEXT',
    'ALTER TABLE leads ADD COLUMN is_manual INTEGER DEFAULT 0',
    'ALTER TABLE leads ADD COLUMN last_contacted_at TEXT',
  ];
  for (const sql of leadColumns) {
    try { db.prepare(sql).run(); } catch (e) { /* column already present */ }
  }

  // Rows written before review_status existed default to NULL, which no filter
  // matches — backfill so they show up as pending rather than disappearing.
  try {
    db.prepare("UPDATE leads SET review_status = 'pending' WHERE review_status IS NULL").run();
  } catch (e) {}

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_leads_review_status ON leads(review_status)',
    'CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id)',
    'CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)',
    'CREATE INDEX IF NOT EXISTS idx_messages_scheduled_at ON messages(scheduled_at)',
    'CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_unsub_token ON messages(unsubscribe_token)',
    'CREATE INDEX IF NOT EXISTS idx_suppressions_email ON suppressions(email)',
    'CREATE INDEX IF NOT EXISTS idx_suppressions_domain ON suppressions(domain)',
  ];
  for (const sql of indexes) {
    try { db.exec(sql); } catch (e) { logger.warn(`Index skipped: ${e.message}`); }
  }

  // Auto-seed default ICP if table is empty
  try {
    const icpCount = db.prepare('SELECT COUNT(*) as count FROM icps').get().count;
    if (icpCount === 0) {
      const now = new Date().toISOString();
      const insertSql = `
        INSERT INTO icps (id, name, description, industries, company_size_min, company_size_max, geographies, job_titles, keywords, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `;
      db.prepare(insertSql).run(
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
      );
      logger.info('Database auto-seeded with default target ICP.');
    }
  } catch (e) {
    logger.error('Failed to seed default ICP:', e.message);
  }

  logger.info('Database initialized with all tables.');
}

init();

/**
 * Execute a SQL query against the SQLite database.
 * Returns an object with `rows` (array) and `rowCount` (number).
 */
function query(sql, params = []) {
  const start = Date.now();
  try {
    const stmt = db.prepare(sql);
    const isSelect = /^\s*SELECT/i.test(sql);
    const result = isSelect ? stmt.all(...params) : stmt.run(...params);
    logger.debug(`SQLite query executed in ${Date.now() - start}ms: ${sql.substring(0, 60)}...`);
    return { rows: isSelect ? result : [], rowCount: isSelect ? result.length : result.changes };
  } catch (err) {
    logger.error('SQLite query error:', err.message);
    throw err;
  }
}

module.exports = { db, query };
