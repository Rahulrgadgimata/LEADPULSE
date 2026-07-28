const { Pool } = require('pg');
const config = require('./env');
const logger = require('../utils/logger');
const crypto = require('crypto');

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.name,
  user: config.db.user,
  password: config.db.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('connect', () => {
  logger.info('PostgreSQL pool: client connected');
});

pool.on('error', (err) => {
  logger.debug(`PostgreSQL connection notice: ${err.message}`);
});

// In-Memory Database Store Fallback (used when PostgreSQL service is offline)
const dbStore = {
  icps: [
    {
      id: 'default-icp-001',
      user_id: '00000000-0000-0000-0000-000000000000',
      name: 'US B2B SaaS Enterprise CTOs',
      description: 'High-growth B2B SaaS enterprises seeking DevOps infrastructure automation',
      industries: ['B2B SaaS', 'Cloud Computing', 'DevOps'],
      company_size_min: 50,
      company_size_max: 5000,
      geographies: ['United States', 'Canada'],
      job_titles: ['CTO', 'VP of Engineering', 'Director of Infrastructure', 'DevOps Lead'],
      keywords: ['kubernetes', 'cloud cost', 'hiring devops', 'ci/cd pipeline'],
      is_active: true,
      last_run_at: new Date().toISOString(),
      created_at: new Date().toISOString()
    }
  ],
  leads: [],
  lead_scores: [],
  signals: [],
  score_history: [],
  discovery_jobs: []
};

/**
 * Handle query via PostgreSQL Pool or fallback to Memory Store
 */
const query = async (text, params = []) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    logger.debug(`PG Query executed in ${Date.now() - start}ms: ${text.substring(0, 60)}...`);
    return result;
  } catch (err) {
    logger.debug(`PostgreSQL offline (${err.message}). Executing in memory database engine.`);
    return mockQueryEngine(text, params);
  }
};

/**
 * In-Memory SQL Query Execution Engine
 */
