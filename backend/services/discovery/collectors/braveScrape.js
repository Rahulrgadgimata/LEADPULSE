const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const logger = require('../../../utils/logger');
const config = require('../../../config/env');
const scrapling = require('../../scraplingClient');

/**
 * Keyless Brave Search scrape — public results at search.brave.com, no API key.
 *
 * Always used alongside DuckDuckGo (and any configured search APIs). Results
 * are merged upstream so Groq qualifies the union of every source.
 */

let lastRequestAt = 0;
let browserPromise = null;

async function throttle() {
  const now = Date.now();
  const scheduled = Math.max(now, lastRequestAt + config.SCRAPER_DELAY_MS);
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
      logger.warn(`Brave scraper browser relaunch (${err.message})`);
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

  // Brave's current results page carries one [data-type="web"] node per organic
  // result; the .snippet shapes are kept as a fallback for older markup.
  let nodes = $('[data-type="web"]').toArray();
  if (nodes.length === 0) {
    nodes = $('#results .snippet, div.snippet, .snippet').toArray();
  }

  for (const el of nodes) {
    const $el = $(el);

    let href =
      $el.find('a[href^="http"]').first().attr('href') ||
      $el.find('a.result-header').attr('href') ||
      $el.find('a').first().attr('href');

    const title = (
      $el.find('.title, .snippet-title, .search-snippet-title, a.result-header').first().text() ||
      $el.find('a').first().text() ||
      ''
    ).replace(/\s+/g, ' ').trim();

    const snippet = (
      $el.find('.snippet-description, .snippet-content, .generic-snippet .content, .snippet-content p').first().text() ||
      ''
    ).replace(/\s+/g, ' ').trim();

    if (!href || !title) continue;
    if (/brave\.com|duckduckgo\.com|bing\.com|google\./i.test(href)) continue;

    try {
      href = new URL(href, 'https://search.brave.com').href;
    } catch (e) {
      continue;
    }

    if (seen.has(href)) continue;
    seen.add(href);
    results.push({ url: href, title, snippet });
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * A Cloudflare challenge, not a thin result set.
 *
 * The previous version matched "captcha" / "enable javascript" anywhere in the
 * body. Brave's real results page is ~284KB and mentions both inside inline
 * script config, so every healthy response — 20 parsed results and all — was
 * discarded as blocked. Restricted to the <title> plus short documents, since
 * a challenge page is always small and announces itself in its title.
 */
function looksBlocked(html, pageTitle) {
  const body = String(html || '').toLowerCase();
  const explicit = String(pageTitle || '').toLowerCase();
  if (body.length < 400) return true;

  const titleText = explicit || (/<title[^>]*>([\s\S]*?)<\/title>/.exec(body) || [])[1] || '';
  const CHALLENGE = /just a moment|attention required|access denied|verify you are human|are you a robot/;
  if (CHALLENGE.test(titleText)) return true;

  return body.length < 20000 && CHALLENGE.test(body);
}

class BraveScrape {
  static lastRequestWasBlocked = false;

  /**
   * Search Brave's public web UI. Never throws — returns [] on failure.
   */
  static async search(searchQuery, limit = 10) {
    await throttle();

    // Scrapling first (TLS impersonation / stealth) before axios/Puppeteer.
    try {
      const via = await scrapling.search(searchQuery, 'brave', limit);
      if (via.ok && via.results.length > 0) {
        BraveScrape.lastRequestWasBlocked = false;
        logger.debug(`Brave Scrapling "${searchQuery}" -> ${via.results.length} (${via.mode})`);
        return via.results;
      }
      if (via.blocked) BraveScrape.lastRequestWasBlocked = true;
    } catch (err) {
      logger.debug(`Brave Scrapling failed (${err.message}); falling back`);
    }

    // 1) Fast path: plain HTTP. Works often enough and avoids Chromium cost.
    try {
      const httpResults = await this._httpSearch(searchQuery, limit);
      if (httpResults.length > 0) {
        BraveScrape.lastRequestWasBlocked = false;
        logger.debug(`Brave HTTP "${searchQuery}" -> ${httpResults.length} results`);
        return httpResults;
      }
      if (!BraveScrape.lastRequestWasBlocked) {
        // Genuine empty set — no point launching a browser for the same query.
        return [];
      }
    } catch (err) {
      logger.debug(`Brave HTTP path failed (${err.message}); trying browser`);
      BraveScrape.lastRequestWasBlocked = true;
    }

    // 2) Browser path for Cloudflare / JS-rendered result pages.
    return this._browserSearch(searchQuery, limit);
  }

  static async _httpSearch(searchQuery, limit) {
    const url = `https://search.brave.com/search?q=${encodeURIComponent(searchQuery)}&source=web`;
    const res = await axios.get(url, {
      timeout: 20000,
      maxRedirects: 5,
      responseType: 'text',
      headers: {
        'User-Agent': config.SCRAPER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        Referer: 'https://search.brave.com/',
      },
      validateStatus: () => true,
    });

    const html = typeof res.data === 'string' ? res.data : '';
    if (res.status >= 400 || looksBlocked(html)) {
      BraveScrape.lastRequestWasBlocked = true;
      logger.debug(`Brave HTTP blocked/empty for "${searchQuery}" (status ${res.status})`);
      return [];
    }

    const results = parseHtml(html, limit);
    if (results.length === 0) {
      // Could be block with soft HTML, or truly no hits — mark soft-block so
      // the browser path still gets a chance.
      BraveScrape.lastRequestWasBlocked = true;
    }
    return results;
  }

  static async _browserSearch(searchQuery, limit) {
    let page;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      await page.setUserAgent(config.SCRAPER_USER_AGENT);
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
      });

      // Hide webdriver flag — Brave/Cloudflare often check this.
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      const url = `https://search.brave.com/search?q=${encodeURIComponent(searchQuery)}&source=web`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

      await page.waitForSelector('#results .snippet, .snippet, [data-type="web"]', { timeout: 15000 }).catch(() => null);

      const html = await page.content();
      const title = await page.title();

      if (looksBlocked(html, title)) {
        BraveScrape.lastRequestWasBlocked = true;
        logger.warn(`Brave browser blocked for "${searchQuery}" (title: "${title}")`);
        return [];
      }

      const results = parseHtml(html, limit);
      if (results.length === 0) {
        BraveScrape.lastRequestWasBlocked = true;
        logger.warn(`Brave browser returned 0 results for "${searchQuery}" (title: "${title}")`);
        return [];
      }

      BraveScrape.lastRequestWasBlocked = false;
      logger.debug(`Brave browser "${searchQuery}" -> ${results.length} results`);
      return results;
    } catch (err) {
      BraveScrape.lastRequestWasBlocked = true;
      logger.warn(`Brave browser search failed for "${searchQuery}": ${err.message}`);
      return [];
    } finally {
      if (page) {
        try { await page.close(); } catch (e) { /* already gone */ }
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
      logger.debug('Brave scraper browser closed.');
    } catch (err) {
      logger.warn(`Brave scraper shutdown failed: ${err.message}`);
    }
  }
}

module.exports = BraveScrape;
