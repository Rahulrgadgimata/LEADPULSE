require('../config/env');
const Search = require('../services/discovery/collectors/search');
const BingScrape = require('../services/discovery/collectors/bingScrape');
const GoogleScrape = require('../services/discovery/collectors/googleScrape');

(async () => {
  Search.resetBlockState();
  const queries = [
    'site:linkedin.com/company Artificial Intelligence startup India',
    'site:linkedin.com/company "machine learning" startup India',
    '"Artificial Intelligence" startup India site:linkedin.com/company',
    'site:linkedin.com/in "Founder" "Artificial Intelligence" India',
    '"CTO at" AI startup India site:linkedin.com/in',
  ];
  for (const q of queries) {
    console.log('\n====', q);
    let results = [];
    try {
      results = await BingScrape.search(q, 8);
    } catch (e) {
      console.log('bing err', e.message);
    }
    console.log('bing', results.length);
    for (const r of results.slice(0, 5)) {
      console.log(' ', (r.url || '').slice(0, 90), '|', (r.title || '').slice(0, 60));
    }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
