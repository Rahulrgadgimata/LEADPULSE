const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const logger = require('../../../utils/logger');
const config = require('../../../config/env');
const scrapling = require('../../scraplingClient');

/**
 * Keyless Google Search scrape — public results from google.com/search.
 *
 * Google rate-limits aggressively; this is best-effort and runs alongside
 * Brave + DuckDuckGo so discovery still works when Google challenges us.
 */

let lastRequestAt = 0;
let browserPromise = null;

async function throttle() {
  const now = Date.now();
  // Google needs more spacing than DDG/Brave.
  const delay = Math.max(config.SCRAPER_DELAY_MS, 3500);
  const scheduled = Math.max(now, lastRequestAt + delay);
  lastRequestAt = scheduled;
  const wait = scheduled - now;
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}

async function getBrowser() {
  if (browserPromise) {
    try {
      const existing = await browserPromise;
      if (existing.connected !== false) return existing;
    } catch (err) {
      logger.warn(`Google scraper browser relaunch (${err.message})`);
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
      '--disable-blink-features=AutomationControlled',
    ]
  });
  return browserPromise;
}

function parseHtml(html, limit) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  // Classic organic result blocks.
  const nodes = $('#search .g, div.g, div[data-sokoban-container] .g').toArray();
  for (const el of nodes) {
    const $el = $(el);
    const link = $el.find('a[href^="http"]').first();
    const href = link.attr('href');
    const title = ($el.find('h3').first().text() || link.text() || '').replace(/\s+/g, ' ').trim();
    const snippet = (
      $el.find('.VwiC3b, .IsZvec, span.aCOpRe, div[data-sncf]').first().text() ||
      ''
    ).replace(/\s+/g, ' ').trim();

    if (!href || !title) continue;
    if (/google\.(com|co)|webcache|accounts\.google/i.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    results.push({ url: href, title, snippet });
    if (results.length >= limit) break;
  }

  // Fallback: any result-looking anchors under #rso
  if (results.length === 0) {
    $('#rso a[href^="http"]').each((_, a) => {
      if (results.length >= limit) return false;
      const href = $(a).attr('href');
      const title = $(a).find('h3').text().trim() || $(a).text().trim();
      if (!href || !title || title.length < 3) return;
      if (/google\.(com|co)|webcache/i.test(href)) return;
      if (seen.has(href)) return;
      seen.add(href);
      results.push({ url: href, title: title.slice(0, 200), snippet: '' });
    });
  }

  return results;
}

function looksBlocked(html, title) {
  const body = String(html || '').toLowerCase();
  const t = String(title || '').toLowerCase();
  return (
    /unusual traffic|captcha|sorry|detected unusual|enable javascript|consent/.test(body) ||
    /unusual traffic|before you continue|consent/.test(t) ||
    (body.length < 1500 && !body.includes('id="search"') && !body.includes('id="rso"'))
  );
}

class GoogleScrape {
  static lastRequestWasBlocked = false;

  static async search(searchQuery, limit = 10) {
    await throttle();

    // Scrapling first — TLS impersonation / stealth beats bare axios on Google.
    try {
      const via = await scrapling.search(searchQuery, 'google', limit);
      if (via.ok && via.results.length > 0) {
        GoogleScrape.lastRequestWasBlocked = false;
        logger.debug(`Google Scrapling "${searchQuery}" -> ${via.results.length} (${via.mode})`);
        return via.results;
      }
      if (via.blocked) GoogleScrape.lastRequestWasBlocked = true;
    } catch (err) {
      logger.debug(`Google Scrapling failed (${err.message}); falling back`);
    }

    try {
      const httpResults = await this._httpSearch(searchQuery, limit);
      if (httpResults.length > 0) {
        GoogleScrape.lastRequestWasBlocked = false;
        logger.debug(`Google HTTP "${searchQuery}" -> ${httpResults.length} results`);
        return httpResults;
      }
    } catch (err) {
      logger.debug(`Google HTTP failed (${err.message}); trying browser`);
      GoogleScrape.lastRequestWasBlocked = true;
    }

    return this._browserSearch(searchQuery, limit);
  }

  static async _httpSearch(searchQuery, limit) {
    const url =
      `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}` +
      `&hl=en&num=${Math.min(limit, 10)}&pws=0`;

    const res = await axios.get(url, {
      timeout: 20000,
      maxRedirects: 5,
      responseType: 'text',
      headers: {
        'User-Agent': config.SCRAPER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.google.com/',
      },
      validateStatus: () => true,
    });

    const html = typeof res.data === 'string' ? res.data : '';
    if (res.status >= 400 || looksBlocked(html)) {
      GoogleScrape.lastRequestWasBlocked = true;
      return [];
    }

    const results = parseHtml(html, limit);
    if (results.length === 0) GoogleScrape.lastRequestWasBlocked = true;
    return results;
  }

  static async _browserSearch(searchQuery, limit) {
    let page;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      await page.setUserAgent(config.SCRAPER_USER_AGENT);
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      const url =
        `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}` +
        `&hl=en&num=${Math.min(limit, 10)}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('#search .g, #rso, h3', { timeout: 12000 }).catch(() => null);

      const html = await page.content();
      const title = await page.title();
      if (looksBlocked(html, title)) {
        GoogleScrape.lastRequestWasBlocked = true;
        logger.warn(`Google browser blocked for "${searchQuery}" (title: "${title}")`);
        return [];
      }

      const results = parseHtml(html, limit);
      if (results.length === 0) {
        GoogleScrape.lastRequestWasBlocked = true;
        return [];
      }
      GoogleScrape.lastRequestWasBlocked = false;
      logger.debug(`Google browser "${searchQuery}" -> ${results.length} results`);
      return results;
    } catch (err) {
      GoogleScrape.lastRequestWasBlocked = true;
      logger.warn(`Google browser search failed for "${searchQuery}": ${err.message}`);
      return [];
    } finally {
      if (page) {
        try { await page.close(); } catch (e) { /* */ }
      }
    }
  }

  static async shutdown() {
    if (!browserPromise) return;
    const pending = browserPromise;
    browserPromise = null;
    try {
      const browser = await pending;
      await browser.close();
      logger.debug('Google scraper browser closed.');
    } catch (err) {
      logger.warn(`Google scraper shutdown failed: ${err.message}`);
    }
  }
}

module.exports = GoogleScrape;
