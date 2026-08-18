/**
 * Domains that are never prospects: search/reference sites, media, social
 * networks, job aggregators and directory/listicle sites.
 */
const NON_PROSPECT_NAMES = new Set([
  'google', 'bing', 'duckduckgo', 'yahoo', 'baidu', 'yandex', 'ask',
  'wikipedia', 'wikimedia', 'britannica', 'investopedia', 'techtarget',
  'quora', 'stackexchange', 'stackoverflow', 'medium', 'substack', 'blogspot',
  'wordpress', 'wix', 'weebly', 'archive', 'scribd', 'slideshare',
  'linkedin', 'indeed', 'glassdoor', 'naukri', 'monster', 'ziprecruiter',
  'simplyhired', 'dice', 'wellfound', 'angel', 'greenhouse', 'lever',
  'workable', 'ashbyhq', 'instahyre', 'shine', 'timesjobs', 'foundit',
  'jobstreet', 'seek', 'careerbuilder', 'flexjobs', 'hirist', 'cutshort',
  'twitter', 'x', 'facebook', 'instagram', 'reddit', 'youtube', 'tiktok',
  'pinterest', 'tumblr', 'threads', 'discord', 'telegram', 'whatsapp',
  'clutch', 'themanifest', 'sortlist', 'g2', 'capterra', 'getapp',
  'trustradius', 'softwareadvice', 'crunchbase', 'owler', 'zoominfo',
  'goodfirms', 'designrush', 'yelp', 'tracxn', 'producthunt',
  'reuters', 'bloomberg', 'forbes', 'techcrunch', 'cnbc', 'bbc', 'cnn',
  'theverge', 'wired', 'zdnet', 'venturebeat', 'businessinsider',
  'prnewswire', 'businesswire', 'globenewswire', 'prtimes', 'einnews',
  'yourstory', 'inc42', 'entrackr', 'moneycontrol', 'livemint', 'ndtv',
  'thehindu', 'timesofindia', 'economictimes', 'hindustantimes',
  'github', 'gitlab', 'bitbucket', 'npmjs', 'pypi', 'readthedocs',
  'docker', 'stackshare',
  'indiatimes', 'business-standard', 'financialexpress', 'thehindubusinessline',
  'zeebiz', 'businesstoday', 'firstpost', 'news18', 'indianexpress',
  'zaubacorp', 'tofler', 'indiamart', 'justdial', 'sulekha', 'nasscom',
  'rbi', 'sebi', 'startupindia', 'theirstack', 'slintel', 'apollo',
  'ambitionbox', 'quikr', 'olx', 'trak', 'medianama', 'techinasia',
  // Reference works and enthusiast forums: they rank for almost any keyword,
  // so any collector that treats a search hit as a company will surface them.
  'dictionary', 'merriam-webster', 'thesaurus', 'definitions', 'vocabulary',
  'collinsdictionary', 'wiktionary', 'wordreference', 'yourdictionary',
  'techpowerup', 'windowsforum', 'tomshardware', 'xda-developers', 'howtogeek',
  'geeksforgeeks', 'w3schools', 'tutorialspoint', 'javatpoint', 'coursera',
  'udemy', 'edx', 'khanacademy', 'byjus', 'unacademy',
  // Tech trade press and "companies hiring in <city>" boards. These rank for
  // exactly the queries the web collector runs and are usually US-based, so
  // they survive a US geography filter that correctly drops the real foreign
  // companies around them — a run for US SaaS returned three of these and one
  // actual company.
  'techbullion', 'techrseries', 'builtin', 'builtinnyc', 'builtinla',
  'builtinchicago', 'builtinaustin', 'builtinboston', 'builtinsf',
  'analyticsinsight', 'cxotoday', 'siliconindia', 'techrepublic', 'cio',
  'informationweek', 'computerworld', 'techradar', 'engadget', 'gizmodo',
  'mashable', 'readwrite', 'thenextweb', 'arstechnica', 'sifted', 'eu-startups',
  'startupsavant', 'growthlist', 'failory', 'ventureradar',
  'runoob', 'programiz', 'freecodecamp', 'sitepoint', 'baeldung', 'hackernoon',
  'hashnode', 'dev', 'digitalocean',
  // Accelerator and marketplace directories. Their company lists rank first for
  // "top <industry> startups in <city>", so a run aimed at startups kept
  // surfacing the directory itself as the prospect.
  'ycombinator', 'techstars', 'antler', 'seedcamp', 'startupblink',
  'toptal', 'upwork', 'fiverr', 'freelancer', 'guru', 'peopleperhour',
]);

/**
 * Mega / Fortune-scale companies. Cold outreach almost never converts —
 * prefer startups and mid-market instead.
 */
