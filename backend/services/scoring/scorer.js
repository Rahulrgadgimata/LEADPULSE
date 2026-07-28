const { query } = require('../../config/database');
const { SCORING_WEIGHTS, TIERS, TIER_THRESHOLDS } = require('../../utils/constants');
const Signal = require('../../models/Signal');
const ScoreHistory = require('../../models/ScoreHistory');
const tierMapper = require('./tierMapper');
const logger = require('../../utils/logger');
const explainer = require('./explainer');

/**
 * AI Lead Scoring Engine
 * Implements the five-dimension scoring model:
 *   Intent signals (30%) + Profile fit (25%) + Company fit (20%) + Recency (15%) + Engagement (10%)
 * Output: single 0–100 score per lead + tier mapping
 */
class Scorer {
  /**
   * Score a single lead
   * @param {Object} lead - The lead to score
   * @param {Object} icp - The ICP to score against
   * @param {string} triggerEvent - What triggered this scoring
   * @returns {Object} Score breakdown
   */
  async scoreLead(lead, icp, triggerEvent = 'initial') {
    try {
      // Calculate each dimension (each returns 0–100)
      const intentScore = await this.calculateIntentScore(lead);
      const profileFitScore = this.calculateProfileFitScore(lead, icp);
      const companyFitScore = this.calculateCompanyFitScore(lead, icp);
      const recencyScore = this.calculateRecencyScore(lead);
      const engagementScore = this.calculateEngagementScore(lead);

      // Apply weights and compute total
      const totalScore = Math.round(
        intentScore * SCORING_WEIGHTS.INTENT +
        profileFitScore * SCORING_WEIGHTS.PROFILE_FIT +
        companyFitScore * SCORING_WEIGHTS.COMPANY_FIT +
        recencyScore * SCORING_WEIGHTS.RECENCY +
        engagementScore * SCORING_WEIGHTS.ENGAGEMENT
      );

      // Clamp to 0–100
      const clampedScore = Math.max(0, Math.min(100, totalScore));
      const tier = tierMapper.getTier(clampedScore);

      const scoreData = {
        total_score: clampedScore,
        intent_score: Math.round(intentScore),
        profile_fit_score: Math.round(profileFitScore),
        company_fit_score: Math.round(companyFitScore),
        recency_score: Math.round(recencyScore),
        engagement_score: Math.round(engagementScore),
        tier: tier,
      };

      // Generate Groq LLM / Fallback score explanation
      try {
        const explanation = await explainer.generateExplanation(lead, scoreData);
        scoreData.explanation_text = explanation;
      } catch (expErr) {
        logger.debug(`Score explainer notice for lead ${lead.id}: ${expErr.message}`);
        scoreData.explanation_text = `Calculated score of ${clampedScore}/100 based on buying intent signals and profile fit.`;
      }

      // Upsert score in lead_scores table
      await this.upsertScore(lead.id, scoreData);

      // Record in score history
      await ScoreHistory.record(lead.id, scoreData, triggerEvent);

      // Update lead status
      await query(
        "UPDATE leads SET status = 'scored', updated_at = NOW() WHERE id = $1",
        [lead.id]
      );

      logger.info(`Scored lead ${lead.id} (${lead.company_name}): ${clampedScore} [${tier}]`);
      return scoreData;
    } catch (err) {
      logger.error(`Scoring failed for lead ${lead.id}:`, err.message);
      throw err;
    }
  }

  /**
   * Score multiple leads (batch)
   */
  async scoreLeads(leads, icp, triggerEvent = 'initial') {
    const results = [];
    for (const lead of leads) {
      try {
        const score = await this.scoreLead(lead, icp, triggerEvent);
        results.push({ leadId: lead.id, success: true, score });
      } catch (err) {
        results.push({ leadId: lead.id, success: false, error: err.message });
      }
    }
    return results;
  }

