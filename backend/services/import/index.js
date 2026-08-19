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
 * Three deliberate differences from a discovery run:
 *
 *  - No geography filter. The user chose these companies; dropping one for
 *    sitting outside the ICP's target region would silently discard a row they
 *    explicitly asked about.
 *  - No quality intake filter. A discovered company has to earn its place
 *    because search returns junk; an uploaded one does not.
 *  - Every row is reported on individually. A blank email in the dashboard is
 *    ambiguous — it could mean nobody looked. The per-row report says which
 *    details were found, which were already in the sheet, and which were
 *    searched for and genuinely not found.
 */

// What counts as a contact detail worth reporting on, and how to label it.
const CONTACT_FIELDS = [
  ['contact_email', 'email'],
  ['contact_phone', 'phone'],
  ['contact_name', 'contact name'],
  ['contact_title', 'job title'],
  ['contact_linkedin', 'LinkedIn']
];

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

      const stats = {
        created: 0, duplicates: 0, enriched: 0,
        withEmail: 0, withPhone: 0, withBuyer: 0,
        complete: 0, partial: 0, nothing: 0,
        failed: 0, skipped: 0
      };
      const report = [];
      const total = rows.length;
      let completed = 0;

      updateProgress(5, `Importing ${total} companies from your sheet...`);

      const progressEvery = Math.max(1, Math.floor(total / 20));

      await mapWithConcurrency(rows, config.ENRICHMENT_CONCURRENCY, async row => {
        const entry = {
          company: row.company_name,
          website: row.company_website || null,
          found: {},
          fromSheet: [],
          notFound: [],
          status: 'pending'
        };

        try {
          if (runBudget.isCancelled()) {
            stats.skipped++;
            entry.status = 'skipped';
            entry.note = 'Import stopped before this row was reached.';
            return;
          }

          // Remember what the sheet already supplied, so the report can tell
          // "you gave us this" apart from "we found this for you".
          for (const [field, label] of CONTACT_FIELDS) {
            if (row[field]) entry.fromSheet.push(label);
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

          entry.leadId = lead.id;
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
          } else {
            entry.note = 'Ran out of time before this row could be researched.';
          }

          await ScoringService.compute(lead.id);

          const after = query(
            `SELECT company_website, contact_email, contact_phone, contact_name,
                    contact_title, contact_linkedin
             FROM leads WHERE id = ?`,
            [lead.id]
          ).rows[0] || {};

          entry.website = after.company_website || entry.website;
          for (const [field, label] of CONTACT_FIELDS) {
            if (after[field]) entry.found[label] = after[field];
            else entry.notFound.push(label);
          }

          if (after.contact_email) stats.withEmail++;
          if (after.contact_phone) stats.withPhone++;
          if (after.contact_name) stats.withBuyer++;

          // "Reachable" is the question the user is actually asking: is there a
          // way to contact this company at all?
          const reachable = Boolean(after.contact_email || after.contact_phone);
          if (reachable && after.contact_name) {
            entry.status = 'complete';
            stats.complete++;
          } else if (reachable || after.contact_linkedin) {
            entry.status = 'partial';
            stats.partial++;
          } else {
            entry.status = 'not found';
            stats.nothing++;
          }
        } catch (err) {
          stats.failed++;
          entry.status = 'failed';
          entry.note = err.message.slice(0, 200);
          logger.warn(`Import row failed for ${row.company_name}: ${err.message}`);
        } finally {
          report.push(entry);
          completed++;
          if (completed % progressEvery === 0 || completed === total) {
            const pct = Math.min(99, 5 + Math.round((completed / total) * 94));
            updateProgress(
              pct,
              `Finding contact details (${completed}/${total}) — ` +
              `${stats.withEmail} email, ${stats.withPhone} phone so far...`
            );
          }
        }
      });

      query(`UPDATE icps SET last_run_at = ? WHERE id = ?`, [new Date().toISOString(), icp.id]);

      // Keep the sheet's original order so the report reads like the upload.
      const order = new Map(rows.map((r, i) => [r.company_name, i]));
      report.sort((a, b) => (order.get(a.company) ?? 0) - (order.get(b.company) ?? 0));

      query(
        `UPDATE discovery_jobs SET result_json = ? WHERE id = ?`,
        [JSON.stringify({ stats, rows: report }), jobId]
      );

      logger.info(
        `Import job ${jobId} finished: ${stats.created} new, ${stats.duplicates} existing, ` +
        `${stats.withEmail} email, ${stats.withPhone} phone, ${stats.withBuyer} named contact, ` +
        `${stats.nothing} with no contact found, ${stats.failed} failed.`
      );

      return { stats, report };
    } finally {
      runBudget.clear();
    }
  }

  /**
   * Human summary for the job row and the dashboard toast.
   *
   * States what was not found as plainly as what was: a row the pipeline
   * researched and came up empty on is a real answer, and leaving it implicit
   * makes the import look like it silently skipped work.
   */
  static summarise(stats) {
    const total = stats.created + stats.duplicates;
    const parts = [`${total} companies processed`];
    parts.push(`${stats.withEmail} with an email`);
    parts.push(`${stats.withPhone} with a phone`);
    parts.push(`${stats.withBuyer} with a named contact`);
    if (stats.nothing) parts.push(`${stats.nothing} with no contact found`);
    if (stats.failed) parts.push(`${stats.failed} failed`);
    if (stats.skipped) parts.push(`${stats.skipped} skipped`);
    return parts.join(', ') + '.';
  }
}

module.exports = ImportService;
