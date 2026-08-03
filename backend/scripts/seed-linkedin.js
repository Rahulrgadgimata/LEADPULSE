/**
 * Collect LinkedIn company + buyer leads and insert them for an ICP.
 * Usage: node scripts/seed-linkedin.js [icpId]
 */
require('../config/env');
const ICP = require('../models/ICP');
const Search = require('../services/discovery/collectors/search');
const LinkedInCollector = require('../services/discovery/collectors/LinkedInCollector');
const BuyerCollector = require('../services/discovery/collectors/BuyerCollector');
const DedupService = require('../services/dedup');
const EnrichmentService = require('../services/enrichment');
const ScoringService = require('../services/scoring');
const Signal = require('../models/Signal');
const LeadQuality = require('../services/leadQuality');

const SOURCE_MAP = { LinkedIn: 'linkedin', LinkedInBuyer: 'linkedin' };

(async () => {
  const icpId = process.argv[2] || '0c7e959f-f9f1-4344-aa2e-e41943ad088c';
  const icp = await ICP.findById(icpId);
  if (!icp) throw new Error('ICP not found');

  Search.resetBlockState();
  const companies = await LinkedInCollector.searchLinkedIn(icp, { target: 25, maxQueries: 8 });
  Search.resetBlockState();
  const buyers = await BuyerCollector.searchBuyers(icp, { target: 20, maxQueries: 6 });
  const items = LeadQuality.filterBest([...companies, ...buyers]);
  console.log(`Inserting ${items.length} LinkedIn leads (${companies.length} companies + ${buyers.length} buyers)`);

  let created = 0;
  for (const item of items) {
    const rawSource = item.source || 'LinkedIn';
    const { lead, isNew } = await DedupService.checkAndInsert(icp.id, {
      company_name: item.company_name,
      company_website: item.company_website || null,
      company_industry: item.company_industry || null,
      company_size: item.company_size || null,
      company_location: item.company_location || null,
      company_description: item.company_description || null,
      contact_name: item.contact_name || null,
      contact_title: item.contact_title || null,
      contact_linkedin: item.contact_linkedin || null,
      contact_email: item.contact_email || null,
      source: SOURCE_MAP[rawSource] || 'linkedin',
      source_url: item.source_url || null,
      raw_signal_data: item.raw_signal_data || null,
    });
    if (item.signal) await Signal.create(lead.id, item.signal);
    if (isNew) {
      created += 1;
      try {
        await EnrichmentService.enrich(lead.id);
        await ScoringService.compute(lead.id);
      } catch (e) {
        console.warn('enrich/score soft-fail', item.company_name, e.message);
      }
    }
  }

  console.log(`Created ${created} new LinkedIn leads`);
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
