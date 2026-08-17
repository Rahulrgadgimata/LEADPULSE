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

module.exports = {
  CITY_HINTS,
  normalize,
  canonical,
  expandGeography,
  locationMatchesGeographies,
  citiesFor,
};
