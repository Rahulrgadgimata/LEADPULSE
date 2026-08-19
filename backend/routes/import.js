const express = require('express');
const multer = require('multer');
const path = require('path');

const ICP = require('../models/ICP');
const DiscoveryService = require('../services/discovery');
const ImportService = require('../services/import');
const { readSheet } = require('../services/import/sheetReader');
const { parseRequestedFields } = require('../services/import/aiExtractor');
const config = require('../config/env');
const { query } = require('../config/database');
const logger = require('../utils/logger');

const router = express.Router();

// Held in memory rather than on disk: the free instance has no persistent
// volume, and a sheet small enough to import is small enough to keep in RAM.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.IMPORT_MAX_FILE_MB * 1024 * 1024, files: 1 }
});

const ALLOWED = new Set(['.xlsx', '.xls', '.csv']);

// What an import looks for when the user does not say. These are the details
// that make a row actionable; anything else has to be asked for.
const DEFAULT_FIELDS = ['contact name', 'job title', 'email', 'phone', 'linkedin'];

// The labels that already have their own CSV column, so the rest can be added.
const STANDARD_LABELS = ['email', 'phone', 'contact name', 'job title', 'LinkedIn'];

/**
 * Upload a spreadsheet of companies and enrich every row with contact details.
 *
 * Body (multipart/form-data):
 *   file        the .xlsx / .xls / .csv
 *   icpName     name for the ICP these leads belong to (optional)
 *   icpId       add to an existing ICP instead of creating one (optional)
 *
 * Responds as soon as the sheet parses, with the job id to poll — enrichment
 * takes a page fetch or two per row, so it runs on the same queue as discovery.
 */
