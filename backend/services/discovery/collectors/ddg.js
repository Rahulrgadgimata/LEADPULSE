const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const logger = require('../../../utils/logger');
const config = require('../../../config/env');
const scrapling = require('../../scraplingClient');

/**
 * Shared DuckDuckGo HTML-endpoint search used by WebScraper and JobScraper.
 *
 * Endpoint behaviour this module works around:
 *  1. A real browser User-Agent is required. A bot-style UA gets served an
 *     anti-bot CAPTCHA page (HTTP 202, "select all squares containing a duck")
 *     with zero result nodes in the DOM.
 *  2. Every outbound link is wrapped in a redirect
 *     (https://duckduckgo.com/l/?uddg=<url-encoded-target>), so the target has
 *     to be unwrapped before it can be used or domain-filtered.
 *  3. There is no working GET pagination — the `s=` offset returns the same
 *     first page. Volume therefore comes from many distinct queries, which is
 *     why one browser is reused across the whole discovery run.
 *  4. Quoted phrases return an empty result set, and OR-ing several `site:`
 *     terms trips the anti-bot page. Callers must keep queries plain.
 */

// Back-to-back requests get throttled into the anti-bot page, so requests are
// spaced by SCRAPER_DELAY_MS process-wide (collectors run in parallel).
let lastRequestAt = 0;

async function throttle() {
  const now = Date.now();
  // Claim the slot synchronously, before the first await, so concurrent
  // callers queue behind each other instead of all reading the same timestamp.
  const scheduled = Math.max(now, lastRequestAt + config.SCRAPER_DELAY_MS);
  lastRequestAt = scheduled;

  const wait = scheduled - now;
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}

// One browser per discovery run: launching Chromium costs ~1.5s, which would
// otherwise be paid on every one of ~25 queries.
let browserPromise = null;

async function getBrowser() {
  // Throwing rather than returning null keeps the guard in one place: every
  // caller already wraps this in a try that degrades to an empty result set.
  if (!config.SCRAPER_BROWSER_ENABLED) {
    throw new Error('browser fetch disabled (SCRAPER_BROWSER_ENABLED=false)');
  }

  if (browserPromise) {
    try {
      const existing = await browserPromise;
      if (existing.connected !== false) return existing;
      logger.warn('DDG browser was disconnected; relaunching.');
    } catch (err) {
      logger.warn(`DDG browser launch previously failed (${err.message}); retrying.`);
    }
    browserPromise = null;
  }

  browserPromise = puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
    ]
  });

  return browserPromise;
}

class DDG {
  /**
   * Set when the last search was served the anti-bot page rather than results.
   * Lets the caller tell "blocked" apart from "genuinely no matches".
   */
  static lastRequestWasBlocked = false;

  /**
   * Unwrap a DuckDuckGo /l/?uddg= redirect into the real destination URL.
   */
  static unwrap(href) {
    if (!href) return null;
    try {
      const target = new URL(href, 'https://duckduckgo.com').searchParams.get('uddg');
      return target || href;
    } catch (e) {
      return href;
    }
  }

  /**
   * Run a search and return [{ url, title, snippet }], redirects already
   * unwrapped and DuckDuckGo's own links removed. Never throws — a failed
   * search returns [] so one bad query cannot abort a discovery run.
   */
  static async search(searchQuery, limit = 10) {
    await throttle();

    // Scrapling first — DDG anti-bot pages often yield to TLS impersonation.
    try {
      const via = await scrapling.search(searchQuery, 'duckduckgo', limit);
      if (via.ok && via.results.length > 0) {
        DDG.lastRequestWasBlocked = false;
        logger.debug(`DDG Scrapling "${searchQuery}" -> ${via.results.length} (${via.mode})`);
        return via.results;
      }
      if (via.blocked) DDG.lastRequestWasBlocked = true;
    } catch (err) {
      logger.debug(`DDG Scrapling failed (${err.message}); falling back to Puppeteer`);
    }

    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;

    // Plain HTTP before Chromium. The html endpoint answers an ordinary GET
    // with a real browser User-Agent, and without this step DuckDuckGo produced
    // nothing at all wherever the browser is turned off — which is exactly the
    // memory-constrained deployment that needs every keyless source it can get.
    const viaHttp = await this._searchOverHttp(searchUrl, searchQuery, limit);
    if (viaHttp.length > 0) {
      DDG.lastRequestWasBlocked = false;
      return viaHttp;
    }

    let page;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      await page.setUserAgent(config.SCRAPER_USER_AGENT);

      // The results page needs no subresources; blocking them roughly halves
      // load time across a run of dozens of queries.
      await page.setRequestInterception(true);
      page.on('request', req => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
        else req.continue();
      });

      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

