const cheerio = require('cheerio');
const logger = require('../../utils/logger');
const config = require('../../config/env');
const runBudget = require('../discovery/runBudget');

/**
 * Crawl a company's site for the pages that carry contact details.
 *
 * Fetching the homepage and guessing "/contact" finds what small sites publish
 * and misses what large ones do. MathWorks keeps every office number at
 * /company/aboutus/contact_us.html; plenty of firms put the switchboard in a
 * footer on one page, the leadership team on another, and the registered
 * address only in an imprint. One page is never the whole answer.
 *
 * So this walks the site properly — but by relevance rather than exhaustively.
 * A company site is mostly product and marketing pages, and crawling all of
 * them would spend the entire run on a single row. Links are scored by where
 * they lead, the best are visited first, and the crawl stops at a page budget.
 */

// How much a link's path and text suggest contact details live behind it.
const LINK_RULES = [
  [/contact|kontakt|contacto|reach-?us|get-in-touch|enquir/i, 100],
  [/office|location|worldwide|branch|where-we-are|find-us/i, 85],
  [/impressum|imprint|legal-?notice|mentions-legales/i, 80],
  [/team|leadership|our-people|management|founders|executive|board/i, 70],
  [/about|company|who-we-are|nosotros|corporate/i, 55],
  [/support|help-?center|customer-(service|care)/i, 45],
  [/careers?|jobs/i, 25],
  [/privacy|terms/i, 20]
];

// Never worth a fetch: assets, feeds, and the endless tail of a blog.
const SKIP_PATH = /\.(pdf|jpe?g|png|gif|svg|webp|ico|zip|mp4|mp3|css|js|xml|rss|json)$/i;
const SKIP_SECTION = /\/(blog|news|press|events|webinars?|resources?|docs?|documentation|support\/(articles?|tickets?)|search|cart|checkout|login|signin|signup|register)(\/|$)/i;

function scoreLink(pathname, text) {
  const haystack = `${pathname} ${text}`;
  let best = 0;
  for (const [pattern, weight] of LINK_RULES) {
    if (pattern.test(haystack)) best = Math.max(best, weight);
  }
  return best;
}

/**
 * Same-site links worth following, with the score that decides their order.
 */
function extractLinks(html, baseUrl, host) {
  const $ = cheerio.load(html);
  const found = new Map();

  $('a[href]').each((_, el) => {
    const href = String($(el).attr('href') || '').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;

    let url;
    try {
      url = new URL(href, baseUrl);
    } catch (e) {
      return;
    }
    if (!/^https?:$/.test(url.protocol)) return;

    // Another company's site is another company's contact details.
    const linkHost = url.hostname.replace(/^www\./, '');
    if (linkHost !== host && !linkHost.endsWith(`.${host}`)) return;
    if (SKIP_PATH.test(url.pathname) || SKIP_SECTION.test(url.pathname)) return;

    // Query strings and fragments rarely change who to contact, and dropping
    // them stops the same page being crawled a dozen times.
    const clean = `${url.origin}${url.pathname}`.replace(/\/$/, '') || url.origin;
    const score = scoreLink(url.pathname, $(el).text());
    if (score === 0) return;

    if (!found.has(clean) || found.get(clean) < score) found.set(clean, score);
  });

  return found;
}

class SiteCrawler {
  /**
   * @param {string} domain
   * @param {Function} fetchHtml  async (url) => { html, finalUrl } | null
   * @param {Object} [opts]
   * @returns {Promise<Array<{url: string, html: string, score: number}>>}
   */
  static async crawl(domain, fetchHtml, opts = {}) {
    const host = String(domain)
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .toLowerCase();

    const maxPages = opts.maxPages || config.CRAWL_MAX_PAGES;
    const maxDepth = opts.maxDepth || config.CRAWL_MAX_DEPTH;

    const pages = [];
    const visited = new Set();
    // url -> { score, depth }. Kept as a map so a link found again at a better
    // score is promoted rather than duplicated.
    const frontier = new Map();

    const origin = `https://${host}`;
    frontier.set(origin, { score: 1000, depth: 0 }); // the homepage always leads

    while (pages.length < maxPages && frontier.size > 0) {
      if (runBudget.expired()) {
        logger.debug(`Crawl of ${host} stopped early: run budget reached.`);
        break;
      }

      // Best-scoring link next, so the contact page is read before the
      // careers page even if the careers link appeared first.
      const [url, meta] = [...frontier.entries()].sort((a, b) => b[1].score - a[1].score)[0];
      frontier.delete(url);
      if (visited.has(url)) continue;
      visited.add(url);

      let page;
      try {
        page = await fetchHtml(url);
      } catch (err) {
        logger.debug(`Crawl fetch failed for ${url}: ${err.message}`);
        continue;
      }
      if (!page?.html) continue;

      pages.push({ url, html: page.html, score: meta.score });

      // Deeper links only while there is depth left and pages to spare.
      if (meta.depth >= maxDepth) continue;
      for (const [link, score] of extractLinks(page.html, url, host)) {
        if (visited.has(link)) continue;
        const existing = frontier.get(link);
        if (!existing || existing.score < score) {
          frontier.set(link, { score, depth: meta.depth + 1 });
        }
      }
    }

    logger.info(
      `Crawled ${host}: ${pages.length} page(s) — ` +
      pages.map(p => p.url.replace(origin, '') || '/').slice(0, 6).join(', ')
    );
    return pages;
  }
}

module.exports = SiteCrawler;
