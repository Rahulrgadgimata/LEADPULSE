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
   * Google Maps by rendering the search page.
   *
   * A second, independent route to Maps. SearchAPI returns cleaner structured
   * data and is tried first, but its credits are few; this runs on Firecrawl's
   * separate pool, so the two together roughly double how much Maps a month can
   * carry, and either can cover the other being exhausted.
   *
   * Rendering is required — the Maps page ships no results in its HTML and
   * fetches them afterwards, which is why plain HTTP and TLS impersonation both
   * come back empty. (Firecrawl cannot substitute for Google *web* search the
   * same way: that URL answers with a reCAPTCHA page. Use search() for it.)
   *
   * @returns {Promise<Array>} places in the same shape SearchApiClient.maps returns
   */
  static async maps(query) {
    if (!this.available) return [];

    const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`;
    const page = await this.scrape(url, { formats: ['markdown'], waitFor: 5000 });
    if (!page?.markdown) return [];

    return parseMapsMarkdown(page.markdown);
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

/**
 * Pull business records out of a rendered Maps page.
 *
 * Each result begins with a link to its /maps/place/ entry, and the lines that
 * follow carry the rating, the "type··address" pair, an hours line ending in
 * the phone number, and a Website link. Splitting on the place links keeps one
 * business per block, so a missing field never bleeds into the next record.
 */
function parseMapsMarkdown(markdown) {
  const blocks = String(markdown).split(/\[(?=[^\]]*\]\(https:\/\/www\.google\.com\/maps\/place\/)/);
  const places = [];
  const seen = new Set();

  for (const block of blocks) {
    const nameMatch = /^([^\]]{2,80})\]\(https:\/\/www\.google\.com\/maps\/place\//.exec(block);
    if (!nameMatch) continue;

    const title = nameMatch[1].replace(/\\/g, '').trim();
    if (!title || seen.has(title)) continue;

    const website = (/Website\]\((https?:\/\/[^)\s]+)\)/.exec(block) || [])[1] || '';
    // Skip Google's own links so a missing website is not read as a real one.
    if (/google\.com|gstatic\.com/i.test(website)) continue;

    const phone = (/\u00b7(\+?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\s*$/m.exec(block) ||
                   /(\(\d{3}\)\s?\d{3}-\d{4})/.exec(block) ||
                   /(\+\d[\d ]{7,15}\d)/.exec(block) || [])[1] || '';

    // "Software company··8900 Shoal Creek Blvd #127"
    const typeAddress = /^([^\u00b7\u2022\u2219\u22c5\u30fb\uff65\n]{3,60})[\u00b7\u2022\u2219\u22c5\u30fb\uff65]+([^\n]{5,120})$/m.exec(block);
    const rating = (/^(\d(?:\.\d)?)$/m.exec(block) || [])[1];
    const reviews = (/^\((\d[\d,]*)\)$/m.exec(block) || [])[1];

    seen.add(title);
    places.push({
      title,
      address: typeAddress ? typeAddress[2].replace(/^[^\p{L}\p{N}]+/u, '').trim() : '',
      city: '',
      phone: phone.trim(),
      website,
      domain: website ? website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] : '',
      rating: rating ? Number(rating) : undefined,
      reviews: reviews ? Number(reviews.replace(/,/g, '')) : undefined,
      type: typeAddress ? typeAddress[1].trim() : '',
      types: [],
      placeId: '',
      coordinates: null
    });
  }

  return places;
}

module.exports = FirecrawlClient;
