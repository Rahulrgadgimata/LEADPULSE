require('../config/env');
const Search = require('../services/discovery/collectors/search');
const LinkedInCollector = require('../services/discovery/collectors/LinkedInCollector');
const LeadQuality = require('../services/leadQuality');

(async () => {
  Search.resetBlockState();
  const results = await Search.run('Artificial Intelligence SME india linkedin.com/company/', 12);
  console.log('raw results', results.length);
  const parsed = [];
  for (const r of results) {
    const p = LinkedInCollector._parseSearchResult(r);
    console.log({
      url: r.url,
      title: (r.title || '').slice(0, 70),
      parsed: p ? p.company_name : null,
      slug: p?.slug,
    });
    if (p) parsed.push(p);
  }
  console.log('parsed', parsed.length);
  for (const p of parsed) {
    const lead = {
      company_name: p.company_name,
      company_website: null,
      contact_linkedin: p.linkedin_url,
      source_url: p.linkedin_url,
    };
    console.log('quality', p.company_name, LeadQuality.evaluate(lead));
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
