const logger = require('../../../utils/logger');
const config = require('../../../config/env');
const searchApi = require('../../searchApiClient');
const geoMatch = require('../geoMatch');
const runBudget = require('../runBudget');
const { isNonProspect, isMegaCorp } = require('./domainFilter');

/**
 * Local businesses from Google Maps.
 *
 * Every other collector starts from a web page and has to work out whether it
 * belongs to a real company, where that company is, and how to contact it. Maps
 * starts from the answer: an operating business, its street address, its phone
 * number and its website, already filtered to the city that was asked for.
 *
 * That makes it the strongest source in the pipeline for two things the others
 * were bad at — phone numbers, which nothing else reliably produced, and target
 * geography, which the run previously enforced by discarding most of what it
 * had found.
 *
 * Credits are scarce, so this issues a handful of queries against the ICP's
 * best cities rather than sweeping every combination.
 */
class MapsCollector {
  static async search(icp, options = {}) {
    if (!searchApi.available) {
      logger.debug('MapsCollector skipped: SEARCHAPI_KEY not configured.');
      return [];
    }

    const maxQueries = options.maxQueries || config.MAPS_MAX_QUERIES;
    const queries = this._buildQueries(icp, maxQueries);
    if (queries.length === 0) {
      logger.warn('MapsCollector: ICP has no industries, keywords or geographies; skipping.');
      return [];
    }

    logger.info(`MapsCollector: ${queries.length} Maps queries (credit budget ${searchApi.budgetLeft()} left this run)`);

    const byKey = new Map();
    let queriesRun = 0;

    for (const { term, location } of queries) {
      if (runBudget.collectExpired(runBudget.PRIMARY_SHARE)) {
        logger.info(`MapsCollector stopped after ${queriesRun} queries: collection budget reached.`);
        break;
      }
      if (searchApi.budgetLeft() <= 0) break;

      queriesRun++;
      const places = await searchApi.maps(term);

      for (const place of places) {
        const lead = this._toLead(place, term, location, icp);
        if (!lead) continue;
        // A chain has one entry per branch; the domain (or the name) is what
        // makes it one prospect rather than twelve.
        const key = (lead.company_website || lead.company_name).toLowerCase();
        if (!byKey.has(key)) byKey.set(key, lead);
      }

      logger.debug(`Maps "${term}" @ ${location || 'anywhere'} -> ${places.length} places (${byKey.size} unique so far)`);
    }

    const leads = [...byKey.values()];
    logger.info(
      `MapsCollector produced ${leads.length} local businesses from ${queriesRun} queries ` +
      `(${leads.filter(l => l.contact_phone).length} with a phone number)`
    );
    return leads;
  }

  /**
   * "<industry> companies" per city, best cities first.
   *
   * Maps wants a business category and a place, not a keyword soup — "top B2B
   * SaaS startup kubernetes" returns nothing, while "software company" in a
   * named city returns twenty.
   */
  static _buildQueries(icp, maxQueries) {
    const industries = this._parseList(icp.industries);
    const keywords = this._parseList(icp.keywords);
    const geographies = this._parseList(icp.geographies);

    const terms = [...industries, ...keywords]
      .map(t => String(t).trim())
      .filter(Boolean)
      .slice(0, 4)
      .map(t => (/compan|firm|agency|service|consult/i.test(t) ? t : `${t} company`));

    if (terms.length === 0) return [];

    // Cities carry Maps queries; a country alone returns whatever is near the
    // requester. geoMatch already knows the major business cities per country.
    //
    // The location has to be qualified: asking for "New York" alone returned
    // Chicago businesses, because a bare city name is ambiguous and the API
    // falls back to its own default. "New York, United States" targets the city
    // that was actually asked for.
    const locations = [];
    for (const geo of geographies.length > 0 ? geographies : ['']) {
      const cities = geo ? geoMatch.citiesFor([geo]).slice(0, config.MAPS_MAX_CITIES) : [];
      if (cities.length === 0) {
        if (geo) locations.push(geo);
        continue;
      }
      for (const city of cities) {
        // A geography that is already a city expands to itself; do not repeat it.
        locations.push(city.toLowerCase() === geo.toLowerCase() ? city : `${city}, ${geo}`);
      }
    }
    if (locations.length === 0) locations.push(null);

    // Interleave so every city gets its best term before any city gets a second.
    // The place goes inside the query text because the engine ignores its own
    // location parameter — see SearchApiClient.maps.
    const queries = [];
    outer:
    for (let rank = 0; rank < terms.length; rank++) {
      for (const location of locations) {
        queries.push({
          term: location ? `${terms[rank]} in ${location}` : terms[rank],
          location
        });
        if (queries.length >= maxQueries) break outer;
      }
    }
    return queries;
  }

  /** Convert one Maps place into a lead, or null when it cannot be sold to. */
  static _toLead(place, term, location, icp) {
    const name = String(place.title || '').trim();
    if (!name || name.length < 2) return null;

    const domain = String(place.domain || place.website || '')
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .toLowerCase() || null;

    // A business with no website cannot be researched or emailed; Maps returns
    // plenty of those and they are not workable outbound prospects.
    if (!domain) return null;
    if (isNonProspect(domain) || isMegaCorp(domain) || isMegaCorp(name)) return null;

    // Maps returns the whole neighbourhood for a broad term, so the ICP's
    // geography still decides — but here the answer is normally "yes", because
    // the query named the city.
    const locationText = place.address || place.city || location || '';
    const geographies = this._parseList(icp.geographies);
    if (config.LEAD_GEO_STRICT && geographies.length > 0) {
      if (geoMatch.locationMatchesGeographies(locationText, geographies) === false) return null;
    }

    const reviewNote = place.rating
      ? ` Rated ${place.rating}${place.reviews ? ` from ${place.reviews} reviews` : ''} on Google Maps.`
      : '';

    return {
      company_name: name.slice(0, 120),
      company_website: domain,
      company_industry: place.type || this._parseList(icp.industries)[0] || null,
      company_location: locationText.slice(0, 160) || null,
      company_size: null,
      company_description: `${place.type || 'Local business'} listed on Google Maps.${reviewNote}`.slice(0, 500),
      contact_phone: place.phone || null,
      source: 'Maps',
      source_url: place.website || (domain ? `https://${domain}` : null),
      raw_signal_data: {
        query: term,
        location,
        place_id: place.placeId,
        rating: place.rating,
        reviews: place.reviews,
        extracted_by: 'google-maps'
      },
      signal: {
        signal_type: 'web',
        source: 'Maps',
        source_url: place.website || null,
        title: `${name} — ${place.type || 'business'} in ${place.city || location || 'target area'}`,
        content: [place.address, place.phone, place.website].filter(Boolean).join(' · ').slice(0, 500),
        // A verified listing with an address and a phone is a solid signal that
        // the business is real and trading, but it says nothing about intent.
        relevance_score: 0.55
      }
    };
  }

  static _parseList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }
}

module.exports = MapsCollector;
