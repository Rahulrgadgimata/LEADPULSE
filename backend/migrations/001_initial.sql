-- ═══════════════════════════════════════════════
-- LeadPulse AI — Initial Database Schema
-- ═══════════════════════════════════════════════

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────
-- Ideal Customer Profiles (ICPs)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS icps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    industries TEXT[] DEFAULT '{}',
    company_size_min INTEGER DEFAULT 1,
    company_size_max INTEGER DEFAULT 10000,
    geographies TEXT[] DEFAULT '{}',
    job_titles TEXT[] DEFAULT '{}',
    keywords TEXT[] DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    last_run_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- Discovered Leads
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    icp_id UUID REFERENCES icps(id) ON DELETE SET NULL,

    -- Company info
    company_name VARCHAR(500) NOT NULL,
    company_website VARCHAR(500),
    company_industry VARCHAR(255),
    company_size INTEGER,
    company_location VARCHAR(500),
    company_description TEXT,

    -- Contact info
    contact_name VARCHAR(255),
    contact_email VARCHAR(255),
    contact_title VARCHAR(255),
    contact_linkedin VARCHAR(500),
    contact_phone VARCHAR(50),

    -- Discovery metadata
    source VARCHAR(100) NOT NULL,  -- 'web_scrape', 'news', 'job_board', 'social', 'enrichment'
    source_url TEXT,
    raw_signal_data JSONB DEFAULT '{}',
    discovery_timestamp TIMESTAMPTZ DEFAULT NOW(),

    -- Deduplication
    dedup_hash VARCHAR(64) UNIQUE NOT NULL,

    -- Status
    status VARCHAR(50) DEFAULT 'new',  -- 'new', 'scored', 'reviewed', 'accepted', 'rejected'
    user_notes TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- Lead Scores
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lead_scores (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,

    -- Total score (0–100)
    total_score INTEGER NOT NULL CHECK (total_score >= 0 AND total_score <= 100),

    -- Five scoring dimensions (each 0–100, weighted to produce total)
    intent_score INTEGER DEFAULT 0 CHECK (intent_score >= 0 AND intent_score <= 100),
    profile_fit_score INTEGER DEFAULT 0 CHECK (profile_fit_score >= 0 AND profile_fit_score <= 100),
    company_fit_score INTEGER DEFAULT 0 CHECK (company_fit_score >= 0 AND company_fit_score <= 100),
    recency_score INTEGER DEFAULT 0 CHECK (recency_score >= 0 AND recency_score <= 100),
    engagement_score INTEGER DEFAULT 0 CHECK (engagement_score >= 0 AND engagement_score <= 100),

    -- Tier: Hot (70+), Warm (40–69), Cold (0–39)
    tier VARCHAR(10) NOT NULL CHECK (tier IN ('hot', 'warm', 'cold')),

    -- Claude-generated explanation
    explanation_text TEXT,

    -- Override
    is_manual_override BOOLEAN DEFAULT false,
    override_reason TEXT,

    -- Timestamps
    scored_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(lead_id)
);

-- ─────────────────────────────────────────────
-- Score History (for trend tracking)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS score_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    total_score INTEGER NOT NULL,
    intent_score INTEGER DEFAULT 0,
    profile_fit_score INTEGER DEFAULT 0,
    company_fit_score INTEGER DEFAULT 0,
    recency_score INTEGER DEFAULT 0,
    engagement_score INTEGER DEFAULT 0,
    tier VARCHAR(10) NOT NULL,
    trigger_event VARCHAR(100),  -- 'initial', 'new_signal', 'manual_override', 'scheduled_rescore'
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- Signals (raw signal events)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,

    signal_type VARCHAR(50) NOT NULL,  -- 'news_mention', 'job_posting', 'social_post', 'web_mention', 'funding'
    source VARCHAR(100) NOT NULL,      -- 'google_news', 'indeed', 'reddit', 'twitter', etc.
    source_url TEXT,
    title VARCHAR(500),
    content TEXT,
    relevance_score FLOAT DEFAULT 0,   -- 0.0–1.0 relevance to ICP
    metadata JSONB DEFAULT '{}',

    detected_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- Discovery Jobs (tracking background jobs)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS discovery_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    icp_id UUID NOT NULL REFERENCES icps(id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'queued',  -- 'queued', 'running', 'completed', 'failed'
    trigger_type VARCHAR(50) NOT NULL,    -- 'scheduled', 'on_demand'
    leads_found INTEGER DEFAULT 0,
    leads_new INTEGER DEFAULT 0,
    leads_duplicate INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────
CREATE INDEX idx_leads_icp_id ON leads(icp_id);
CREATE INDEX idx_leads_source ON leads(source);
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_dedup_hash ON leads(dedup_hash);
CREATE INDEX idx_leads_company_name ON leads(company_name);
CREATE INDEX idx_leads_discovery_timestamp ON leads(discovery_timestamp DESC);

CREATE INDEX idx_lead_scores_lead_id ON lead_scores(lead_id);
CREATE INDEX idx_lead_scores_total_score ON lead_scores(total_score DESC);
CREATE INDEX idx_lead_scores_tier ON lead_scores(tier);

CREATE INDEX idx_score_history_lead_id ON score_history(lead_id);
CREATE INDEX idx_score_history_recorded_at ON score_history(recorded_at DESC);

CREATE INDEX idx_signals_lead_id ON signals(lead_id);
CREATE INDEX idx_signals_signal_type ON signals(signal_type);
CREATE INDEX idx_signals_detected_at ON signals(detected_at DESC);

CREATE INDEX idx_discovery_jobs_icp_id ON discovery_jobs(icp_id);
CREATE INDEX idx_discovery_jobs_status ON discovery_jobs(status);

-- ─────────────────────────────────────────────
-- Triggers: auto-update updated_at
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_icps_updated_at BEFORE UPDATE ON icps
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_leads_updated_at BEFORE UPDATE ON leads
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_lead_scores_updated_at BEFORE UPDATE ON lead_scores
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