const MEGA_CORP_NAMES = new Set([
  'google', 'alphabet', 'microsoft', 'amazon', 'amazonaws', 'aws', 'apple',
  'meta', 'facebook', 'instagram', 'whatsapp', 'ibm', 'oracle', 'salesforce',
  'adobe', 'sap', 'samsung', 'tesla', 'nvidia', 'intel', 'amd', 'cisco',
  'dell', 'hp', 'hpe', 'lenovo', 'sony', 'netflix', 'uber', 'airbnb', 'spotify',
  'paypal', 'visa', 'mastercard', 'jpmorgan', 'goldmansachs', 'morganstanley',
  'deloitte', 'accenture', 'pwc', 'ey', 'kpmg', 'infosys', 'tcs', 'wipro',
  'cognizant', 'capgemini', 'hcl', 'hcltech', 'techmahindra', 'ltimindtree',
  'reliance', 'tata', 'adani', 'flipkart', 'walmart', 'target', 'costco',
  'openai', 'anthropic', 'deepmind', 'huggingface',
  // Industrial, automotive and banking giants that reach discovery through news
  // coverage ("<giant> adopts AI") rather than through being a prospect.
  'mercedes', 'mercedesbenz', 'bmw', 'volkswagen', 'toyota', 'honda', 'ford',
  'siemens', 'bosch', 'ge', 'honeywell', 'philips', 'schneiderelectric',
  'unilever', 'nestle', 'pepsico', 'cocacola', 'procterandgamble',
  'hsbc', 'citigroup', 'citibank', 'barclays', 'wellsfargo', 'capitalone',
  'bankofamerica', 'americanexpress', 'transunion', 'experian', 'equifax',
  'hdfcbank', 'icicibank', 'axisbank', 'kotak', 'sbi', 'bajajfinance',
  'paytm', 'phonepe', 'zomato', 'swiggy', 'ola', 'byjus', 'jio', 'airtel',
  'forvia', 'exlservice', 'genpact', 'mphasis', 'mindtree', 'persistent',
  'larsentoubro', 'tatacommunications', 'tatatechnologies', 'yotta', 'esds',
  'alibaba', 'alibabacloud', 'tencent', 'baidu', 'bytedance', 'huawei', 'xiaomi',
  'astrazeneca', 'pfizer', 'novartis', 'roche', 'merck', 'johnsonandjohnson',
  'shell', 'bp', 'exxonmobil', 'chevron', 'boeing', 'airbus', 'lockheedmartin',
]);

const MEGA_CORP_NAME_RE = /\b(google|microsoft|amazon|aws|apple|meta|facebook|ibm|oracle|salesforce|adobe|samsung|tesla|nvidia|intel|cisco|deloitte|accenture|infosys|wipro|cognizant|capgemini|netflix|uber|airbnb|openai|anthropic|tata consultancy|tcs)\b/i;

const COMPOUND_SUFFIXES = new Set([
  'co.in', 'co.uk', 'co.jp', 'co.kr', 'co.za', 'co.nz', 'co.il', 'co.id',
  'com.au', 'com.br', 'com.cn', 'com.mx', 'com.sg', 'com.tr', 'com.tw',
  'com.hk', 'com.my', 'com.ph', 'com.ar', 'com.co', 'com.pk', 'com.sa',
  'org.uk', 'org.in', 'net.au', 'net.in', 'ac.uk', 'ac.in', 'gov.uk', 'gov.in',
]);

function registrableName(domain) {
  if (!domain) return '';
  const labels = String(domain).toLowerCase().replace(/^www\./, '').replace(/\.$/, '').split('.');
  if (labels.length < 2) return labels[0] || '';
  const lastTwo = labels.slice(-2).join('.');
  const suffixLabels = COMPOUND_SUFFIXES.has(lastTwo) ? 2 : 1;
  return labels[labels.length - suffixLabels - 1] || '';
}

function isNonProspect(domain) {
  return NON_PROSPECT_NAMES.has(registrableName(domain));
}

function isMegaCorp(domainOrName) {
  if (!domainOrName) return false;
  const raw = String(domainOrName).trim();
  if (!raw) return false;

  if (raw.includes('.') || !/\s/.test(raw)) {
    const reg = registrableName(raw.includes('.') ? raw : `${raw}.com`);
    if (MEGA_CORP_NAMES.has(reg)) return true;
    // Also match the punctuation-free form, so "mercedes-benz.com" resolves to
    // the listed "mercedesbenz" rather than slipping through on its hyphen.
    if (MEGA_CORP_NAMES.has(reg.replace(/[^a-z0-9]/g, ''))) return true;
  }

  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (MEGA_CORP_NAMES.has(slug)) return true;
  if (MEGA_CORP_NAME_RE.test(raw)) return true;
  return false;
}

module.exports = {
  isNonProspect,
  isMegaCorp,
  registrableName,
  NON_PROSPECT_NAMES,
  MEGA_CORP_NAMES
};