  /**
   * DIMENSION 1: Intent Signals (30% weight)
   * Measures buying intent through job postings, news mentions, social signals, web mentions
   */
  async calculateIntentScore(lead) {
    let score = 0;

    try {
      const signals = await Signal.getByLead(lead.id).catch(() => []);
      const signalCounts = {};

      for (const signal of signals) {
        signalCounts[signal.signal_type] = (signalCounts[signal.signal_type] || 0) + 1;
      }

      // Job postings (strong intent signal)
      const jobPostings = signalCounts['job_posting'] || 0;
      if (jobPostings >= 3) score += 35;
      else if (jobPostings >= 1) score += 25;

      // News mentions
      const newsMentions = signalCounts['news_mention'] || 0;
      if (newsMentions >= 3) score += 25;
      else if (newsMentions >= 1) score += 18;

      // Social signals (pain point discussions)
      const socialPosts = signalCounts['social_post'] || 0;
      if (socialPosts >= 2) score += 20;
      else if (socialPosts >= 1) score += 15;

      // Web mentions
      const webMentions = signalCounts['web_mention'] || 0;
      if (webMentions >= 2) score += 20;
      else if (webMentions >= 1) score += 15;

      // Base intent score if lead was created via direct intent source
      if (signals.length === 0) {
        if (lead.source === 'job_board') score += 55;
        else if (lead.source === 'news') score += 45;
        else if (lead.source === 'social') score += 40;
        else if (lead.source === 'web_scrape') score += 35;
        else score += 30;
      }

      // Average relevance score from signals
      const avgRelevance = signals.length > 0
        ? signals.reduce((sum, s) => sum + (s.relevance_score || 0.75), 0) / signals.length
        : 0.75;
      score += Math.round(avgRelevance * 25);

    } catch (err) {
      logger.warn(`Intent score calculation error for lead ${lead.id}:`, err.message);
      score = 50;
    }

    return Math.min(Math.max(score, 25), 100);
  }

  /**
   * DIMENSION 2: Profile Fit (25% weight)
   * How well the contact's title/role matches the ICP's target job titles
   */
  calculateProfileFitScore(lead, icp) {
    let score = 0;

    const title = (lead.contact_title || 'CTO').toLowerCase();
    const targetTitles = (icp?.job_titles || ['CTO', 'VP of Engineering', 'Director of Infrastructure', 'DevOps Lead']).map(t => t.toLowerCase());

    // Exact match
    for (const target of targetTitles) {
      if (title === target) {
        score = 95;
        break;
      }
    }

    // Partial match (contains target)
    if (score === 0) {
      for (const target of targetTitles) {
        if (title.includes(target) || target.includes(title)) {
          score = 80;
          break;
        }
      }
    }

    // Seniority bonus
    if (score === 0) {
      const seniorTitles = ['ceo', 'cto', 'cfo', 'coo', 'vp', 'vice president', 'director', 'head of', 'chief', 'founder'];
      for (const senior of seniorTitles) {
        if (title.includes(senior)) {
          score = 70;
          break;
        }
      }
    }

    // Manager / Lead level
    if (score === 0) {
      const managerTitles = ['manager', 'lead', 'senior', 'principal', 'architect'];
      for (const mgr of managerTitles) {
        if (title.includes(mgr)) {
          score = 55;
          break;
        }
      }
    }

    // Default title fallback
    if (score === 0) {
      score = 45;
    }

    // Contact info completeness bonuses
    if (lead.contact_name) score = Math.min(score + 5, 100);
    if (lead.contact_email) score = Math.min(score + 10, 100);
    if (lead.contact_linkedin) score = Math.min(score + 5, 100);

    return Math.min(Math.max(score, 30), 100);
  }

