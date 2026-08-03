/**
 * Smoke-test LinkedIn company + buyer collectors for the active ICP.
 * Usage: node scripts/smoke-linkedin.js [icpId]
 */
require('../config/env');
const ICP = require('../models/ICP');
const LinkedInCollector = require('../services/discovery/collectors/LinkedInCollector');
const BuyerCollector = require('../services/discovery/collectors/BuyerCollector');

(async () => {
  const icpId = process.argv[2] || '0c7e959f-f9f1-4344-aa2e-e41943ad088c';
  const icp = await ICP.findById(icpId);
  if (!icp) {
    console.error('ICP not found', icpId);
    process.exit(1);
  }
  console.log('ICP:', icp.name);

  const [companies, buyers] = await Promise.all([
    LinkedInCollector.searchLinkedIn(icp, { target: 20, maxQueries: 8 }),
    BuyerCollector.searchBuyers(icp, { target: 15, maxQueries: 8 }),
  ]);

  console.log('LinkedIn companies:', companies.length);
  console.log(companies.slice(0, 5).map(c => ({ name: c.company_name, site: c.company_website, url: c.source_url })));
  console.log('LinkedIn buyers:', buyers.length);
  console.log(buyers.slice(0, 5).map(c => ({ name: c.company_name, contact: c.contact_name, title: c.contact_title })));
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
