const cheerio = require('cheerio');
const axios = require('axios');
const logger = require('../../../utils/logger');
const config = require('../../../config/env');
const scrapling = require('../../scraplingClient');

/**
 * Finds decision-makers on a company's own website.
 *
 * Buyer discovery used to depend entirely on public LinkedIn profiles reached
 * through a search engine. That no longer works from a server: only Google
 * indexes those pages usefully, keyless Google answers a discovery run with a
 * /sorry interstitial, and Bing returns LinkedIn's login page for every query
 * form. Public SearXNG instances are behind bot checks. So the LinkedIn route
 * is closed unless a search API key is configured.
 *
 * A company's own team page is the better source anyway: it is public, stable,
 * names people with their exact titles, and often carries the email pattern
 * needed to reach them — none of which required LinkedIn in the first place.
 */

/**
 * Ordered by how likely each is to carry named leadership, and deliberately
 * short: every path is a live page fetch through the Scrapling sidecar, and
 * enrichment already fetches six pages per lead of its own. The original
 * eleven-path list ran a 512Mi instance out of memory mid-run — which, with no
 * durable disk, also wiped the database. In testing, every buyer that was found
 * came from one of these five.
 */
const TEAM_PATHS = ['/about-us', '/about', '/team', '/leadership', '/our-team'];

// Seniority worth contacting. Ordered: earlier entries win when one page names
// several people, so a CTO outranks a marketing manager for a technical pitch.
const TITLE_PATTERNS = [
  /\b(founder|co-?founder)\b/i,
  /\b(chief\s+\w+\s+officer|c[etoifm]o)\b/i,
  /\b(president|managing\s+director|owner)\b/i,
  /\bvice\s+president\b|\bvp\b/i,
  /\bhead\s+of\s+\w+/i,
  /\bdirector\s+of\s+\w+|\b\w+\s+director\b/i,
  /\b(engineering|technology|product|sales|marketing|operations)\s+(lead|manager)\b/i
];

// Words that show a "name" is really a heading, a product or a nav item.
const NOT_A_NAME =
  /\b(team|about|contact|home|careers|company|leadership|management|our|the|we|us|privacy|terms|blog|news|solutions|services|products|pricing|login|sign|read|more|learn|view|all|meet)\b/i;

/**
 * Does this look like a person's name? Two or three capitalised words, no
 * digits, no punctuation beyond an apostrophe or hyphen.
 */
function looksLikeName(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length < 4 || value.length > 45) return false;
  if (/\d|@|\||:|\/|©/.test(value)) return false;

  const words = value.split(' ');
  if (words.length < 2 || words.length > 4) return false;
  if (NOT_A_NAME.test(value)) return false;

  // Every word starts with a capital: "Priya Sharma", not "our leadership".
  return words.every(word => /^[A-Z][a-zA-Z'’.-]{1,}$/.test(word));
}

function matchTitle(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value || value.length > 70) return null;
  for (let rank = 0; rank < TITLE_PATTERNS.length; rank++) {
    if (TITLE_PATTERNS[rank].test(value)) return { title: value, rank };
  }
  return null;
}

/**
 * Pull name/title pairs out of a page.
 *
 * Team pages are laid out as cards: a name and a title as adjacent elements
 * inside one container. Rather than guess at class names — every site invents
 * its own — the page is flattened to one line per element, and a title line is
 * paired with the name line next to it. Adjacency in the flattened text is the
 * same visual grouping the card expresses.
 *
 * Flattening matters: cheerio's .text() concatenates children with no
 * separator, so `<h4>Srijan Nagar</h4><p>Co-Founder</p>` reads as
 * "Srijan NagarCo-Founder" and matches neither a name nor a title.
 */