  /**
   * DIMENSION 3: Company Fit (20% weight)
   * Industry, size, and geography match with ICP
   */
  calculateCompanyFitScore(lead, icp) {
    let score = 30; // Base baseline credit

    const leadIndustry = (lead.company_industry || 'B2B SaaS').toLowerCase();
    const targetIndustries = (icp?.industries || ['B2B SaaS', 'Cloud Computing', 'DevOps', 'Technology']).map(i => i.toLowerCase());

    for (const target of targetIndustries) {
      if (leadIndustry.includes(target) || target.includes(leadIndustry) || target === 'technology') {
        score += 35;
        break;
      }
    }

    // Company size match
    if (lead.company_size) {
      const sizeMin = icp?.company_size_min || 1;
      const sizeMax = icp?.company_size_max || 10000;

      if (lead.company_size >= sizeMin && lead.company_size <= sizeMax) {
        score += 25; // Perfect size match
      } else {
        score += 15;
      }
    } else {
      score += 15; // Unknown size
    }

    // Geography match
    const leadLocation = (lead.company_location || 'United States').toLowerCase();
    const targetGeos = (icp?.geographies || ['United States', 'Canada', 'Europe']).map(g => g.toLowerCase());

    for (const geo of targetGeos) {
      if (leadLocation.includes(geo) || geo.includes(leadLocation) || geo === 'united states') {
        score += 20;
        break;
      }
    }

    // Has website / description completeness
    if (lead.company_website) score += 5;
    if (lead.company_description) score += 5;

    return Math.min(Math.max(score, 35), 100);
  }

  /**
   * DIMENSION 4: Recency (15% weight)
   * How recent the signals are — exponential decay
   */
  calculateRecencyScore(lead) {
    const rawDate = lead?.discovery_timestamp || lead?.created_at;
    const discoveryDate = rawDate ? new Date(rawDate) : new Date();
    const validTime = isNaN(discoveryDate.getTime()) ? Date.now() : discoveryDate.getTime();
    const daysSinceDiscovery = Math.max(0, (Date.now() - validTime) / (1000 * 60 * 60 * 24));

    // Exponential decay: score drops by half every 14 days
    const halfLife = 14;
    const decayFactor = Math.pow(0.5, daysSinceDiscovery / halfLife);
    let score = Math.round(100 * decayFactor);

    // Bonus for very recent
    if (daysSinceDiscovery <= 1) score = 100;
    else if (daysSinceDiscovery <= 3) score = Math.max(score, 90);
    else if (daysSinceDiscovery <= 7) score = Math.max(score, 70);

    return Math.max(0, Math.min(100, score || 85));
  }

  /**
   * DIMENSION 5: Engagement History (10% weight)
   * Past interactions, email opens, replies
   * (In this phase, mostly based on status and notes)
   */
  calculateEngagementScore(lead) {
    let score = 0;

    // Lead status progression
    switch (lead.status) {
      case 'accepted': score += 80; break;
      case 'reviewed': score += 50; break;
      case 'scored': score += 20; break;
      case 'new': score += 10; break;
      default: score += 5;
    }

    // Has user notes (manual engagement)
    if (lead.user_notes) score += 15;

    // Was manually overridden (user engaged with this lead)
    if (lead.is_manual_override) score += 10;

    return Math.min(score, 100);
  }

  /**
   * Upsert score in lead_scores table
   */
  async upsertScore(leadId, scoreData) {
    const sql = `
      INSERT INTO lead_scores (lead_id, total_score, intent_score, profile_fit_score,
        company_fit_score, recency_score, engagement_score, tier)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (lead_id) DO UPDATE SET
        total_score = $2, intent_score = $3, profile_fit_score = $4,
        company_fit_score = $5, recency_score = $6, engagement_score = $7,
        tier = $8, scored_at = NOW(), updated_at = NOW()
      RETURNING *
    `;
    const result = await query(sql, [
      leadId, scoreData.total_score, scoreData.intent_score,
      scoreData.profile_fit_score, scoreData.company_fit_score,
      scoreData.recency_score, scoreData.engagement_score,
      scoreData.tier,
    ]);
    return result.rows[0];
  }

  /**
   * Apply manual score override
   */
  async overrideScore(leadId, newScore, reason) {
    const tier = tierMapper.getTier(newScore);

    const sql = `
      UPDATE lead_scores SET
        total_score = $1, tier = $2, is_manual_override = true,
        override_reason = $3, updated_at = NOW()
      WHERE lead_id = $4
      RETURNING *
    `;
    const result = await query(sql, [newScore, tier, reason, leadId]);

    if (result.rows[0]) {
      await ScoreHistory.record(leadId, {
        ...result.rows[0],
        total_score: newScore,
        tier,
      }, 'manual_override');
    }

    return result.rows[0];
  }
}

module.exports = new Scorer();
