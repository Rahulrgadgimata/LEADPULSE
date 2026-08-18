const logger = require('../../../utils/logger');
const config = require('../../../config/env');
const GroqClient = require('../../groqClient');
const { collectWithConcurrency } = require('../../../utils/concurrency');
const { isNonProspect, isMegaCorp } = require('./domainFilter');

/**
 * Turns raw scraped pages into structured company leads using Groq.
 *
 * Scraped search results are a mix of real companies, directories, listicles,
 * blogs and marketplaces. Deriving a lead from the domain alone produces junk
 * ("Wikipedia", "Themanifest"), so every candidate goes through the model with
 * an explicit rubric: classify what the page is, reject anything that is not an
 * operating company, and emit firmographics only when the page supports them.
 */
class EntityExtractor {
  /**
   * @param {Array<Object>} items - { url, domain, title, metaDescription, snippet, headings }
   * @param {Object} icp - ICP row (industries/geographies/job_titles are JSON strings)
   * @returns {Promise<Array<Object>>} structured leads, junk already dropped
   */
  static async extract(items, icp) {
    if (!items || items.length === 0) return [];

    if (!config.GROQ_API_KEY) {
      logger.warn('GROQ_API_KEY not set — cannot qualify candidates; falling back to conservative domain heuristics.');
      return items.map(item => this._fallbackLead(item)).filter(Boolean);
    }

    const batchSize = config.GROQ_BATCH_SIZE;
    const batches = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }

    logger.info(
      `EntityExtractor: classifying ${items.length} candidates in ${batches.length} Groq batches ` +
      `(pacing at ${config.GROQ_TPM_LIMIT} tokens/min)`
    );

    const leads = await collectWithConcurrency(
      batches,
      config.GROQ_CONCURRENCY,
      batch => this._extractBatch(batch, icp)
    );

