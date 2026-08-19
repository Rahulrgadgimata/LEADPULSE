const ICP = require('../../models/ICP');
const DedupService = require('../dedup');
const EnrichmentService = require('../enrichment');
const ScoringService = require('../scoring');
const logger = require('../../utils/logger');
const config = require('../../config/env');
const { query } = require('../../config/database');
const { mapWithConcurrency } = require('../../utils/concurrency');
const runBudget = require('../discovery/runBudget');
const MapsLookup = require('./mapsLookup');
const { AiExtractor, toKnownField } = require('./aiExtractor');

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
  static async run(jobId, { icpId, rows, updateProgress, fields = [] }) {
    runBudget.start(config.IMPORT_RUN_BUDGET_MS);

    try {
      const icp = await ICP.getById(icpId);
      if (!icp) throw new Error(`ICP ${icpId} not found for this import.`);

      const stats = {
        created: 0, duplicates: 0, enriched: 0,
        withEmail: 0, withPhone: 0, withBuyer: 0,
        complete: 0, partial: 0, nothing: 0,
        viaMaps: 0, viaAi: 0, failed: 0, skipped: 0
      };
      // Shared across the concurrent workers, so each allowance is per import.
      let mapsLookupsLeft = config.IMPORT_MAPS_LOOKUPS;
      let aiExtractionsLeft = config.IMPORT_AI_EXTRACTIONS;

      if (fields.length) logger.info(`Import will look for: ${fields.join(', ')}`);
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
            await query(
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

          // Websites seldom publish a phone number; Maps almost always has one.
          // Only rows still missing it spend a credit, and only while the
          // per-import allowance lasts.
          const beforeMaps = (await query(
            'SELECT company_name, company_website, company_location, contact_phone FROM leads WHERE id = ?',
            [lead.id]
          )).rows[0] || {};

          if (!beforeMaps.contact_phone && mapsLookupsLeft > 0 && MapsLookup.available && !runBudget.expired()) {
            mapsLookupsLeft--;
            try {
              const found = await MapsLookup.find(beforeMaps);
              if (found?.phone) {
                await query(
                  `UPDATE leads SET contact_phone = ?,
                     company_location = COALESCE(NULLIF(company_location, ''), ?),
                     updated_at = ? WHERE id = ?`,
                  [found.phone, found.address || null, new Date().toISOString(), lead.id]
                );
                entry.viaMaps = true;
                stats.viaMaps++;
                logger.info(`Maps supplied a phone for ${beforeMaps.company_name} (matched on ${found.confidence}).`);
              }
            } catch (mapsErr) {
              logger.debug(`Maps lookup failed for ${beforeMaps.company_name}: ${mapsErr.message}`);
            }
          }

          // Everything above is pattern matching, which only finds a detail
          // written as one. Read the pages for whatever is still missing — a
          // founder named in prose, an address written "jane [at] acme.io", or
          // any field the user asked for that has no rule of its own.
          if (fields.length && aiExtractionsLeft > 0 && AiExtractor.available && !runBudget.expired()) {
            const current = (await query(
              `SELECT company_name, company_website, contact_email, contact_phone,
                      contact_name, contact_title, contact_linkedin, company_location,
                      company_size, company_industry, company_description, extracted_json
               FROM leads WHERE id = ?`,
              [lead.id]
            )).rows[0] || {};

            const missing = fields.filter(field => {
              const column = toKnownField(field);
              return !column || !current[column];
            });

            if (missing.length && current.company_website) {
              aiExtractionsLeft--;
              try {
                const found = await AiExtractor.extract({
                  companyName: current.company_name,
                  website: current.company_website,
                  pages: await this._fetchPages(current.company_website),
                  fields,
                  missing
                });
                if (found) {
                  await this._applyExtraction(lead.id, found, current);
                  entry.viaAi = Object.keys(found);
                  stats.viaAi++;
                }
              } catch (aiErr) {
                logger.debug(`AI extraction failed for ${current.company_name}: ${aiErr.message}`);
              }
            }
          }

          await ScoringService.compute(lead.id);

          const after = (await query(
            `SELECT company_website, contact_email, contact_phone, contact_name,
                    contact_title, contact_linkedin, extracted_json
             FROM leads WHERE id = ?`,
            [lead.id]
          )).rows[0] || {};

          entry.website = after.company_website || entry.website;
          for (const [field, label] of CONTACT_FIELDS) {
            if (after[field]) entry.found[label] = after[field];
            else entry.notFound.push(label);
          }

          // Fields the user asked for that have no column of their own are
          // reported exactly like the standard ones — they were requested the
          // same way, so "not found" has to mean the same thing for both.
          if (after.extracted_json) {
            try {
              for (const [key, value] of Object.entries(JSON.parse(after.extracted_json))) {
                if (value) entry.found[key] = value;
              }
            } catch (err) {
              logger.debug(`Unreadable extracted_json on lead ${lead.id}`);
            }
          }
          for (const field of fields) {
            const label = CONTACT_FIELDS.find(([, l]) => l === field)?.[1] || field;
            if (!entry.found[label] && !entry.notFound.includes(label)) entry.notFound.push(label);
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

      await query(`UPDATE icps SET last_run_at = ? WHERE id = ?`, [new Date().toISOString(), icp.id]);

      // Keep the sheet's original order so the report reads like the upload.
      const order = new Map(rows.map((r, i) => [r.company_name, i]));
      report.sort((a, b) => (order.get(a.company) ?? 0) - (order.get(b.company) ?? 0));

      await query(
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
   * The pages worth reading for contact details, through the same fetch chain
   * enrichment uses — Scrapling, then plain HTTP, then Firecrawl rendering — so
   * a JavaScript-only or WAF-fronted site still yields something.
   */
  static async _fetchPages(domain) {
    const host = String(domain).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
    const pages = [];

    for (const path of ['', '/contact', '/about', '/team']) {
      if (runBudget.expired() || pages.length >= 3) break;
      try {
        const page = await EnrichmentService._fetchHtml(`https://${host}${path}`);
        if (page?.html) pages.push({ url: `${host}${path}`, html: page.html });
      } catch (err) {
        // A site without /team is the normal case, not a failure to report.
      }
    }
    return pages;
  }

  /**
   * Write what the model found: known details go to their columns, anything
   * else the user asked for is kept as JSON beside the lead.
   *
   * Existing values win — the sheet's own data and the earlier, more reliable
   * extraction paths are never overwritten by a later inference.
   */
  static async _applyExtraction(leadId, found, current) {
    const updates = [];
    const params = [];
    const custom = {};

    for (const [field, value] of Object.entries(found)) {
      const column = toKnownField(field);
      if (column && !current[column]) {
        updates.push(`${column} = ?`);
        params.push(
          column === 'company_size'
            ? parseInt(String(value).replace(/[^\d]/g, ''), 10) || null
            : value
        );
      } else if (!column) {
        custom[field] = value;
      }
    }

    if (Object.keys(custom).length > 0) {
      let existing = {};
      try {
        existing = current.extracted_json ? JSON.parse(current.extracted_json) : {};
      } catch (err) {
        existing = {};
      }
      updates.push('extracted_json = ?');
      params.push(JSON.stringify({ ...existing, ...custom }));
    }

    if (updates.length === 0) return;

    updates.push('updated_at = ?');
    params.push(new Date().toISOString(), leadId);
    await query(`UPDATE leads SET ${updates.join(', ')} WHERE id = ?`, params);
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
    if (stats.viaMaps) parts.push(`${stats.viaMaps} phone number(s) from Google Maps`);
    if (stats.viaAi) parts.push(`${stats.viaAi} filled in by reading the site`);
    if (stats.nothing) parts.push(`${stats.nothing} with no contact found`);
    if (stats.failed) parts.push(`${stats.failed} failed`);
    if (stats.skipped) parts.push(`${stats.skipped} skipped`);
    return parts.join(', ') + '.';
  }
}

module.exports = ImportService;
