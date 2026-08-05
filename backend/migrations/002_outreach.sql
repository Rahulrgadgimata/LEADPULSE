-- ═══════════════════════════════════════════════
-- LeadPulse AI — Phase 2: Lead Review + Outreach
--
-- Postgres parity for what backend/config/database.js creates in SQLite at
-- boot. The running app uses SQLite; this file keeps the Postgres schema in
-- step for deployments that swap the driver.
-- ═══════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- Lead review state
--
-- Kept apart from leads.status: status tracks the discovery pipeline
-- ('new' → 'scored'), review_status records the human decision. One column for
-- both would let a rescore erase an accept.
-- ─────────────────────────────────────────────
ALTER TABLE leads ADD COLUMN IF NOT EXISTS review_status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ;

UPDATE leads SET review_status = 'pending' WHERE review_status IS NULL;

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_review_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_review_status_check
    CHECK (review_status IN ('pending', 'accepted', 'rejected', 'hold'));

-- ─────────────────────────────────────────────
-- Messages — drafts and the sent log in one table
--
-- A draft the user has not sent is still a message; `status` is what separates
-- a draft from something that actually left the building. Sharing one table
-- means the editor and the sent log read the same row, so what was edited
-- before sending is exactly what the log later shows.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
    icp_id UUID REFERENCES icps(id) ON DELETE SET NULL,
    template_id UUID,

    channel VARCHAR(20) DEFAULT 'email',
    to_email VARCHAR(255),
    to_name VARCHAR(255),
    from_email VARCHAR(255),
    subject VARCHAR(998),
    body TEXT,

    -- 'draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'
    status VARCHAR(20) DEFAULT 'draft',

    -- Which engine wrote the first draft: 'gemini', 'groq', 'claude',
    -- 'handoff' (pasted back from the Gemini web app), 'template', 'manual'.
    generated_by VARCHAR(30),
    generation_prompt TEXT,
    -- JSON record of the personalisation inputs actually used, so a draft can
    -- be audited after the underlying lead changes.
    personalisation JSONB DEFAULT '{}',

    scheduled_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    provider_message_id VARCHAR(255),
    error_message TEXT,
    send_attempts INTEGER DEFAULT 0,
    unsubscribe_token VARCHAR(64) UNIQUE,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- Reusable templates — a draft that worked, saved for next time
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    subject VARCHAR(998),
    body TEXT,
    channel VARCHAR(20) DEFAULT 'email',
    tags TEXT[] DEFAULT '{}',
    times_used INTEGER DEFAULT 0,
    source_message_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- Suppressions — opt-outs, checked before every send
--
-- Separate from leads on purpose: a lead can be deleted and re-discovered
-- tomorrow, but the person's "stop emailing me" has to outlive that.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppressions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE,
    domain VARCHAR(255),
    reason TEXT,
    -- 'reply_keyword', 'unsubscribe_link', 'manual', 'bounce'
    source VARCHAR(30),
    evidence TEXT,
    lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_leads_review_status ON leads(review_status);
CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
-- The scheduler polls for due sends: status + scheduled_at together is the
-- lookup it actually makes.
CREATE INDEX IF NOT EXISTS idx_messages_due ON messages(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_suppressions_email ON suppressions(email);
CREATE INDEX IF NOT EXISTS idx_suppressions_domain ON suppressions(domain);

-- ─────────────────────────────────────────────
-- Triggers: auto-update updated_at
-- ─────────────────────────────────────────────
DROP TRIGGER IF EXISTS update_messages_updated_at ON messages;
CREATE TRIGGER update_messages_updated_at BEFORE UPDATE ON messages
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_message_templates_updated_at ON message_templates;
CREATE TRIGGER update_message_templates_updated_at BEFORE UPDATE ON message_templates
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