router.post('/leads', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Choose an .xlsx, .xls or .csv file.' });
    }

    const ext = path.extname(req.file.originalname || '').toLowerCase();
    if (!ALLOWED.has(ext)) {
      return res.status(400).json({
        error: `${ext || 'That file type'} is not supported. Upload an .xlsx, .xls or .csv file.`
      });
    }

    let sheet;
    try {
      sheet = await readSheet(req.file.buffer, req.file.originalname, config.IMPORT_MAX_ROWS);
    } catch (parseErr) {
      // A sheet the reader cannot understand is the user's problem to fix, and
      // the message says exactly what to change.
      return res.status(400).json({ error: parseErr.message });
    }

    if (sheet.rows.length === 0) {
      return res.status(400).json({ error: 'No usable rows found — every row was missing a company and a website.' });
    }

    // Either add to the ICP they picked, or create one named after the upload
    // so the imported leads are a group the dashboard can filter to.
    let icp;
    if (req.body.icpId) {
      icp = await ICP.getById(req.body.icpId);
      if (!icp) return res.status(404).json({ error: `ICP ${req.body.icpId} not found.` });
    } else {
      const name = String(req.body.icpName || '').trim() ||
        `Imported — ${path.basename(req.file.originalname, ext).slice(0, 60)}`;

      // Locations from the sheet become the ICP's geographies, so a later
      // discovery run against this profile targets the same places the list
      // came from rather than searching everywhere.
      const locations = [...new Set(
        sheet.rows.map(r => r.company_location).filter(Boolean).map(l => String(l).split(',').pop().trim())
      )].slice(0, 6);
      const industries = [...new Set(sheet.rows.map(r => r.company_industry).filter(Boolean))].slice(0, 6);

      icp = await ICP.create({
        name,
        description: `${sheet.rows.length} companies imported from ${req.file.originalname}`,
        industries,
        geographies: locations,
        job_titles: ['Founder', 'CEO', 'CTO', 'Owner'],
        keywords: [],
        company_size_min: 1,
        company_size_max: 100000,
        is_active: true,
        user_id: req.user ? req.user.id : null
      });
      logger.info(`Import created ICP "${icp.name}" (${icp.id}) for ${sheet.rows.length} rows.`);
    }

    // What the user wants for each company. Free text, because the useful
    // answer is not a fixed list — "owner name, email, tech stack, franchise
    // count" is as valid a request as the standard contact fields.
    const fields = parseRequestedFields(req.body.fields) ;
    const requested = fields.length ? fields : DEFAULT_FIELDS;

    const updateProgress = DiscoveryService.progressWriter;
    const job = await DiscoveryService.enqueueJob({
      icp,
      label: 'Import',
      triggerType: 'import',
      startText: `Reading ${sheet.rows.length} companies from ${req.file.originalname}...`,
      execute: async jobId => {
        const { stats } = await ImportService.run(jobId, {
          icpId: icp.id,
          rows: sheet.rows,
          updateProgress: updateProgress(jobId),
          fields: requested
        });
        await DiscoveryService.completeJob(jobId, ImportService.summarise(stats));
      }
    });

    res.status(202).json({
      ...job,
      icp: { id: icp.id, name: icp.name },
      parsed: {
        rows: sheet.rows.length,
        totalRows: sheet.totalRows,
        truncated: sheet.totalRows > sheet.rows.length,
        columns: sheet.columns,
        sheetName: sheet.sheetName
      },
      requestedFields: requested,
      message:
        `Importing ${sheet.rows.length} companies and looking for ` +
        `${requested.join(', ')}`
    });
  } catch (err) {
    logger.error('Sheet import failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Per-row outcome of an import: what was found for each company, and what was
 * looked for and not found. A blank cell in the dashboard cannot distinguish
 * those two, and the difference is what tells the user whether to go looking
 * themselves.
 */
router.get('/report/:jobId', async (req, res) => {
  const job = (await query(
    'SELECT id, status, status_text, result_json FROM discovery_jobs WHERE id = ?',
    [req.params.jobId]
  )).rows[0];

  if (!job) return res.status(404).json({ error: 'Import job not found.' });
  if (!job.result_json) {
    return res.json({
      jobId: job.id,
      status: job.status,
      ready: false,
      message: job.status === 'running' || job.status === 'queued'
        ? 'The import is still running.'
        : 'No report was recorded for this job.'
    });
  }

  const parsed = JSON.parse(job.result_json);
  res.json({ jobId: job.id, status: job.status, ready: true, summary: job.status_text, ...parsed });
});

/**
 * The uploaded list back as a CSV, with the contact columns filled in and an
 * explicit "not found" wherever the pipeline came up empty — which is the
 * artefact most people actually want out of an import.
 */
router.get('/report/:jobId.csv', async (req, res) => {
  const job = (await query(
    'SELECT id, result_json FROM discovery_jobs WHERE id = ?',
    [req.params.jobId]
  )).rows[0];

  if (!job || !job.result_json) {
    return res.status(404).json({ error: 'No finished import report for that job.' });
  }

  const { rows = [] } = JSON.parse(job.result_json);

  // Whatever the import was asked to find, in the order it appears in the
  // results — a fixed header would silently drop the custom fields that were
  // the reason for asking.
  const extras = [];
  for (const entry of rows) {
    for (const key of Object.keys(entry.found || {})) {
      if (!STANDARD_LABELS.includes(key) && !extras.includes(key)) extras.push(key);
    }
  }

  const header = [
    'Company', 'Website', 'Email', 'Phone', 'Contact name', 'Job title', 'LinkedIn',
    ...extras, 'Result'
  ];

  const escape = value => {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  // "not found" is written into the cell rather than left blank: an empty cell
  // reads as "not attempted", which is the wrong conclusion.
  const cell = (entry, label) => entry.found[label] || (entry.status === 'failed' ? 'error' : 'not found');

  const lines = [header.join(',')];
  for (const entry of rows) {
    lines.push([
      entry.company,
      entry.website || 'not found',
      cell(entry, 'email'),
      cell(entry, 'phone'),
      cell(entry, 'contact name'),
      cell(entry, 'job title'),
      cell(entry, 'LinkedIn'),
      ...extras.map(key => cell(entry, key)),
      entry.status + (entry.note ? ` — ${entry.note}` : '')
    ].map(escape).join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leadpulse-contacts-${job.id.slice(0, 8)}.csv"`);
  res.send(lines.join('\n'));
});

// Multer rejects an oversized file with its own error class; without this the
// generic handler reports a 500 for what is a plain "your file is too big".
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `That file is over the ${config.IMPORT_MAX_FILE_MB}MB limit. Split it and upload again.`
      : `Upload failed: ${err.message}`;
    return res.status(400).json({ error: message });
  }
  next(err);
});

module.exports = router;
