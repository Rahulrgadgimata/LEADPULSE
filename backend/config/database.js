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

  db.exec(createUsers);
  db.exec(createIcp);
  db.exec(createLeads);
  db.exec(createLeadScores);
  db.exec(createSignals);
  db.exec(createScoreHistory);
  db.exec(createDiscoveryJobs);

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
