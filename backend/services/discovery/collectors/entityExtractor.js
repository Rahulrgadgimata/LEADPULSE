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
   * The rubric. Deliberately compact: it is re-sent with every batch, so each
   * extra line costs tokens against the per-minute budget. The failure mode it
   * exists to prevent is the model inventing a company for a directory page.
   */
  static _systemPrompt(icp) {
    const industries = this._parseList(icp.industries);
    const geographies = this._parseList(icp.geographies);
    const jobTitles = this._parseList(icp.job_titles);

    return `Qualify scraped pages as CONVERTIBLE B2B sales prospects (startups, SMBs, mid-market).

ICP: ${industries.join(', ') || 'B2B technology'} | geo: ${geographies.join(', ') || 'any'} | size ${icp.company_size_min || 1}-${icp.company_size_max || 5000} | buyers: ${jobTitles.slice(0, 3).join(', ') || 'CTO'}
Keywords: ${this._parseList(icp.keywords).slice(0, 8).join(', ') || 'none'}

KEEP: one real operating company a sales rep can pitch and close — preferably startup / SME / scale-up within ICP size. Incomplete firmographics are OK if it is clearly a real company in the niche (mark icp_fit "moderate").
DROP: directories, listicles, news, blogs, wikis, job boards, government bodies, AND mega-giants (Google, Microsoft, Amazon, Meta, IBM, Oracle, Salesforce, Infosys, TCS, Wipro, Accenture, Deloitte, etc.) — those do not convert from cold outbound.
Prefer companies with product, customers, hiring or funding signals.

For each KEPT page:
{"index":<n>,"name":"<company name only>","industry":"<specific>","location":"<City, Country or \\"\\">","employee_estimate":<int|null>,"description":"<what they sell — one sentence>","contact_title":"<ICP buyer title>","icp_fit":"strong|moderate"}

Never invent a name — omit instead. employee_estimate null unless stated.
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
