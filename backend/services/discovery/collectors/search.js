const axios = require('axios');
const logger = require('../../../utils/logger');
const config = require('../../../config/env');
const BraveScrape = require('./braveScrape');
const GoogleScrape = require('./googleScrape');
const BingScrape = require('./bingScrape');
const DDG = require('./ddg');

/**
 * Multi-source web search — every provider runs, results are merged.
 *
 * Always: Brave scrape + Bing scrape + DuckDuckGo (no keys required).
 * Also: Serper (Google API) + Brave API when keyed.
 *
 * Keyless Google is opt-in (SEARCH_ENABLE_GOOGLE) rather than default. It
 * answers a discovery run's query volume with 429 /sorry interstitials, and
 * each attempt cost ~13s across three fallback paths — about half of total
 * search time — while contributing zero results.
 */

let consecutiveBlocks = 0;
let abortedForRun = false;

/**
 * Per-source block tracking, so one throttled engine stops taxing every
 * remaining query.
 *
 * Brave falls back to Puppeteer when Cloudflare answers 429, which costs ~20s
 * and still returns nothing. Repeated across a 60-query run that is 20 minutes
 * of pure latency for zero results, and it was enough to stall a job outright.
 * After a few consecutive blocks a source sits out a cooldown; the others keep
 * running, and it is retried once the cooldown expires.
 */
const health = new Map();

function sourceHealth(name) {
  if (!health.has(name)) health.set(name, { blocks: 0, skipUntil: 0, skipped: 0 });
  return health.get(name);
}

function isResting(name) {
  return Date.now() < sourceHealth(name).skipUntil;
}

function recordOutcome(name, blocked) {
  const state = sourceHealth(name);
  if (!blocked) {
    state.blocks = 0;
    state.skipUntil = 0;
    return;
  }
  state.blocks++;
  if (state.blocks >= config.SEARCH_SOURCE_COOLDOWN_AFTER) {
    state.skipUntil = Date.now() + config.SEARCH_SOURCE_COOLDOWN_MS;
    state.blocks = 0;
    logger.warn(
      `Search source ${name} is throttling; resting it for ` +
      `${Math.round(config.SEARCH_SOURCE_COOLDOWN_MS / 1000)}s while the others continue.`
    );
  }
}

function normalise(results, limit) {
  const out = [];
  const seen = new Set();
  for (const r of results) {
    if (!r || !r.url) continue;
    let host;
    try { host = new URL(r.url).hostname; } catch (e) { continue; }
    if (/duckduckgo\.com|bing\.com|google\.|brave\.com|search\.brave/i.test(host)) continue;
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({ url: r.url, title: r.title || '', snippet: r.snippet || '' });
    if (out.length >= limit) break;
  }
  return out;
}

async function serperSearch(query, limit) {
  const res = await axios.post(
    'https://google.serper.dev/search',
    { q: query, num: Math.min(limit, 20) },
    {
      headers: { 'X-API-KEY': config.SERPER_API_KEY, 'Content-Type': 'application/json' },
      timeout: 20000
    }
  );
  return (res.data?.organic || []).map(o => ({
    url: o.link,
    title: o.title || '',
    snippet: o.snippet || ''
  }));
}

async function braveApiSearch(query, limit) {
  const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
    params: { q: query, count: Math.min(limit, 20) },
    headers: { 'X-Subscription-Token': config.BRAVE_API_KEY, Accept: 'application/json' },
    timeout: 20000
  });
  return (res.data?.web?.results || []).map(o => ({
    url: o.url,
    title: o.title || '',
    snippet: o.description || ''
  }));
}

class Search {
  static resetBlockState() {
    consecutiveBlocks = 0;
    abortedForRun = false;
    health.clear();
  }

  static get aborted() {
    return abortedForRun;
  }

  static get providerName() {
    const parts = ['brave-scrape', 'bing-scrape', 'duckduckgo'];
    if (config.SEARCH_ENABLE_GOOGLE) parts.push('google-scrape');
    if (config.BRAVE_API_KEY) parts.unshift('brave-api');
    if (config.SERPER_API_KEY) parts.unshift('serper-google');
    return parts.join('+');
  }