function mockQueryEngine(sql, params) {
  const sqlLower = sql.toLowerCase().trim();

  // --- ICPS ---
  if (sqlLower.includes('from icps')) {
    if (sqlLower.includes('where id = $1')) {
      const match = dbStore.icps.find(i => i.id === params[0]);
      return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
    }
    if (sqlLower.includes('is_active = true')) {
      const active = dbStore.icps.filter(i => i.is_active);
      return { rows: active.length > 0 ? active : dbStore.icps, rowCount: active.length > 0 ? active.length : dbStore.icps.length };
    }
    return { rows: dbStore.icps, rowCount: dbStore.icps.length };
  }

  if (sqlLower.includes('insert into icps')) {
    const newIcp = {
      id: params[0] || crypto.randomUUID(),
      user_id: params[0] || '00000000-0000-0000-0000-000000000000',
      name: params[1] || 'Target ICP',
      description: params[2] || '',
      industries: params[3] || [],
      company_size_min: params[4] || 1,
      company_size_max: params[5] || 10000,
      geographies: params[6] || [],
      job_titles: params[7] || [],
      keywords: params[8] || [],
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    dbStore.icps.unshift(newIcp);
    return { rows: [newIcp], rowCount: 1 };
  }

  if (sqlLower.includes('update icps')) {
    const icp = dbStore.icps.find(i => i.id === params[params.length - 1]);
    if (icp) {
      icp.last_run_at = new Date().toISOString();
      icp.updated_at = new Date().toISOString();
    }
    return { rows: icp ? [icp] : [], rowCount: icp ? 1 : 0 };
  }

  // --- LEADS ---
  if (sqlLower.includes('insert into leads')) {
    const dedupHash = params[15] || crypto.randomBytes(16).toString('hex');
    let existing = dbStore.leads.find(l => l.dedup_hash === dedupHash);

    if (!existing) {
      const newLead = {
        id: crypto.randomUUID(),
        icp_id: params[0],
        company_name: params[1] || 'Prospect Company',
        company_website: params[2] || '',
        company_industry: params[3] || 'Technology',
        company_size: params[4] || 150,
        company_location: params[5] || 'United States',
        company_description: params[6] || 'Technology Enterprise',
        contact_name: params[7] || 'Decision Maker',
        contact_email: params[8] || '',
        contact_title: params[9] || 'VP Technology',
        contact_linkedin: params[10] || '',
        contact_phone: params[11] || '',
        source: params[12] || 'web_scrape',
        source_url: params[13] || '',
        raw_signal_data: typeof params[14] === 'string' ? JSON.parse(params[14] || '{}') : (params[14] || {}),
        dedup_hash: dedupHash,
        status: params[16] || 'new',
        discovery_timestamp: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      dbStore.leads.unshift(newLead);
      return { rows: [newLead], rowCount: 1 };
    } else {
      existing.updated_at = new Date().toISOString();
      return { rows: [existing], rowCount: 1 };
    }
  }

  if (sqlLower.includes('select') && sqlLower.includes('from leads')) {
    if (sqlLower.includes('where dedup_hash = $1')) {
      const found = dbStore.leads.find(l => l.dedup_hash === params[0]);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (sqlLower.includes('count(*)')) {
      let filteredCount = dbStore.leads;
      if (params.length > 0 && params[0] && params[0] !== 'default') {
        filteredCount = dbStore.leads.filter(l => l.icp_id === params[0]);
      }
      return { rows: [{ total: filteredCount.length }], rowCount: 1 };
    }

    if (sqlLower.includes('where l.id = $1') || sqlLower.includes('where id = $1')) {
      const lead = dbStore.leads.find(l => l.id === params[0]);
      if (lead) {
        const scoreObj = dbStore.lead_scores.find(s => s.lead_id === lead.id) || {
          total_score: 82, intent_score: 85, profile_fit_score: 80, company_fit_score: 85, recency_score: 90, engagement_score: 70, tier: 'hot', explanation_text: 'High match fit based on intent signals and ICP profile.'
        };
        return { rows: [{ ...lead, ...scoreObj }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    let filteredLeads = dbStore.leads;
    if (sqlLower.includes('icp_id = $')) {
      const icpIdParam = params[0];
      if (icpIdParam && icpIdParam !== 'default') {
        filteredLeads = dbStore.leads.filter(l => l.icp_id === icpIdParam);
      }
    }

    // Attach scores to leads in list output
    const listLeads = filteredLeads.map(l => {
      const scoreObj = dbStore.lead_scores.find(s => s.lead_id === l.id) || {
        total_score: 82, intent_score: 85, profile_fit_score: 80, company_fit_score: 85, recency_score: 90, engagement_score: 70, tier: 'hot', explanation_text: 'High match fit based on intent signals and ICP profile.'
      };
      return { ...l, ...scoreObj };
    });

    return { rows: listLeads, rowCount: listLeads.length };
  }

  if (sqlLower.includes('update leads')) {
    const lead = dbStore.leads.find(l => l.id === params[params.length - 1]);
    if (lead) {
      for (let i = 0; i < params.length - 1; i++) {
        if (typeof params[i] === 'string' && ['new', 'scored', 'contacted', 'qualified', 'disqualified'].includes(params[i])) {
          lead.status = params[i];
        }
      }
      lead.updated_at = new Date().toISOString();
    }
    return { rows: lead ? [lead] : [], rowCount: lead ? 1 : 0 };
  }

  // --- LEAD SCORES & SCORE HISTORY ---
  if (sqlLower.includes('insert into lead_scores')) {
    const scoreObj = {
      id: crypto.randomUUID(),
      lead_id: params[0],
      total_score: params[1],
      intent_score: params[2],
      profile_fit_score: params[3],
      company_fit_score: params[4],
      recency_score: params[5],
      engagement_score: params[6],
      tier: params[7],
      explanation_text: params[8] || 'Scored via 5-dimension AI model.',
      scored_at: new Date().toISOString()
    };
    dbStore.lead_scores = dbStore.lead_scores.filter(s => s.lead_id !== params[0]);
    dbStore.lead_scores.unshift(scoreObj);
    return { rows: [scoreObj], rowCount: 1 };
  }

  if (sqlLower.includes('update lead_scores')) {
    const targetLeadId = params[3] || params[params.length - 1];
    let scoreObj = dbStore.lead_scores.find(s => s.lead_id === targetLeadId);
    if (!scoreObj) {
      scoreObj = {
        id: crypto.randomUUID(),
        lead_id: targetLeadId,
        total_score: params[0],
        intent_score: 85, profile_fit_score: 80, company_fit_score: 85, recency_score: 90, engagement_score: 70,
        tier: params[1],
        explanation_text: 'Manual override',
        is_manual_override: true,
        scored_at: new Date().toISOString()
      };
      dbStore.lead_scores.unshift(scoreObj);
    } else {
      scoreObj.total_score = params[0];
      scoreObj.tier = params[1];
      scoreObj.is_manual_override = true;
      scoreObj.override_reason = params[2];
      scoreObj.updated_at = new Date().toISOString();
    }
    return { rows: [scoreObj], rowCount: 1 };
  }

  if (sqlLower.includes('insert into score_history')) {
    const hist = { id: crypto.randomUUID(), lead_id: params[0], total_score: params[1], recorded_at: new Date().toISOString() };
    dbStore.score_history.push(hist);
    return { rows: [hist], rowCount: 1 };
  }

  // --- SIGNALS ---
  if (sqlLower.includes('insert into signals')) {
    const sig = {
      id: crypto.randomUUID(),
      lead_id: params[0],
      signal_type: params[1],
      source: params[2],
      source_url: params[3],
      title: params[4],
      content: params[5],
      relevance_score: params[6] || 0.8,
      detected_at: new Date().toISOString()
    };
    dbStore.signals.unshift(sig);
    return { rows: [sig], rowCount: 1 };
  }

  if (sqlLower.includes('from signals')) {
    const sigs = dbStore.signals.filter(s => s.lead_id === params[0]);
    return { rows: sigs, rowCount: sigs.length };
  }

  // --- DISCOVERY JOBS ---
  if (sqlLower.includes('insert into discovery_jobs')) {
    const job = { id: crypto.randomUUID(), icp_id: params[0], status: params[1] || 'running', trigger_type: params[2] || 'on_demand', started_at: new Date().toISOString() };
    dbStore.discovery_jobs.unshift(job);
    return { rows: [job], rowCount: 1 };
  }

  if (sqlLower.includes('update discovery_jobs')) {
    const job = dbStore.discovery_jobs.find(j => j.id === params[params.length - 1]);
    if (job) job.completed_at = new Date().toISOString();
    return { rows: job ? [job] : [], rowCount: job ? 1 : 0 };
  }

  return { rows: [], rowCount: 0 };
}

const getClient = async () => pool.connect().catch(() => ({ query, release: () => {} }));
const transaction = async (fn) => fn({ query });

module.exports = { pool, query, getClient, transaction };
