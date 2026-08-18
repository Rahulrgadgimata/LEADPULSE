const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const providerHealth = require('./providerHealth');

/**
 * Firecrawl — https://github.com/firecrawl/firecrawl
 *
 * Two things this app cannot do reliably on its own:
 *
 *  search  Google refuses a datacenter IP. Every keyless route was measured
 *          and none survives: direct scraping answers /sorry, and twelve public
 *          SearXNG instances returned 429 or had their JSON API disabled.
 *          Firecrawl's /search is Google-backed and answers over HTTPS with a
 *          key, so it is the one path that works from Render.
 *  scrape  Pages behind Cloudflare or rendered entirely in JavaScript return
 *          nothing to axios and nothing to TLS impersonation. Firecrawl runs a
 *          real browser on its own infrastructure — no memory cost here, which
 *          is what makes it usable on a 512Mi instance.
 *
 * Entirely optional. Without FIRECRAWL_API_KEY every method reports "not
 * configured" and the existing keyless collectors carry the run exactly as
 * before. FIRECRAWL_API_URL points at a self-hosted deployment instead.
 */

const SEARCH_PATH = '/v1/search';
const SCRAPE_PATH = '/v1/scrape';

function baseUrl() {
  return String(config.FIRECRAWL_API_URL || 'https://api.firecrawl.dev').replace(/\/$/, '');
}

function headers() {
  return {
    Authorization: `Bearer ${config.FIRECRAWL_API_KEY}`,
    'Content-Type': 'application/json'
  };
}

class FirecrawlClient {
  static get available() {
    return Boolean(config.FIRECRAWL_API_KEY) && !providerHealth.isDisabled('firecrawl');
  }

  static describe() {
    if (!config.FIRECRAWL_API_KEY) return { configured: false };
    return {
      configured: true,
      endpoint: baseUrl(),
      disabledReason: providerHealth.reasonFor('firecrawl') || null
    };
  }

  /**
   * Web search. Returns [{ url, title, snippet }] — the same shape the other
   * search sources produce, so Search.run can merge it without special casing.
   */
  static async search(query, limit = 10) {
    if (!this.available) return [];

    try {
      const res = await axios.post(
        `${baseUrl()}${SEARCH_PATH}`,
        { query, limit: Math.min(Math.max(limit, 1), 20) },
        { headers: headers(), timeout: config.FIRECRAWL_TIMEOUT_MS }
      );

      // v1 returns { success, data: [...] }; a self-hosted build may return the
      // array directly, so accept both rather than silently yielding nothing.
      const rows = Array.isArray(res.data) ? res.data : (res.data?.data || res.data?.results || []);
      if (!Array.isArray(rows)) return [];

      return rows
        .map(r => ({
          url: r.url || r.link || '',
          title: r.title || '',
          snippet: r.description || r.snippet || r.markdown?.slice(0, 200) || ''
        }))
        .filter(r => /^https?:\/\//i.test(r.url));
    } catch (err) {
      this._noteFailure('search', query, err);
      return [];
    }
  }

  /**
   * Render a page and return its HTML. Used only after the cheap fetchers have
   * failed, because every call spends credits from a finite plan.
   *
   * @returns {Promise<{html: string, markdown: string, finalUrl: string}|null>}
   */
  static async scrape(url, { formats = ['html'], waitFor } = {}) {
    if (!this.available) return null;

    try {
      const res = await axios.post(
        `${baseUrl()}${SCRAPE_PATH}`,
        {
          url,
          formats,
          onlyMainContent: false,
          ...(waitFor ? { waitFor } : {})
        },
        { headers: headers(), timeout: config.FIRECRAWL_TIMEOUT_MS }
      );

      const data = res.data?.data || res.data;
      if (!data) return null;

      const html = data.html || data.rawHtml || '';
      const markdown = data.markdown || '';
      if (!html && !markdown) return null;

      return {
        html,
        markdown,
        finalUrl: data.metadata?.sourceURL || data.metadata?.url || url
      };
    } catch (err) {
      this._noteFailure('scrape', url, err);
      return null;
    }
  }

  /**
   * Credit exhaustion and a bad key both mean "stop calling this"; a timeout
   * on one page does not.
   */
  static _noteFailure(kind, subject, err) {
    const parked = providerHealth.noteFailure('firecrawl', err, {
      quotaPatterns: [/insufficient credits/i, /payment required/i, /token limit/i]
    });
    if (!parked) {
      logger.debug(
        `Firecrawl ${kind} failed for "${String(subject).slice(0, 60)}": ` +
        `${err.response?.status || err.code || err.message}`
      );
    }
  }
}

module.exports = FirecrawlClient;
