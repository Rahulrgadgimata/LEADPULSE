const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const GroqClient = require('./groqClient');
const Lead = require('../models/Lead');
const ScoreHistory = require('../models/ScoreHistory');
const Signal = require('../models/Signal');
const ICP = require('../models/ICP');

class ScoringService {
  /**
   * Scores a lead against an ICP and generates a Groq explanation.
   */
  static async compute(leadId) {
    try {
      const lead = await Lead.findById(leadId);
      if (!lead) throw new Error(`Lead not found: ${leadId}`);

      const icp = await ICP.getById(lead.icp_id);
      if (!icp) throw new Error(`ICP not found: ${lead.icp_id}`);

      const signals = await Signal.listByLead(leadId);

      // Each dimension is computed from real lead/signal/ICP data. Two of these
      // used to be constants (profile 50, recency 100), which collapsed every
      // lead onto the same total and made the analytics charts meaningless.
      const intent_score = this._intentScore(signals);
      const profile_fit_score = this._profileFitScore(lead, icp);
      const company_fit_score = this._companyFitScore(lead, icp);
      const recency_score = this._recencyScore(signals);
      const engagement_score = this._engagementScore(lead);

      // Weights: Intent 30%, Profile 25%, Company 20%, Recency 15%, Engagement 10%
      const total_score = Math.round(
        (intent_score * 0.30) +
        (profile_fit_score * 0.25) +
        (company_fit_score * 0.20) +
        (recency_score * 0.15) +
        (engagement_score * 0.10)
      );

      let tier = 'cold';
      if (total_score >= 70) tier = 'hot';
      else if (total_score >= 40) tier = 'warm';

      let explanation_text = `Computed score based on ${signals.length} signals and ICP match.`;

      // Explanations go through the shared paced client: a discovery run scores
      // well over a hundred leads, and unpaced per-lead calls exhaust Groq's
      // per-minute quota and lose the explanations entirely.
      if (GroqClient.availableFor('extraction')) {
        try {
          const explanation = await GroqClient.chat({
            system:
              'You are a B2B sales expert. In one short sentence, explain why this lead scores ' +
              `${total_score}/100 based on its signals and ICP match. No preamble.`,
            user: [
              `Company: ${lead.company_name}`,
              lead.company_industry ? `Industry: ${lead.company_industry}` : null,
              lead.company_location ? `Location: ${lead.company_location}` : null,
              `Signals (${signals.length}): ${signals.map(s => s.title).filter(Boolean).slice(0, 8).join('; ') || 'none'}`,
              `ICP: ${icp.name}`
            ].filter(Boolean).join('\n'),
            purpose: 'extraction',
            maxTokens: 80,
            temperature: 0.3,
            // Explanations are cosmetic; don't spend a long retry budget on them.
            attempts: 2
          });
          // Reasoning models may emit an internal <think> block; strip it.
          const clean = String(explanation || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
          if (clean) explanation_text = clean;
        } catch (groqErr) {
          logger.debug(`Score explanation unavailable for ${lead.company_name}: ${groqErr.message}`);
        }
      }

      const scoreId = uuidv4();
      const now = new Date().toISOString();

      // Upsert lead_scores
      const checkScore = query('SELECT id FROM lead_scores WHERE lead_id = ?', [leadId]);
      if (checkScore.rows.length > 0) {
        query(
          `UPDATE lead_scores 
           SET total_score=?, intent_score=?, profile_fit_score=?, company_fit_score=?, recency_score=?, engagement_score=?, tier=?, explanation_text=?, is_manual_override=0, scored_at=? 
           WHERE lead_id=?`,
          [total_score, intent_score, profile_fit_score, company_fit_score, recency_score, engagement_score, tier, explanation_text, now, leadId]
        );
      } else {
        query(
          `INSERT INTO lead_scores (id, lead_id, total_score, intent_score, profile_fit_score, company_fit_score, recency_score, engagement_score, tier, explanation_text, is_manual_override, scored_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
          [scoreId, leadId, total_score, intent_score, profile_fit_score, company_fit_score, recency_score, engagement_score, tier, explanation_text, now]
        );
      }

      await ScoreHistory.add(leadId, total_score);
      await Lead.updateScore(leadId, { status: 'scored' });

      return { total_score, tier, explanation_text };
    } catch (err) {
      logger.error(`Scoring failed for lead ${leadId}:`, err);
      throw err;
    }
  }

  /**
   * Intent (30%): what the signals say about active buying behaviour.
   * A hiring post for a target role is far stronger evidence than a passing
   * mention, so signals are weighted by type and by collector relevance rather
   * than merely counted.
   */
  static _intentScore(signals) {
    if (!signals || signals.length === 0) return 0;

    const weights = { job_posting: 34, news: 22, linkedin: 28, social: 16, web: 9, unknown: 5 };

    let score = 0;
    for (const signal of signals) {
      const base = weights[signal.signal_type] ?? weights.unknown;
      // relevance_score is 0-1 from the collector; treat 0.5 as neutral.
      const relevance = Number(signal.relevance_score);
      const multiplier = Number.isFinite(relevance) && relevance > 0 ? 0.6 + relevance * 0.8 : 1;
      score += base * multiplier;
    }

    return Math.min(100, Math.round(score));
  }

  /**
   * Profile fit (25%): how well the known contact matches the ICP's buyers,
   * plus how confident the extractor was about the company itself.
   */
  static _profileFitScore(lead, icp) {
    let score = 25;

    const jobTitles = parseList(icp.job_titles);
    const leadTitle = String(lead.contact_title || '').toLowerCase();
    if (leadTitle) {
      const exact = jobTitles.some(t => leadTitle.includes(String(t).toLowerCase()));
      if (exact) score += 35;
      else if (jobTitles.some(t => sharesSignificantToken(leadTitle, String(t)))) score += 20;
      else score += 8; // some contact is better than none
    }

    if (lead.contact_email) score += 15;
    if (lead.contact_name) score += 10;

    // The AI extractor records how strongly the company matched the ICP.
    const fit = readIcpFit(lead.raw_signal_data);
    if (fit === 'strong') score += 15;
    else if (fit === 'moderate') score += 8;

    return Math.min(100, Math.round(score));
  }

  /**
   * Company fit (20%): firmographic match on industry, size and geography.
   */
  static _companyFitScore(lead, icp) {
    let score = 20;

    const industries = parseList(icp.industries);
    const leadIndustry = String(lead.company_industry || '').toLowerCase();
    if (leadIndustry) {
      if (industries.some(i => leadIndustry.includes(String(i).toLowerCase()) ||
                               String(i).toLowerCase().includes(leadIndustry))) {
        score += 35;
      } else if (industries.some(i => sharesSignificantToken(leadIndustry, String(i)))) {
        score += 18;
      }
    }

    const size = Number(lead.company_size);
    const min = Number(icp.company_size_min) || 1;
    const max = Number(icp.company_size_max) || 5000;
    if (Number.isFinite(size) && size > 0) {
      if (size >= min && size <= max) score += 28; // sweet spot for conversion
      else if (size >= min / 2 && size <= max * 2) score += 12;
      else if (size >= 10000) score -= 25; // giants rarely convert cold
    } else {
      score += 10; // unknown size OK for startups
    }

    const geographies = parseList(icp.geographies);
    const location = String(lead.company_location || '').toLowerCase();
    if (location && geographies.some(g => location.includes(String(g).toLowerCase()))) {
      score += 25;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Recency (15%): how fresh the newest signal is. Buying intent decays, so an
   * untouched lead should not keep scoring as if it were discovered today.
   */
  static _recencyScore(signals) {
    if (!signals || signals.length === 0) return 20;

    let newest = 0;
    for (const signal of signals) {
      const at = new Date(signal.detected_at || signal.created_at || 0).getTime();
      if (Number.isFinite(at) && at > newest) newest = at;
    }
    if (!newest) return 20;

    const days = (Date.now() - newest) / 86400000;
    if (days <= 1) return 100;
    if (days <= 3) return 90;
    if (days <= 7) return 78;
    if (days <= 14) return 62;
    if (days <= 30) return 45;
    if (days <= 90) return 25;
    return 10;
  }

  /**
   * Engagement (10%): how actionable the lead is — can we contact anyone?
   */
  static _engagementScore(lead) {
    let score = 0;
    if (lead.contact_email) score += 40;
    if (lead.contact_name) score += 18;
    if (lead.contact_title) score += 15;
    if (lead.contact_phone) score += 12;
    if (lead.contact_linkedin) score += 15;
    if (lead.company_website) score += 8;
    if (score === 0) score = 5;
    return Math.min(100, score);
  }

  static async manualOverride(leadId, newScore, reason) {
    let tier = 'cold';
    if (newScore >= 70) tier = 'hot';
    else if (newScore >= 40) tier = 'warm';

    const now = new Date().toISOString();

    query(
      `UPDATE lead_scores 
       SET total_score=?, tier=?, explanation_text=?, is_manual_override=1, scored_at=? 
       WHERE lead_id=?`,
      [newScore, tier, `Manual override: ${reason}`, now, leadId]
    );
    await ScoreHistory.add(leadId, newScore);
  }
}

// Words too generic to imply a real match between an ICP term and a lead field.
const STOPWORDS = new Set([
  'the', 'and', 'of', 'for', 'in', 'on', 'at', 'to', 'a', 'an', 'services',
  'service', 'solutions', 'solution', 'technology', 'technologies', 'tech',
  'company', 'companies', 'group', 'global', 'international', 'head', 'chief',
  'officer', 'senior', 'lead', 'manager', 'director', 'vp', 'vice', 'president',
]);

function parseList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * True when two strings share a meaningful word, used for partial matches like
 * "Head of DevOps" against "DevOps Engineer".
 */
function sharesSignificantToken(a, b) {
  const tokens = str => new Set(
    String(str).toLowerCase().split(/[^a-z0-9]+/)
      .filter(t => t.length > 2 && !STOPWORDS.has(t))
  );
  const left = tokens(a);
  for (const token of tokens(b)) {
    if (left.has(token)) return true;
  }
  return false;
}

/**
 * The web extractor stores its ICP-fit verdict inside raw_signal_data, which
 * comes back from SQLite as a JSON string.
 */
function readIcpFit(rawSignalData) {
  if (!rawSignalData) return null;
  try {
    const parsed = typeof rawSignalData === 'string' ? JSON.parse(rawSignalData) : rawSignalData;
    return parsed?.icp_fit || null;
  } catch (e) {
    return null;
  }
}

module.exports = ScoringService;
