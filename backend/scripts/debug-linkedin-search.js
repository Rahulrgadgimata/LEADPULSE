require('../config/env');
const Search = require('../services/discovery/collectors/search');
const LinkedInCollector = require('../services/discovery/collectors/LinkedInCollector');
const BuyerCollector = require('../services/discovery/collectors/BuyerCollector');

(async () => {
  Search.resetBlockState();
  const q1 = 'linkedin.com/company Artificial Intelligence startup india';
  const q2 = 'linkedin.com/in Founder Artificial Intelligence startup india';
  const [r1, r2] = await Promise.all([Search.run(q1, 10), Search.run(q2, 10)]);
  console.log('=== company query hits', r1.length);
  for (const r of r1.slice(0, 8)) {
    const parsed = LinkedInCollector._parseSearchResult(r);
    console.log({ url: r.url, title: (r.title || '').slice(0, 80), parsed: parsed ? parsed.company_name : null });
  }
  console.log('=== people query hits', r2.length);
  for (const r of r2.slice(0, 8)) {
    const parsed = BuyerCollector._parsePersonResult(r, {
      industries: JSON.stringify(['Artificial Intelligence']),
      job_titles: JSON.stringify(['Founder', 'CTO']),
      keywords: JSON.stringify(['AI']),
      geographies: JSON.stringify(['india']),
    });
    console.log({
      url: r.url,
      title: (r.title || '').slice(0, 90),
      snippet: (r.snippet || '').slice(0, 100),
      parsed: parsed ? `${parsed.contact_name} @ ${parsed.company_name}` : null,
    });
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
