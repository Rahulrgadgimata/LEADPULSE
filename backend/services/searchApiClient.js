const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const providerHealth = require('./providerHealth');

/**
 * SearchAPI.io — https://www.searchapi.io
 *
 * The one provider here that reaches Google *and* Google Maps. Maps is why it
 * earns its place: it returns operating local businesses with a name, street
 * address, phone number and website, all inside the city that was asked for.
 * Every other source in this app returns web pages that then have to be
 * classified, geolocated and mined for a contact, and most fail at one of those
 * steps — which is what left runs returning a handful of leads with no phone
 * numbers at all.
 *
 * Credits are finite and small (98 on the account this was built against), so
 * spending is capped per run and the cheap keyless sources still do the bulk of
 * the work. A credit is only worth spending where nothing free can substitute:
 * Maps, and Google for LinkedIn queries.
 */

const ENDPOINT = 'https://www.searchapi.io/api/v1/search';

// Credits spent in the current discovery run, reset by resetRunBudget().
let spentThisRun = 0;

class SearchApiClient {
  static get configured() {
    return Boolean(config.SEARCHAPI_KEY);
  }

  static get available() {
    return this.configured && !providerHealth.isDisabled('searchapi');
  }

  /** Called at the start of every run so one run cannot drain the account. */
  static resetRunBudget() {
    spentThisRun = 0;
  }

  static get spent() {
    return spentThisRun;
  }

  static budgetLeft() {
    return Math.max(0, config.SEARCHAPI_MAX_QUERIES_PER_RUN - spentThisRun);
  }

  static describe() {
    if (!this.configured) return { configured: false };
    return {
      configured: true,
      spentThisRun,
      perRunBudget: config.SEARCHAPI_MAX_QUERIES_PER_RUN,
      disabledReason: providerHealth.reasonFor('searchapi') || null
    };
  }

  /**
   * One API call, guarded by the per-run credit budget.
   * @returns {Promise<Object|null>} raw payload, or null when unavailable
   */
  static async _call(engine, params) {
    if (!this.available) return null;

    if (this.budgetLeft() <= 0) {
      logger.debug(`SearchAPI budget for this run is spent (${spentThisRun} queries); skipping ${engine}.`);
      return null;
    }

    spentThisRun++;

    try {
      const res = await axios.get(ENDPOINT, {
        params: { engine, api_key: config.SEARCHAPI_KEY, ...params },
        timeout: config.SEARCHAPI_TIMEOUT_MS
      });
      return res.data || null;
    } catch (err) {
      const parked = providerHealth.noteFailure('searchapi', err, {
        quotaPatterns: [/credit/i, /quota/i, /plan/i]
      });
      if (!parked) {
        logger.warn(`SearchAPI ${engine} failed: ${err.response?.status || err.code}: ${err.message}`);
      }
      return null;
    }
  }

  /**
   * Google web search, in the { url, title, snippet } shape Search.run merges.
   */
  static async search(query, limit = 10) {
    const data = await this._call('google', { q: query, num: Math.min(limit, 20) });
    if (!data) return [];

    return (data.organic_results || [])
      .map(r => ({ url: r.link || '', title: r.title || '', snippet: r.snippet || '' }))
      .filter(r => /^https?:\/\//i.test(r.url));
  }

  /**
   * Google Maps local search.
   *
   * The place belongs in the query text, not in a `location` parameter: the
   * engine ignores that parameter outright (it echoes back null and answers
   * from wherever it pleases — asking for New York returned California and
   * Arizona businesses). "software company in New York, NY" returns twenty
   * New York companies, nineteen of them with a phone number.
   *
   * @param {string} query e.g. "software company in New York, NY"
   * @returns {Promise<Array>} places with address, phone, website and rating
   */
  static async maps(query) {
    const data = await this._call('google_maps', { q: query });
    if (!data) return [];

    const places = data.local_results || data.place_results || [];
    if (!Array.isArray(places)) return [];

    return places.map(p => ({
      title: p.title || '',
      address: p.address || '',
      city: p.city || '',
      phone: p.phone || '',
      website: p.website || '',
      domain: p.domain || '',
      rating: p.rating,
      reviews: p.reviews,
      type: p.type || '',
      types: Array.isArray(p.types) ? p.types : [],
      placeId: p.place_id || '',
      coordinates: p.gps_coordinates || null
    }));
  }
}

module.exports = SearchApiClient;
