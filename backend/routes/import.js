const express = require('express');
const multer = require('multer');
const path = require('path');

const ICP = require('../models/ICP');
const DiscoveryService = require('../services/discovery');
const ImportService = require('../services/import');
const { readSheet } = require('../services/import/sheetReader');
const config = require('../config/env');
const logger = require('../utils/logger');

const router = express.Router();

// Held in memory rather than on disk: the free instance has no persistent
// volume, and a sheet small enough to import is small enough to keep in RAM.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.IMPORT_MAX_FILE_MB * 1024 * 1024, files: 1 }
});

const ALLOWED = new Set(['.xlsx', '.xls', '.csv']);

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

    const updateProgress = DiscoveryService.progressWriter;
    const job = DiscoveryService.enqueueJob({
      icp,
      label: 'Import',
      triggerType: 'import',
      startText: `Reading ${sheet.rows.length} companies from ${req.file.originalname}...`,
      execute: async jobId => {
        const stats = await ImportService.run(jobId, {
          icpId: icp.id,
          rows: sheet.rows,
          updateProgress: updateProgress(jobId)
        });
        DiscoveryService.completeJob(jobId, ImportService.summarise(stats));
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
      message: `Importing ${sheet.rows.length} companies and looking up their contact details`
    });
  } catch (err) {
    logger.error('Sheet import failed:', err);
    res.status(500).json({ error: err.message });
  }
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
