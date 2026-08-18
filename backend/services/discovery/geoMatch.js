/**
 * Geography matching for ICP targeting.
 *
 * An ICP geography and a scraped company location are written by different
 * parties and almost never match as strings: the ICP says "United States", the
 * enrichment API says "Austin, TX", the LinkedIn snippet says "Bengaluru,
 * Karnataka, India". Comparing them with `includes()` produced both false
 * negatives (every city) and false positives ("us" matching "Austin"), so
 * matching goes through this module instead.
 */

// Written as alias -> canonical name. Both directions are needed: an ICP may
// say "USA" while a location says "United States", or the reverse.
const COUNTRY_ALIASES = {
  us: 'united states',
  usa: 'united states',
  'u s a': 'united states',
  america: 'united states',
  'united states of america': 'united states',
  uk: 'united kingdom',
  gb: 'united kingdom',
  britain: 'united kingdom',
  'great britain': 'united kingdom',
  england: 'united kingdom',
  scotland: 'united kingdom',
  wales: 'united kingdom',
  uae: 'united arab emirates',
  'u a e': 'united arab emirates',
  bharat: 'india',
  in: 'india',
  deutschland: 'germany',
  holland: 'netherlands',
  nl: 'netherlands',
  ca: 'canada',
  au: 'australia',
  sg: 'singapore',
};

// Business hubs per country. Used both to widen search queries and, in reverse,
// to recognise that a company in Pune is a company in India.
const CITY_HINTS = {
  india: [
    'Bangalore', 'Bengaluru', 'Mumbai', 'Delhi NCR', 'New Delhi', 'Pune',
    'Hyderabad', 'Chennai', 'Gurugram', 'Gurgaon', 'Noida', 'Kolkata',
    'Ahmedabad', 'Jaipur', 'Kochi', 'Coimbatore', 'Indore', 'Chandigarh',
  ],
  'united states': [
    'New York', 'San Francisco', 'Austin', 'Chicago', 'Boston', 'Seattle',
    'Atlanta', 'Los Angeles', 'Denver', 'Miami', 'Bay Area', 'Silicon Valley',
  ],
  'united kingdom': ['London', 'Manchester', 'Edinburgh', 'Birmingham', 'Leeds', 'Bristol', 'Glasgow'],
  canada: ['Toronto', 'Vancouver', 'Montreal', 'Calgary', 'Ottawa', 'Waterloo'],
  australia: ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide'],
  germany: ['Berlin', 'Munich', 'Frankfurt', 'Hamburg', 'Cologne', 'Stuttgart'],
  france: ['Paris', 'Lyon', 'Toulouse', 'Marseille', 'Bordeaux'],
  netherlands: ['Amsterdam', 'Rotterdam', 'Utrecht', 'Eindhoven', 'The Hague'],
  singapore: ['Singapore'],
  'united arab emirates': ['Dubai', 'Abu Dhabi', 'Sharjah'],
  japan: ['Tokyo', 'Osaka', 'Kyoto', 'Fukuoka'],
  brazil: ['Sao Paulo', 'Rio de Janeiro', 'Belo Horizonte'],
  ireland: ['Dublin', 'Cork', 'Galway'],
  spain: ['Madrid', 'Barcelona', 'Valencia'],
  italy: ['Milan', 'Rome', 'Turin'],
  sweden: ['Stockholm', 'Gothenburg', 'Malmo'],
  poland: ['Warsaw', 'Krakow', 'Wroclaw'],
  israel: ['Tel Aviv', 'Jerusalem', 'Haifa'],
  mexico: ['Mexico City', 'Guadalajara', 'Monterrey'],
  'new zealand': ['Auckland', 'Wellington', 'Christchurch'],
  'south africa': ['Johannesburg', 'Cape Town', 'Durban'],
};

// Enrichment writes locations as "<city>, <state>", so a bare state code has to
// resolve to its country or every Apollo-enriched US lead reads as unmatched.
const US_STATES = [
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il',
  'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt',
  'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri',
  'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy', 'dc',
  'california', 'texas', 'florida', 'washington', 'massachusetts', 'illinois',
  'georgia', 'colorado', 'virginia', 'arizona', 'oregon', 'utah',
];

const INDIAN_STATES = [
  'karnataka', 'maharashtra', 'tamil nadu', 'telangana', 'delhi', 'haryana',
  'gujarat', 'kerala', 'west bengal', 'rajasthan', 'punjab', 'uttar pradesh',
  'andhra pradesh', 'madhya pradesh',
];

/** Lowercase, strip punctuation, collapse whitespace. */
function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonical(value) {
  const n = normalize(value);
  return COUNTRY_ALIASES[n] || n;
}