      const raw = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.result')).map(item => {
          const link = item.querySelector('.result__a') || item.querySelector('.result__url');
          const snippet = item.querySelector('.result__snippet');
          return {
            href: link ? link.getAttribute('href') : '',
            title: link ? link.innerText.trim() : '',
            snippet: snippet ? snippet.innerText.trim() : ''
          };
        });
      });

      if (raw.length === 0) {
        // Almost always the anti-bot page rather than a genuinely empty result set.
        const pageTitle = await page.title();
        DDG.lastRequestWasBlocked = true;
        logger.warn(`DDG returned no result nodes for "${searchQuery}" (page title: "${pageTitle}"). Possible anti-bot challenge.`);
        return [];
      }
      DDG.lastRequestWasBlocked = false;

      const results = [];
      for (const item of raw) {
        const url = this.unwrap(item.href);
        if (!url || url.includes('duckduckgo.com')) continue;
        results.push({ url, title: item.title, snippet: item.snippet });
        if (results.length >= limit) break;
      }

      logger.debug(`DDG search "${searchQuery}" -> ${results.length} usable results (${raw.length} raw)`);
      return results;
    } catch (err) {
      logger.warn(`DDG search failed for "${searchQuery}": ${err.message}`);
      return [];
    } finally {
      if (page) {
        try { await page.close(); } catch (e) { /* page already gone */ }
      }
    }
  }

  /**
   * Fetch and parse the HTML endpoint over plain HTTP. Never throws: an empty
   * result simply hands the query on to the Puppeteer path.
   */
  static async _searchOverHttp(searchUrl, searchQuery, limit) {
    try {
      const res = await axios.get(searchUrl, {
        timeout: 20000,
        maxRedirects: 3,
        responseType: 'text',
        headers: {
          'User-Agent': config.SCRAPER_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: 'https://duckduckgo.com/'
        },
        validateStatus: () => true
      });

      const html = typeof res.data === 'string' ? res.data : '';
      if (res.status >= 400 || !html) {
        DDG.lastRequestWasBlocked = true;
        return [];
      }

      const $ = cheerio.load(html);
      const results = [];

      $('.result, .web-result').each((_, el) => {
        if (results.length >= limit) return false;
        const $el = $(el);
        const link = $el.find('.result__a').first();
        const url = this.unwrap(link.attr('href'));
        if (!url || !/^https?:\/\//i.test(url) || url.includes('duckduckgo.com')) return;
        results.push({
          url,
          title: link.text().replace(/\s+/g, ' ').trim(),
          snippet: $el.find('.result__snippet').first().text().replace(/\s+/g, ' ').trim()
        });
      });

      if (results.length === 0) {
        // The anti-bot page has no result nodes either, so treat an empty parse
        // as a block and let the browser path try to get through.
        DDG.lastRequestWasBlocked = true;
        logger.debug(`DDG HTTP returned no results for "${searchQuery}" (status ${res.status}).`);
        return [];
      }

      logger.debug(`DDG HTTP "${searchQuery}" -> ${results.length} results`);
      return results;
    } catch (err) {
      logger.debug(`DDG HTTP failed for "${searchQuery}": ${err.message}`);
      return [];
    }
  }

  /**
   * Close the shared browser. Must be called once a discovery run finishes,
   * otherwise the Chromium process outlives the run.
   */
  static async shutdown() {
    if (!browserPromise) return;
    const pending = browserPromise;
    browserPromise = null;
    try {
      const browser = await pending;
      await browser.close();
      logger.debug('DDG shared browser closed.');
    } catch (err) {
      logger.warn(`DDG browser shutdown failed: ${err.message}`);
    }
  }
}

module.exports = DDG;