  static async run(query, limit = 10) {
    if (abortedForRun) return [];

    const perSource = Math.min(Math.max(limit, 10), 20);
    const linkedInQuery = /linkedin\.com/i.test(query);

    // LinkedIn pages are almost only useful from Google (or Serper). Bing/Brave
    // for these queries return login hubs, job boards, or unrelated AI cert pages.
    if (linkedInQuery) {
      return this._runLinkedInSearch(query, limit, perSource);
    }

    const sources = [
      {
        name: 'brave-scrape',
        run: () => BraveScrape.search(query, perSource),
        wasBlocked: () => BraveScrape.lastRequestWasBlocked
      },
      {
        name: 'bing-scrape',
        run: () => BingScrape.search(query, perSource),
        wasBlocked: () => BingScrape.lastRequestWasBlocked
      },
      {
        name: 'duckduckgo',
        run: () => DDG.search(query, perSource),
        wasBlocked: () => DDG.lastRequestWasBlocked
      }
    ];

    if (config.SEARCH_ENABLE_GOOGLE) {
      sources.push({
        name: 'google-scrape',
        run: () => GoogleScrape.search(query, perSource),
        wasBlocked: () => GoogleScrape.lastRequestWasBlocked
      });
    }

    if (config.BRAVE_API_KEY) {
      sources.unshift({
        name: 'brave-api',
        run: () => braveApiSearch(query, perSource),
        wasBlocked: () => false
      });
    }

    if (config.SERPER_API_KEY) {
      sources.unshift({
        name: 'serper-google',
        run: () => serperSearch(query, perSource),
        wasBlocked: () => false
      });
    }

    return this._mergeSources(query, limit, perSource, sources);
  }

  /**
   * LinkedIn discovery path — Google (and Serper if keyed) only.
   */
  static async _runLinkedInSearch(query, limit, perSource) {
    const sources = [];
    if (config.SERPER_API_KEY) {
      sources.push({
        name: 'serper-google',
        run: () => serperSearch(query, perSource),
        wasBlocked: () => false
      });
    }
    sources.push({
      name: 'google-scrape',
      run: () => GoogleScrape.search(query, perSource),
      wasBlocked: () => GoogleScrape.lastRequestWasBlocked
    });
    return this._mergeSources(query, limit, perSource, sources);
  }

  static async _mergeSources(query, limit, perSource, sources) {
    // A resting source is neither run nor counted against the abort threshold:
    // it is known-throttled, not evidence that this query found nothing.
    const active = sources.filter(s => !isResting(s.name));
    if (active.length === 0) {
      logger.debug(`Search "${query}" skipped: every source is in cooldown.`);
      return [];
    }

    const settled = await Promise.allSettled(active.map(s => s.run()));

    const merged = [];
    const perSourceCounts = {};
    let anySuccess = false;
    let allBlocked = true;

    settled.forEach((result, i) => {
      const name = active[i].name;
      if (result.status === 'fulfilled') {
        const items = result.value || [];
        perSourceCounts[name] = items.length;
        if (items.length > 0) {
          anySuccess = true;
          allBlocked = false;
          recordOutcome(name, false);
        } else {
          const blocked = active[i].wasBlocked();
          recordOutcome(name, blocked);
          if (!blocked) allBlocked = false;
        }
        merged.push(...items);
      } else {
        perSourceCounts[name] = 0;
        recordOutcome(name, true);
        logger.warn(`Search source ${name} failed for "${query}": ${result.reason?.message || result.reason}`);
      }
    });

    if (!anySuccess && allBlocked) {
      consecutiveBlocks++;
      if (consecutiveBlocks >= config.SEARCH_BLOCK_ABORT_THRESHOLD) {
        abortedForRun = true;
        logger.error(
          `Web search abandoned after ${consecutiveBlocks} consecutive all-source blocks. ` +
          `Optional: set SERPER_API_KEY (Google results API) for reliable volume.`
        );
      }
    } else if (anySuccess) {
      consecutiveBlocks = 0;
    }

    const combinedLimit = Math.min(perSource * active.length, 50);
    const out = normalise(merged, Math.max(limit, combinedLimit));
    logger.debug(
      `Search "${query}" merged ${out.length} urls from ${JSON.stringify(perSourceCounts)}`
    );
    return out.slice(0, Math.max(limit, 15));
  }
}

module.exports = Search;
