const logger = require('../../utils/logger');
const config = require('../../config/env');
const searchApi = require('../searchApiClient');
const firecrawl = require('../firecrawlClient');

/**
 * Look one uploaded company up on Google Maps to fill in what its website did
 * not give us.
 *
 * Website scraping is good at emails and bad at phone numbers: most company
 * sites put the phone in an image, a contact form, or nowhere at all. Maps has
 * it for almost every trading business — 18 of 20 on the searches measured
 * here — along with a street address that confirms where they actually are.
 *
 * This runs only for rows still missing a phone after the normal enrichment,
 * because each lookup spends a credit from a small pool.
 */

// Trading names carry suffixes and descriptors that a Maps listing may not
// ("Acme Ltd." vs "Acme"), so names are compared on their significant words.
const NOISE_WORDS = new Set([
  'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'gmbh', 'pvt', 'private',
  'co', 'company', 'group', 'holdings', 'technologies', 'technology', 'solutions',
  'services', 'systems', 'software', 'the', 'and'
]);

function significantWords(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !NOISE_WORDS.has(w));
}

function sameDomain(a, b) {
  if (!a || !b) return false;
  const clean = d => String(d).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  const x = clean(a);
  const y = clean(b);
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/**
 * Which returned place is actually the company we asked about.
 *
 * A Maps search for one business still returns its neighbours, so taking the
 * first result would attach a rival's phone number to the lead — worse than
 * leaving it blank, because it looks like a verified detail.
 */
function bestMatch(places, { name, website }) {
  if (!Array.isArray(places) || places.length === 0) return null;

  // The domain is decisive when both sides have one.
  if (website) {
    const byDomain = places.find(p => sameDomain(p.domain || p.website, website));
    if (byDomain) return { place: byDomain, confidence: 'domain' };
  }

  const wanted = significantWords(name);
  if (wanted.length === 0) return null;

  for (const place of places) {
    const got = significantWords(place.title);
    if (got.length === 0) continue;
    const overlap = wanted.filter(w => got.includes(w));
    // Every distinctive word of the company name has to appear in the listing.
    if (overlap.length === wanted.length) return { place, confidence: 'name' };
  }

  return null;
}

class MapsLookup {
  static get available() {
    return (searchApi.available && searchApi.budgetLeft() > 0) || firecrawl.available;
  }

  /**
   * @param {Object} lead   { company_name, company_website, company_location }
   * @returns {Promise<{phone?: string, address?: string, website?: string, confidence: string}|null>}
   */
  static async find(lead) {
    if (!this.available) return null;

    const name = lead.company_name;
    if (!name) return null;

    // The place goes in the query text — the engines ignore a location
    // parameter — and the city narrows a common name to the right business.
    const where = lead.company_location ? ` ${String(lead.company_location).split(',').slice(-2).join(', ').trim()}` : '';
    const query = `${name}${where}`.trim();

    let places = [];
    if (searchApi.available && searchApi.budgetLeft() > 0) {
      places = await searchApi.maps(query);
    }
    if (places.length === 0 && firecrawl.available) {
      places = await firecrawl.maps(query);
    }

    const match = bestMatch(places, { name, website: lead.company_website });
    if (!match) {
      logger.debug(`Maps lookup for "${query}" found ${places.length} places but none matched the company.`);
      return null;
    }

    const { place, confidence } = match;
    return {
      phone: place.phone || null,
      address: place.address || null,
      website: place.website || null,
      confidence
    };
  }
}

module.exports = MapsLookup;
