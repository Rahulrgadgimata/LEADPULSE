const axios = require('axios');
const config = require('../../config/env');
const { getRedis } = require('../../config/redis');
const logger = require('../../utils/logger');

/**
 * AI Score Explainer Service
 * Supports Groq API (ultra-fast Llama-3) and Claude API
 * Produces 2–3 sentence plain-language explanations of why a lead got its score
 */
class ScoreExplainer {
  constructor() {
    this.groqUrl = 'https://api.groq.com/openai/v1/chat/completions';
    this.claudeUrl = 'https://api.anthropic.com/v1/messages';
    this.cachePrefix = 'score_explanation:';
    this.cacheTTL = 86400; // 24 hours
  }

  /**
   * Generate a score explanation for a lead
   * @param {Object} lead - Lead data
   * @param {Object} scoreData - Score breakdown
   * @returns {string} Explanation text
   */
  async generateExplanation(lead, scoreData) {
    // Check cache first
    const cacheKey = `${this.cachePrefix}${lead.id}:${scoreData.total_score}`;
    try {
      const redis = getRedis();
      if (redis && redis.status === 'ready') {
        const cached = await redis.get(cacheKey);
        if (cached) {
          logger.debug(`Score explanation cache hit for lead ${lead.id}`);
          return cached;
        }
      }
    } catch {
      // Redis not available, skip cache
    }

    const prompt = this.buildPrompt(lead, scoreData);
    let explanation = null;

    // 1. Try Groq API first if configured
    if (config.groq.apiKey) {
      explanation = await this.callGroqAPI(prompt, lead.id);
    }

    // 2. Fallback to Claude API if Groq fails or is not configured
    if (!explanation && config.claude.apiKey) {
      explanation = await this.callClaudeAPI(prompt, lead.id);
    }

    // 3. Fallback to rule-based explanation generator
    if (!explanation) {
      explanation = this.generateFallbackExplanation(lead, scoreData);
    }

    // Cache the result if Redis is ready
    try {
      const redis = getRedis();
      if (redis && redis.status === 'ready') {
        await redis.setex(cacheKey, this.cacheTTL, explanation);
      }
    } catch {
      // Cache write failed, continue
    }

    // Update the explanation in lead_scores table
    try {
      const { query: dbQuery } = require('../../config/database');
      await dbQuery(
        'UPDATE lead_scores SET explanation_text = $1 WHERE lead_id = $2',
        [explanation, lead.id]
      );
    } catch (err) {
      logger.warn(`Could not update lead_scores in DB: ${err.message}`);
    }

    logger.info(`Generated explanation for lead ${lead.id}`);
    return explanation;
  }

  /**
   * Call Groq API (OpenAI-compatible)
   */
  async callGroqAPI(prompt, leadId) {
    try {
      const response = await axios.post(
        this.groqUrl,
        {
          model: config.groq.model,
          messages: [
            {
              role: 'system',
              content: 'You are a concise B2B sales intelligence AI. Generate 2-3 sentence score explanations for sales reps.'
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          max_tokens: 200,
          temperature: 0.5,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.groq.apiKey}`,
          },
          timeout: 15000,
        }
      );

      const text = response.data?.choices?.[0]?.message?.content;
      if (text) {
        logger.info(`Groq API explanation generated for lead ${leadId}`);
        return text.trim();
      }
    } catch (err) {
      logger.error(`Groq API error for lead ${leadId}:`, err.response?.data || err.message);
    }
    return null;
  }

  /**
   * Call Claude API
   */
  async callClaudeAPI(prompt, leadId) {
    try {
      const response = await axios.post(
        this.claudeUrl,
        {
          model: config.claude.model,
          max_tokens: 200,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.claude.apiKey,
            'anthropic-version': '2023-06-01',
          },
          timeout: 30000,
        }
      );

      const text = response.data?.content?.[0]?.text;
      if (text) {
        logger.info(`Claude API explanation generated for lead ${leadId}`);
        return text.trim();
      }
    } catch (err) {
      logger.error(`Claude API error for lead ${leadId}:`, err.message);
    }
    return null;
  }

  /**
   * Build the score explanation prompt
   */
  buildPrompt(lead, scoreData) {
    return `Generate a short score explanation card (2-3 sentences max) for this B2B lead. Focus on the top 2-3 reasons for the score. Write in plain, professional language as if briefing a sales rep.

Lead Data:
- Company: ${lead.company_name}
- Industry: ${lead.company_industry || 'Unknown'}
- Size: ${lead.company_size || 'Unknown'} employees
- Contact: ${lead.contact_name || 'Unknown'} (${lead.contact_title || 'Unknown title'})
- Location: ${lead.company_location || 'Unknown'}
- Source: ${lead.source}

Score Breakdown (each out of 100):
- Total Score: ${scoreData.total_score}/100 (Tier: ${scoreData.tier})
- Intent Signals: ${scoreData.intent_score}/100 (30% weight)
- Profile Fit: ${scoreData.profile_fit_score}/100 (25% weight)
- Company Fit: ${scoreData.company_fit_score}/100 (20% weight)
- Recency: ${scoreData.recency_score}/100 (15% weight)
- Engagement: ${scoreData.engagement_score}/100 (10% weight)

Write 2-3 concise sentences explaining the top reasons for this score. Be specific to this lead's data. Do not mention the weights or percentages.`;
  }

  /**
   * Generate a fallback explanation when AI APIs are unavailable
   */
  generateFallbackExplanation(lead, scoreData) {
    const reasons = [];

    const dimensions = [
      { name: 'intent signals', score: scoreData.intent_score, weight: 0.30 },
      { name: 'profile fit', score: scoreData.profile_fit_score, weight: 0.25 },
      { name: 'company fit', score: scoreData.company_fit_score, weight: 0.20 },
      { name: 'recency', score: scoreData.recency_score, weight: 0.15 },
      { name: 'engagement', score: scoreData.engagement_score, weight: 0.10 },
    ].sort((a, b) => (b.score * b.weight) - (a.score * a.weight));

    const top = dimensions[0];
    const second = dimensions[1];

    if (top.score >= 70) {
      reasons.push(`Strong ${top.name} score indicates high potential.`);
    } else if (top.score >= 40) {
      reasons.push(`Moderate ${top.name} suggests some potential.`);
    } else {
      reasons.push(`Low ${top.name} — needs more data.`);
    }

    if (second.score >= 50) {
      reasons.push(`Good ${second.name} adds confidence.`);
    }

    if (lead.source === 'job_board') {
      reasons.push(`Discovered through job postings, indicating potential buying intent.`);
    } else if (lead.source === 'news') {
      reasons.push(`Recent news mentions suggest growing market activity.`);
    }

    return reasons.slice(0, 3).join(' ');
  }

  /**
   * Batch generate explanations for multiple leads
   */
  async batchGenerateExplanations(leadsWithScores, delayMs = 300) {
    const results = [];

    for (const { lead, scoreData } of leadsWithScores) {
      try {
        const explanation = await this.generateExplanation(lead, scoreData);
        results.push({ leadId: lead.id, explanation, success: true });
      } catch (err) {
        results.push({ leadId: lead.id, error: err.message, success: false });
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    return results;
  }
}

module.exports = new ScoreExplainer();
