const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../../../utils/logger');
const config = require('../../../config/env');
const scrapling = require('../../scraplingClient');

/**
 * Keyless Bing scrape — public results at bing.com/search.
 *
 * Bing tolerates plain HTTP scraping far better than Google (which answers a
 * discovery run's query volume with 429 /sorry interstitials) and better than
 * Brave (Cloudflare-fronted, throttles after a burst). It needs no browser at
 * all, so it costs a fraction of the other collectors per query.
 */

let lastRequestAt = 0;

async function throttle() {
  const now = Date.now();
  // Claim the slot before the first await so parallel callers queue rather than
  // all reading the same timestamp and firing together.
  const scheduled = Math.max(now, lastRequestAt + config.SCRAPER_DELAY_MS);
  lastRequestAt = scheduled;
  const wait = scheduled - now;
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}

/**
 * Bing routes some clicks through /ck/a?...&u=a1<base64url-of-target>.
 */
function unwrap(href) {
  if (!href || !href.includes('bing.com/ck/')) return href;
  const match = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(href);
  if (!match) return href;
  try {
    const decoded = Buffer.from(
      match[1].replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    return decoded.startsWith('http') ? decoded : href;
  } catch (e) {
    return href;
  }
}

function parseHtml(html, limit) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $('li.b_algo').each((_, el) => {
    if (results.length >= limit) return false;
    const $el = $(el);

    const href = unwrap($el.find('h2 a').attr('href') || $el.find('a[href^="http"]').first().attr('href'));
    // .text() walks descendants, which matters because Bing wraps the matched
    // query terms in <strong> inside the heading.
    const title = ($el.find('h2').text() || '').replace(/\s+/g, ' ').trim();
    const snippet = (
      $el.find('.b_caption p').first().text() ||
      $el.find('.b_algoSlug').first().text() ||
      $el.find('p').first().text() ||
      ''
    ).replace(/\s+/g, ' ').trim();

    if (!href || !href.startsWith('http') || !title) return;
    if (/bing\.com|microsofttranslator|go\.microsoft/i.test(href)) return;
    if (seen.has(href)) return;
    seen.add(href);
    results.push({ url: href, title, snippet });
  });

  return results;
}

/**
 * A challenge page, not a thin result set. Kept narrow on purpose: matching
 * "captcha" anywhere in the body flags healthy pages whose inline scripts
 * mention it, which is exactly how Brave's 20 real results were being dropped.
 */
function looksBlocked(html) {
  const body = String(html || '').toLowerCase();
  if (body.length < 400) return true;
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/.exec(body) || [])[1] || '';
  if (/unusual traffic|verify you are human|just a moment|are you a robot/.test(title)) return true;
  return body.length < 20000 && /unusual traffic|verify you are human|just a moment/.test(body);
}

class BingScrape {
  static lastRequestWasBlocked = false;

  /** Never throws — a failed search returns [] so one query cannot abort a run. */
  static async search(searchQuery, limit = 10) {
    await throttle();

    // Scrapling first: TLS impersonation survives soft WAFs that block axios.
    try {
      const via = await scrapling.search(searchQuery, 'bing', limit);
      if (via.ok && via.results.length > 0) {
        BingScrape.lastRequestWasBlocked = false;
        logger.debug(`Bing Scrapling "${searchQuery}" -> ${via.results.length} (${via.mode})`);
        return via.results;
      }
      if (via.blocked) BingScrape.lastRequestWasBlocked = true;
    } catch (err) {
      logger.debug(`Bing Scrapling failed (${err.message}); falling back to HTTP`);
    }

    try {
      const url =
        `https://www.bing.com/search?q=${encodeURIComponent(searchQuery)}` +
        `&count=${Math.min(limit, 20)}&setlang=en`;

      const res = await axios.get(url, {
        timeout: 20000,
        maxRedirects: 5,
        responseType: 'text',
        headers: {
          'User-Agent': config.SCRAPER_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: 'https://www.bing.com/',
        },
        validateStatus: () => true,
      });

      const html = typeof res.data === 'string' ? res.data : '';
      if (res.status === 429 || res.status === 403 || looksBlocked(html)) {
        BingScrape.lastRequestWasBlocked = true;
        logger.debug(`Bing HTTP blocked for "${searchQuery}" (status ${res.status})`);
        return [];
      }

      const results = parseHtml(html, limit);
      BingScrape.lastRequestWasBlocked = false;
      logger.debug(`Bing HTTP "${searchQuery}" -> ${results.length} results`);
      return results;
    } catch (err) {
      logger.warn(`Bing search failed for "${searchQuery}": ${err.message}`);
      BingScrape.lastRequestWasBlocked = true;
      return [];
    }
  }

  /** No browser is used; present so callers can shut every collector down alike. */
  static async shutdown() {}
}

module.exports = BingScrape;
