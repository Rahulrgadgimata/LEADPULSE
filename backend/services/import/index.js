const ICP = require('../../models/ICP');
const DedupService = require('../dedup');
const EnrichmentService = require('../enrichment');
const ScoringService = require('../scoring');
const logger = require('../../utils/logger');
const config = require('../../config/env');
const { query } = require('../../config/database');
const { mapWithConcurrency } = require('../../utils/concurrency');
const runBudget = require('../discovery/runBudget');

/**
 * Turn an uploaded spreadsheet of companies into scored leads with contacts.
 *
 * This is discovery's other half: the user already knows *which* companies they
 * want, so no searching happens. Every row goes straight to the enrichment
 * pipeline that discovery uses after it has found a company — company site
 * scrape, buyer lookup on team pages, then scoring.
 *
 * Two deliberate differences from a discovery run:
 *
 *  - No geography filter. The user chose these companies; dropping one for
 *    sitting outside the ICP's target region would silently discard a row they
 *    explicitly asked about.
 *  - No quality intake filter. A discovered company has to earn its place
 *    because search returns junk; an uploaded one does not.
 */
class ImportService {
  /**
   * @param {string} jobId
   * @param {Object} opts
   * @param {string} opts.icpId       ICP the leads attach to
   * @param {Array}  opts.rows        parsed sheet rows
   * @param {Function} opts.updateProgress
   */
  static async run(jobId, { icpId, rows, updateProgress }) {
    runBudget.start(config.IMPORT_RUN_BUDGET_MS);

    try {
      const icp = await ICP.getById(icpId);
      if (!icp) throw new Error(`ICP ${icpId} not found for this import.`);

      const stats = { created: 0, duplicates: 0, enriched: 0, withEmail: 0, withBuyer: 0, failed: 0, skipped: 0 };
      const total = rows.length;
      let completed = 0;

      updateProgress(5, `Importing ${total} companies from your sheet...`);

      const progressEvery = Math.max(1, Math.floor(total / 20));

      await mapWithConcurrency(rows, config.ENRICHMENT_CONCURRENCY, async row => {
        try {
          if (runBudget.isCancelled()) {
            stats.skipped++;
            return;
          }

          const { lead, isNew } = await DedupService.checkAndInsert(icp.id, {
            company_name: row.company_name,
            company_website: row.company_website,
            company_industry: row.company_industry,
            company_size: row.company_size,
            company_location: row.company_location,
            company_description: null,
            contact_name: row.contact_name,
            contact_title: row.contact_title,
            contact_linkedin: row.contact_linkedin,
            contact_email: row.contact_email,
            source: 'import',
            source_url: row.company_website ? `https://${row.company_website}` : null,
            raw_signal_data: { imported: true }
          });

          if (isNew) stats.created++;
          else stats.duplicates++;

          // A phone number from the sheet is worth keeping even on a duplicate.
          if (row.contact_phone) {
            query(
              `UPDATE leads SET contact_phone = COALESCE(NULLIF(contact_phone, ''), ?) WHERE id = ?`,
              [row.contact_phone, lead.id]
            );
          }

          // The point of the upload: find what the sheet does not have.
          if (!runBudget.expired()) {
            await EnrichmentService.enrich(lead.id);
            stats.enriched++;
          }

          await ScoringService.compute(lead.id);

          const after = query(
            'SELECT contact_email, contact_name FROM leads WHERE id = ?',
            [lead.id]
          ).rows[0] || {};
          if (after.contact_email) stats.withEmail++;
          if (after.contact_name) stats.withBuyer++;
        } catch (err) {
          stats.failed++;
          logger.warn(`Import row failed for ${row.company_name}: ${err.message}`);
        } finally {
          completed++;
          if (completed % progressEvery === 0 || completed === total) {
            const pct = Math.min(99, 5 + Math.round((completed / total) * 94));
            updateProgress(pct, `Finding contact details (${completed}/${total})...`);
          }
        }
      });

      query(`UPDATE icps SET last_run_at = ? WHERE id = ?`, [new Date().toISOString(), icp.id]);

      logger.info(
        `Import job ${jobId} finished: ${stats.created} new, ${stats.duplicates} existing, ` +
        `${stats.withEmail} with email, ${stats.withBuyer} with a named contact, ${stats.failed} failed.`
      );

      return stats;
    } finally {
      runBudget.clear();
    }
  }

  /** Human summary for the job row and the dashboard toast. */
  static summarise(stats) {
    const parts = [`${stats.created} companies imported`];
    if (stats.duplicates) parts.push(`${stats.duplicates} already in your pipeline`);
    parts.push(`${stats.withEmail} with an email`);
    parts.push(`${stats.withBuyer} with a named contact`);
    if (stats.failed) parts.push(`${stats.failed} failed`);
    if (stats.skipped) parts.push(`${stats.skipped} skipped`);
    return parts.join(', ') + '.';
  }
}

module.exports = ImportService;