    const viaGroq = leads.filter(l => l.raw_signal_data?.extracted_by === 'groq').length;
    logger.info(
      `EntityExtractor: ${leads.length} of ${items.length} candidates became leads ` +
      `(${viaGroq} AI-qualified, ${leads.length - viaGroq} heuristic)`
    );
    return leads;
  }

  static async _extractBatch(batch, icp) {
    const systemPrompt = this._systemPrompt(icp);
    const payload = this._payload(batch);

    let response;
    try {
      response = await this._callGroq(systemPrompt, payload);
    } catch (err) {
      logger.warn(`Groq extraction failed for a batch (${err.message}); applying conservative heuristics to ${batch.length} candidates.`);
      return batch.map(item => this._fallbackLead(item)).filter(Boolean);
    }

    const rows = response.companies || response.results || [];
    if (!Array.isArray(rows)) return [];

    const leads = [];
    for (const row of rows) {
      const index = Number(row.index);
      if (!Number.isInteger(index) || index < 0 || index >= batch.length) continue;

      const lead = this._normalize(row, batch[index], icp);
      if (lead) leads.push(lead);
    }

    return leads;
  }

  static _payload(batch) {
    return batch
      .map((item, idx) => {
        const parts = [`[${idx}] ${item.domain} | ${(item.title || '').slice(0, 110)}`];
        if (item.metaDescription) parts.push(`  desc: ${item.metaDescription.slice(0, 200)}`);
        else if (item.snippet) parts.push(`  snip: ${item.snippet.slice(0, 160)}`);
        if (item.headings) parts.push(`  h: ${item.headings.slice(0, 120)}`);
        return parts.join('\n');
      })
      .join('\n');
  }

  /**
   * The rubric.
   *
   * Phrasing matters more here than anywhere else in the pipeline: this prompt
   * decides whether the web-scrape source produces leads at all. The previous
   * version led with the ICP and framed the task as "qualify convertible
   * prospects", and the model read the combination of a narrow ICP and a long
   * DROP list as licence to reject everything — measured at 0 kept out of 5 on
   * a sample containing Razorpay, Cashfree and Zerodha, repeatably, on both
   * reasoning settings. The whole collector was returning zero leads because of
   * it.
   *
   * Two changes fix that, and the same sample then keeps exactly the three real
   * companies and drops the wiki and the listicle on every run:
   *
   *  - the question is "is this page a company's own site", not "is this
   *    prospect worth pitching". Fit is scored downstream by scoring.js, which
   *    has the full record; asking the model to pre-judge it here only lost
   *    leads that later stages were built to evaluate.
   *  - DROP is an explicit closed list, and keeping is stated as the normal
   *    outcome, so an item that matches nothing on the list is kept.
   *
   * It stays compact because it is re-sent with every batch and each line costs
   * tokens against the per-minute budget.
   */
  static _systemPrompt(icp) {
    const industries = this._parseList(icp.industries);
    const geographies = this._parseList(icp.geographies);
    const jobTitles = this._parseList(icp.job_titles);

    return `You classify scraped web pages. Each numbered item is one page. For every item, decide whether the page belongs to a real operating company a B2B sales rep could contact.

Context — the rep sells to: ${industries.join(', ') || 'B2B technology'} | geo: ${geographies.join(', ') || 'any'} | company size ${icp.company_size_min || 1}-${icp.company_size_max || 5000} | buyer titles: ${jobTitles.slice(0, 3).join(', ') || 'CTO'} | keywords: ${this._parseList(icp.keywords).slice(0, 8).join(', ') || 'none'}

KEEP an item when the page is a company's own site (product, pricing, customers, careers). Keep it even when it sits outside the size or geography above — fit is scored separately downstream. Most items in this list are real companies, so keeping is the normal outcome.
DROP an item ONLY when the page is clearly one of: a directory or "top N" listicle, a news article, a blog, a wiki/encyclopedia, a job board, a government site, or a company with 10000+ employees.

Output one object per KEPT item:
{"index":<n>,"name":"<company name only>","industry":"<specific>","location":"<City, Country or \\"\\">","employee_estimate":<int|null>,"description":"<what they sell — one sentence>","contact_title":"<buyer title from the list above>","icp_fit":"strong|moderate"}

Use the company's real name from the page, never a page title. Never invent a name — omit the item instead. employee_estimate null unless the page states it.
Return ONLY JSON: {"companies":[...]}`;
  }

  static async _callGroq(systemPrompt, userPayload) {
    return GroqClient.chatJson({
      system: systemPrompt,
      user: userPayload,
      purpose: 'extraction',
      // Reasoning models spend the output budget thinking before emitting the
      // JSON, and a truncated object fails Groq's structured-output validation
      // outright. Disabling reasoning cut a 12-item batch from ~4400 completion
      // tokens to ~430 with identical classifications, so the ceiling is only
      // a safety net for models that ignore the setting.
      reasoningEffort: config.GROQ_EXTRACTION_REASONING,
      maxTokens: 6000,
      expectedOutputTokens: 900,
      temperature: 0.1
    });
  }

  /**
   * Shape a model row into the lead fields the DB expects, discarding rows whose
   * name looks like a page title rather than a company.
   */
  static _normalize(row, item, icp) {
    let name = String(row.name || '').trim();
    if (!name) return null;

    name = name
      .replace(/\s*[|–—-]\s*(home|homepage|official site|official website).*$/i, '')
      .replace(/\s*\b(inc|llc|ltd|limited|corp|corporation|gmbh|pvt|private limited)\.?$/i, '')
      .trim();

    if (!this._isPlausibleCompanyName(name)) {
      logger.debug(`EntityExtractor rejected implausible name "${name}" for ${item.domain}`);
      return null;
    }

    if (isMegaCorp(name) || isMegaCorp(item.domain)) {
      logger.debug(`EntityExtractor skipped mega-corp ${name} (${item.domain})`);
      return null;
    }

    const employees = Number.isFinite(Number(row.employee_estimate)) && Number(row.employee_estimate) > 0
      ? Math.round(Number(row.employee_estimate))
      : null;

    // Giants by headcount — not convertible cold.
    if (employees && employees >= 10000) {
      logger.debug(`EntityExtractor skipped oversized company ${name} (${employees})`);
      return null;
    }

    const description = String(row.description || item.metaDescription || item.snippet || '').trim();

    const fitRaw = String(row.icp_fit || 'moderate').toLowerCase();
    // Keep moderate/weak as "moderate" — incomplete ICP evidence still converts
    // when the company is a real SMB/startup (giants already filtered above).
    const fit = fitRaw === 'strong' ? 'strong' : 'moderate';

    return {
      company_name: name,
      company_website: item.domain,
      company_industry: String(row.industry || this._parseList(icp.industries)[0] || '').trim() || null,
      company_location: String(row.location || '').trim() || null,
      company_size: employees,
      company_description: description ? description.slice(0, 1000) : null,
      contact_title: String(row.contact_title || this._parseList(icp.job_titles)[0] || '').trim() || null,
      source: 'WebScraper',
      source_url: item.url,
      raw_signal_data: {
        query: item.query,
        url: item.url,
        icp_fit: fit,
        extracted_by: 'groq'
      }
    };
  }

  /**
   * Reject titles and marketing copy that the model sometimes returns as a name.
   */
  static _isPlausibleCompanyName(name) {
    if (name.length < 2 || name.length > 60) return false;
    if (name.split(/\s+/).length > 6) return false;
    if (!/[a-z0-9]/i.test(name)) return false;
    if (GENERIC_NAMES.test(name)) return false;
    // Listicle/marketing leftovers.
    if (/\b(top \d+|best \d+|\d+ best|guide to|how to|vs\.?|review of|list of|companies in|services in)\b/i.test(name)) return false;
    return true;
  }

  /**
   * Used only when Groq is unavailable for a batch. Because nothing has
   * classified the page, this must stay conservative: it is better to lose a
   * lead than to fill the pipeline with directories and news sites, so anything
   * that does not clearly look like a company domain is dropped.
   */
  static _fallbackLead(item) {
    if (!item.domain || isNonProspect(item.domain)) return null;

    const base = item.domain.split('.')[0];
    if (!base || base.length < 3) return null;

    // Without model classification, an unreachable page is unverifiable.
    if (!item.fetched) return null;

    const text = `${item.title || ''} ${item.metaDescription || ''} ${item.snippet || ''}`;
    if (DIRECTORY_HINTS.test(text) || DIRECTORY_HINTS.test(item.domain)) {
      logger.debug(`Fallback dropped likely directory/media page: ${item.domain}`);
      return null;
    }

    const name = base.charAt(0).toUpperCase() + base.slice(1);
    if (!this._isPlausibleCompanyName(name)) return null;

    return {
      company_name: name,
      company_website: item.domain,
      company_industry: null,
      company_location: null,
      company_size: null,
      company_description: (item.metaDescription || item.snippet || '').slice(0, 1000) || null,
      contact_title: null,
      source: 'WebScraper',
      source_url: item.url,
      raw_signal_data: { query: item.query, url: item.url, extracted_by: 'fallback' }
    };
  }

  static _parseList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }
}

// Page-furniture words that are never a company name.
const GENERIC_NAMES = /^(home|homepage|about|about us|contact|contact us|welcome|login|sign in|index|untitled|error|page not found|community|forum|blog|news|careers|jobs|search|services|solutions|products|company|website|dashboard|portal|support|help)$/i;

// Wording typical of directories, rankings and news pages.
const DIRECTORY_HINTS = /\b(top \d+|best \d+|\d+ best|list of|directory|listings?|compare |reviews? of|ranking|rankings|marketplace|classifieds|find (?:the )?best|latest news|breaking news|press release|newsletter|magazine|blog post|wikipedia|encyclopedia)\b/i;

module.exports = EntityExtractor;