function extractPeople(html) {
  const $ = cheerio.load(
    // A newline before every closing block tag gives .text() the element
    // boundaries the markup implies.
    String(html).replace(/<\/(h[1-6]|p|div|li|span|td|section|article|a|strong|b|em)>/gi, '\n</$1>')
  );
  $('script, style, noscript, nav, footer').remove();

  const found = new Map(); // name -> { name, title, rank }

  const record = (name, titleMatch) => {
    if (!name || !titleMatch) return;
    const clean = name.replace(/\s+/g, ' ').trim();
    const existing = found.get(clean.toLowerCase());
    if (existing && existing.rank <= titleMatch.rank) return;
    found.set(clean.toLowerCase(), { name: clean, title: titleMatch.title, rank: titleMatch.rank });
  };

  // JSON-LD Person entries are unambiguous when a site publishes them.
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html() || 'null');
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        for (const item of node['@graph'] || [node]) {
          if (!item || !/Person/i.test(String(item['@type'] || ''))) continue;
          const titleMatch = matchTitle(item.jobTitle);
          if (looksLikeName(item.name) && titleMatch) record(item.name, titleMatch);
        }
      }
    } catch (e) { /* ignore malformed JSON-LD */ }
  });

  const lines = $('body').text()
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const titleMatch = matchTitle(lines[i]);
    if (!titleMatch) continue;

    // A card reads either "Name / Title" or "Title / Name"; check the line
    // before first, which is the far more common order.
    for (const neighbour of [lines[i - 1], lines[i + 1]]) {
      if (looksLikeName(neighbour)) {
        record(neighbour, titleMatch);
        break;
      }
    }
  }

  return [...found.values()].sort((a, b) => a.rank - b.rank);
}

/** Prefer someone whose title matches what the ICP says it sells to. */
function scoreAgainstIcp(person, icpTitles) {
  const title = person.title.toLowerCase();
  for (const wanted of icpTitles) {
    const words = String(wanted).toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (words.length && words.every(word => title.includes(word))) return -10; // exact intent
  }
  return 0;
}

class PeopleFinder {
  /**
   * The best contactable decision-maker on a company's site, or null.
   *
   * @param {string} domain      company domain
   * @param {string[]} icpTitles buyer titles from the ICP, best-match first
   */
  static async findBuyer(domain, icpTitles = []) {
    const host = String(domain || '')
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0];
    if (!host) return null;

    const people = [];

    for (const path of TEAM_PATHS) {
      // Stop as soon as a page names someone senior: fetching all eleven paths
      // for every lead would cost more than the contact is worth.
      if (people.length > 0) break;

      const html = await this._fetch(`https://${host}${path}`);
      if (!html) continue;

      const found = extractPeople(html);
      if (found.length > 0) {
        logger.debug(`PeopleFinder: ${found.length} people on ${host}${path}`);
        people.push(...found.map(person => ({ ...person, source_url: `https://${host}${path}` })));
      }
    }

    if (people.length === 0) return null;

    people.sort((a, b) =>
      (a.rank + scoreAgainstIcp(a, icpTitles)) - (b.rank + scoreAgainstIcp(b, icpTitles))
    );

    const best = people[0];
    return { name: best.name, title: best.title, source_url: best.source_url };
  }

  /** Scrapling first, plain HTTP second. Never throws. */
  static async _fetch(url) {
    try {
      const via = await scrapling.fetchHtml(url, { timeoutMs: config.SCRAPER_PAGE_TIMEOUT_MS || 8000 });
      if (via?.html) return via.html;
    } catch (err) {
      logger.debug(`PeopleFinder scrapling failed for ${url}: ${err.message}`);
    }

    try {
      const res = await axios.get(url, {
        timeout: config.SCRAPER_PAGE_TIMEOUT_MS || 8000,
        maxRedirects: 3,
        maxContentLength: 2 * 1024 * 1024,
        responseType: 'text',
        headers: {
          'User-Agent': config.SCRAPER_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        validateStatus: () => true
      });
      if (res.status >= 400 || typeof res.data !== 'string') return null;
      if (!/text\/html/i.test(String(res.headers?.['content-type'] || 'text/html'))) return null;
      return res.data;
    } catch (err) {
      return null;
    }
  }
}

module.exports = PeopleFinder;
module.exports.extractPeople = extractPeople;
module.exports.looksLikeName = looksLikeName;