// city (normalised) -> canonical country
const CITY_TO_COUNTRY = new Map();
for (const [country, cities] of Object.entries(CITY_HINTS)) {
  for (const city of cities) CITY_TO_COUNTRY.set(normalize(city), country);
}
for (const state of US_STATES) CITY_TO_COUNTRY.set(state, 'united states');
for (const state of INDIAN_STATES) CITY_TO_COUNTRY.set(state, 'india');

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-token containment. Substring matching would let the alias "us" match
 * "Austin" and "in" match "Singapore", marking half the world as a match.
 */
function containsToken(haystack, token) {
  if (!token) return false;
  return new RegExp(`(^|\\s)${escapeRegex(token)}($|\\s)`).test(haystack);
}

/**
 * Every string that should count as evidence for one ICP geography: the
 * geography itself, its aliases, and — when it names a country — its cities.
 */
function expandGeography(geography) {
  const canon = canonical(geography);
  const tokens = new Set();
  if (!canon) return tokens;

  tokens.add(canon);
  tokens.add(normalize(geography));

  for (const [alias, target] of Object.entries(COUNTRY_ALIASES)) {
    if (target === canon) tokens.add(alias);
  }
  for (const city of CITY_HINTS[canon] || []) tokens.add(normalize(city));

  // The ICP may name a city ("Bangalore"); a company described only as being in
  // India still satisfies it.
  const parentCountry = CITY_TO_COUNTRY.get(canon);
  if (parentCountry) {
    tokens.add(parentCountry);
    for (const [alias, target] of Object.entries(COUNTRY_ALIASES)) {
      if (target === parentCountry) tokens.add(alias);
    }
  }

  tokens.delete('');
  return tokens;
}

/**
 * Does a company location satisfy any of the ICP's geographies?
 *
 * Returns `null` — not `false` — when the location is unknown. The two cases
 * need different handling: an out-of-region company should be dropped, while a
 * company whose location was never scraped is merely unproven, and discarding
 * those would throw away most of the pipeline.
 *
 * @returns {boolean|null} true = matches, false = contradicts, null = unknown
 */
function locationMatchesGeographies(location, geographies) {
  const haystack = normalize(location);
  if (!haystack) return null;

  const list = (Array.isArray(geographies) ? geographies : []).filter(Boolean);
  if (list.length === 0) return null; // no target set — nothing to contradict

  for (const geography of list) {
    for (const token of expandGeography(geography)) {
      if (containsToken(haystack, token)) return true;
    }
  }
  return false;
}

/**
 * Country-coded top-level domains. A company on a ccTLD is nearly always
 * operating in that country, which makes the domain the single most reliable
 * location signal available for a lead whose page never states an address.
 */
const CCTLD_COUNTRY = {
  in: 'india', 'co.in': 'india', 'org.in': 'india', 'net.in': 'india',
  uk: 'united kingdom', 'co.uk': 'united kingdom', 'org.uk': 'united kingdom',
  us: 'united states',
  ca: 'canada',
  au: 'australia', 'com.au': 'australia',
  de: 'germany', fr: 'france', nl: 'netherlands', ie: 'ireland',
  es: 'spain', it: 'italy', se: 'sweden', pl: 'poland',
  sg: 'singapore', 'com.sg': 'singapore',
  ae: 'united arab emirates', 'co.ae': 'united arab emirates',
  il: 'israel', 'co.il': 'israel',
  jp: 'japan', 'co.jp': 'japan',
  br: 'brazil', 'com.br': 'brazil',
  mx: 'mexico', nz: 'new zealand', 'co.nz': 'new zealand',
  za: 'south africa', 'co.za': 'south africa',
};

/** International dialling prefixes, longest first so +1 does not eat +44. */
const PHONE_COUNTRY = [
  ['+971', 'united arab emirates'],
  ['+972', 'israel'],
  ['+353', 'ireland'],
  ['+91', 'india'],
  ['+44', 'united kingdom'],
  ['+61', 'australia'],
  ['+65', 'singapore'],
  ['+64', 'new zealand'],
  ['+49', 'germany'],
  ['+33', 'france'],
  ['+31', 'netherlands'],
  ['+34', 'spain'],
  ['+39', 'italy'],
  ['+46', 'sweden'],
  ['+48', 'poland'],
  ['+81', 'japan'],
  ['+55', 'brazil'],
  ['+52', 'mexico'],
  ['+27', 'south africa'],
  ['+1', 'united states'],
];

/** The ccTLD suffix of a domain, or null for .com/.io/.ai and friends. */
function countryFromDomain(website) {
  const host = String(website || '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase();
  if (!host.includes('.')) return null;

  const parts = host.split('.');
  const twoLevel = parts.slice(-2).join('.');
  return CCTLD_COUNTRY[twoLevel] || CCTLD_COUNTRY[parts[parts.length - 1]] || null;
}

function countryFromPhone(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (!digits.startsWith('+')) return null;
  for (const [prefix, country] of PHONE_COUNTRY) {
    if (digits.startsWith(prefix)) return country;
  }
  return null;
}

/** Any city or country name this module knows, mentioned anywhere in the text. */
function countryFromText(text) {
  const haystack = normalize(text);
  if (!haystack) return null;

  for (const [city, country] of CITY_TO_COUNTRY) {
    if (city.length >= 4 && containsToken(haystack, city)) return country;
  }
  for (const country of Object.keys(CITY_HINTS)) {
    if (containsToken(haystack, country)) return country;
  }
  for (const [alias, country] of Object.entries(COUNTRY_ALIASES)) {
    if (alias.length >= 4 && containsToken(haystack, alias)) return country;
  }
  return null;
}

/**
 * Work out where a lead actually is, from whatever the pipeline captured.
 *
 * A stated location is used as-is. Failing that the signals are tried in
 * descending order of reliability — a company on a .in domain or answering a
 * +91 number is in India whether or not its site says so anywhere.
 *
 * This exists because "unknown location" was the pipeline's dominant outcome,
 * and unknown leads were kept: news-derived leads never carry an address, so
 * they sailed through the geography filter while located web leads were checked
 * properly. Targeting a country therefore filtered out the very sources that
 * knew where they were, and the pipeline filled up with news from anywhere.
 *
 * @returns {{location: string|null, basis: string}}
 */
function resolveLocation(lead) {
  if (!lead) return { location: null, basis: 'none' };

  const stated = String(lead.company_location || '').trim();
  if (stated) return { location: stated, basis: 'stated' };

  const fromDomain = countryFromDomain(lead.company_website);
  if (fromDomain) return { location: titleCase(fromDomain), basis: 'domain' };

  const fromPhone = countryFromPhone(lead.contact_phone);
  if (fromPhone) return { location: titleCase(fromPhone), basis: 'phone' };

  // The query that found it often names the city ("fintech startups in Pune").
  const query = lead.raw_signal_data && typeof lead.raw_signal_data === 'object'
    ? lead.raw_signal_data.query
    : null;
  const fromQuery = countryFromText(query);
  if (fromQuery) return { location: titleCase(fromQuery), basis: 'query' };

  const fromDescription = countryFromText(lead.company_description);
  if (fromDescription) return { location: titleCase(fromDescription), basis: 'description' };

  return { location: null, basis: 'none' };
}

function titleCase(value) {
  return String(value || '')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Same city, two spellings. Both must stay in CITY_HINTS so either form is
// recognised in a scraped location, but issuing a search query for each just
// spends the query budget twice on one city.
const CITY_ALIAS_OF = new Map([
  ['bengaluru', 'Bangalore'],
  ['gurgaon', 'Gurugram'],
  ['new delhi', 'Delhi NCR'],
  ['bay area', 'San Francisco'],
  ['silicon valley', 'San Francisco'],
]);

/** Business hubs for the given geographies, de-duplicated, order preserved. */
function citiesFor(geographies) {
  const cities = [];
  for (const geography of Array.isArray(geographies) ? geographies : []) {
    const canon = canonical(geography);
    const known = CITY_HINTS[canon];
    if (known) {
      cities.push(...known.filter(city => !CITY_ALIAS_OF.has(normalize(city))));
    } else if (canon) {
      // Not a country we know. If the ICP named a city or region directly, it is
      // still the most specific term available, so use it as its own hub rather
      // than silently contributing nothing.
      cities.push(String(geography).trim());
    }
  }
  return [...new Set(cities)];
}

/**
 * The geography verdict for a whole lead, after inferring its location.
 *
 * @returns {{ok: boolean, location: string|null, basis: string, reason: string}}
 */
function leadMatchesGeographies(lead, geographies) {
  const list = (Array.isArray(geographies) ? geographies : []).filter(Boolean);
  if (list.length === 0) return { ok: true, location: null, basis: 'none', reason: 'no target geography' };

  const { location, basis } = resolveLocation(lead);
  if (!location) {
    return { ok: false, location: null, basis, reason: 'location could not be determined' };
  }

  const verdict = locationMatchesGeographies(location, list);
  return {
    ok: verdict === true,
    location,
    basis,
    reason: verdict === true ? 'in target geography' : `"${location}" is outside ${list.join(', ')}`
  };
}

module.exports = {
  CITY_HINTS,
  normalize,
  canonical,
  expandGeography,
  locationMatchesGeographies,
  leadMatchesGeographies,
  resolveLocation,
  countryFromDomain,
  countryFromPhone,
  citiesFor,
};
