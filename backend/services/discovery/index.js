const { v4: uuidv4 } = require('uuid');

const ICP = require('../../models/ICP');
const Signal = require('../../models/Signal');
const DedupService = require('../dedup');
const EnrichmentService = require('../enrichment');
const ScoringService = require('../scoring');
const logger = require('../../utils/logger');
const config = require('../../config/env');
const { query } = require('../../config/database');
const { mapWithConcurrency } = require('../../utils/concurrency');

const WebScraper = require('./collectors/WebScraper');
const NewsMonitor = require('./collectors/NewsMonitor');
const JobScraper = require('./collectors/JobScraper');
const SocialCollector = require('./collectors/SocialCollector');
const LinkedInCollector = require('./collectors/LinkedInCollector');
const BuyerCollector = require('./collectors/BuyerCollector');
const DDG = require('./collectors/ddg');
const BraveScrape = require('./collectors/braveScrape');
const GoogleScrape = require('./collectors/googleScrape');
const Search = require('./collectors/search');
const LeadQuality = require('../leadQuality');

// Maps collector source labels onto the `leads.source` values the UI filters on.
const SOURCE_MAP = {
  WebScraper: 'web_scrape',
  NewsAPI: 'news',
  JobScraper: 'job_board',
  Twitter: 'social',
  Reddit: 'social',
  LinkedIn: 'linkedin',
  LinkedInBuyer: 'linkedin',
  DiscoveryPipeline: 'web_scrape'
};

class DiscoveryService {
  /**
   * Run the discovery pipeline for a given ICP.
   */
  static async run(icpId, triggerType = 'manual') {
    // Resolve before creating the job so an unknown ICP fails the request
    // itself, and so the job row records the ICP actually used rather than the
    // placeholder the UI sent.
    const icp = await this._resolveIcp(icpId);

    // One run at a time per ICP. Each run launches Chromium and spends provider
    // quota, and repeated clicks previously started a dozen overlapping jobs.
    const active = this._findActiveJob(icp.id);
    if (active) {
      const err = new Error(
        `Discovery is already running for "${icp.name}" (job ${active.id}, ${active.progress || 0}% complete).`
      );
      err.code = 'DISCOVERY_ALREADY_RUNNING';
      err.jobId = active.id;
      throw err;
    }

    const jobId = uuidv4();
    const now = new Date().toISOString();

    query(
      `INSERT INTO discovery_jobs (id, icp_id, status, trigger_type, started_at) VALUES (?, ?, ?, ?, ?)`,
      [jobId, icp.id, 'running', triggerType, now]
    );

    // Run asynchronously
    this._executeCollectors(jobId, icp.id).catch(err => {
      logger.error(`Discovery job ${jobId} failed:`, err);
      query(
        `UPDATE discovery_jobs SET status = 'failed', failed_reason = ?, completed_at = ? WHERE id = ?`,
        [err.message, new Date().toISOString(), jobId]
      );
    });

    return jobId;
  }

  static async _executeCollectors(jobId, icpId) {
    const updateProgress = (progress, statusText) => {
      query(
        `UPDATE discovery_jobs SET progress = ?, status_text = ?, last_progress_at = ? WHERE id = ?`,
        [progress, statusText, new Date().toISOString(), jobId]
      );
    };

    try {
      updateProgress(3, 'Initializing discovery parameters...');
      const icp = await this._resolveIcp(icpId);

      // Block detection is per-run, so a previous run's rate limiting does not
      // abort this one before it starts.
      Search.resetBlockState();

      logger.info(`Starting discovery for ICP: ${icp.name} (target ${config.DISCOVERY_TARGET_LEADS} leads)`);
      updateProgress(6, 'Searching web, LinkedIn companies & buyers, news, jobs...');

      // ── Collect ───────────────────────────────────────────────────────────
      // Every source runs; LeadQuality then keeps only convertible prospects
      // so Groq / enrichment work on the best pool — not junk volume.
      const collectors = [
        {
          name: 'WebScraper',
          run: () => WebScraper.searchCompanies(icp, {
            onProgress: ({ phase, queriesRun, totalQueries, candidates, leads, pages, added }) => {
              if (phase === 'search' && totalQueries) {
                const pct = 6 + Math.round((queriesRun / totalQueries) * 18);
                updateProgress(pct, `Searching the web (${queriesRun}/${totalQueries}, ${candidates} candidates)...`);
              } else if (phase === 'directories') {
                updateProgress(22, `Mining ${pages} company-list pages for prospects...`);
              } else if (phase === 'harvested') {
                updateProgress(23, `Found ${added} more companies in listings (${candidates} total)...`);
              } else if (phase === 'profiled') {
                updateProgress(24, `Profiling ${candidates} candidate companies...`);
              } else if (phase === 'extracted') {
                updateProgress(27, `AI kept ${leads} best web companies...`);
              }
            }
          })
        },
        {
          name: 'LinkedInCollector',
          run: () => LinkedInCollector.searchLinkedIn(icp, {
            onProgress: ({ phase, queriesRun, totalQueries, candidates, leads }) => {
              if (phase === 'search' && totalQueries) {
                const pct = 27 + Math.round((queriesRun / totalQueries) * 5);
                updateProgress(pct, `LinkedIn companies (${queriesRun}/${totalQueries}, ${candidates} found)...`);
              } else if (phase === 'enriching') {
                updateProgress(33, `Enriching ${candidates} LinkedIn company pages...`);
              } else if (phase === 'done') {
                updateProgress(35, `LinkedIn companies: ${leads} best matches...`);
              }
            }
          })
        },
        {
          name: 'BuyerCollector',
          run: () => BuyerCollector.searchBuyers(icp)
        },
        { name: 'NewsMonitor', run: () => NewsMonitor.searchNews(icp) },
        { name: 'JobScraper', run: () => JobScraper.searchJobs(icp) },
        { name: 'SocialCollector', run: () => SocialCollector.searchSocial(icp) }
      ];

      const settled = await Promise.allSettled(collectors.map(c => c.run()));

      const rawDiscovered = [];
      const perSource = {};
      settled.forEach((result, i) => {
        const name = collectors[i].name;
        if (result.status === 'fulfilled') {
          const items = result.value || [];
          perSource[name] = items.length;
          rawDiscovered.push(...items);
        } else {
          perSource[name] = 0;
          logger.error(`Collector ${name} failed: ${result.reason?.message || result.reason}`);
        }
      });

      // Intake gate: only best convertible prospects enter enrich + score.
      const allDiscovered = LeadQuality.filterBest(rawDiscovered);
      logger.info(
        `Discovery collected ${rawDiscovered.length} raw → ${allDiscovered.length} best leads: ${JSON.stringify(perSource)}`
      );

      if (allDiscovered.length === 0) {
        // Distinguish "the search engine blocked us" from "nothing matched" —
        // they need completely different responses from the user.
        const message = Search.aborted
          ? 'Search engines blocked the scraper. Retry later, or optionally set BRAVE_API_KEY / SERPER_API_KEY in .env for more reliable volume.'
          : 'No prospects found. Check logs — a source may be rate-limited.';
        updateProgress(100, message);
        query(
          `UPDATE discovery_jobs SET status = 'completed', progress = 100, completed_at = ? WHERE id = ?`,
          [new Date().toISOString(), jobId]
        );
        logger.warn(`Discovery job ${jobId} completed with zero items.`);
        return;
      }

      // ── Persist, enrich and score ─────────────────────────────────────────
      updateProgress(40, `Found ${allDiscovered.length} prospects. Enriching and scoring...`);

      const stats = await this._processItems(allDiscovered, icp, updateProgress);

      query(
        `UPDATE discovery_jobs SET status = 'completed', progress = 100, status_text = ?, completed_at = ? WHERE id = ?`,
        [
          `Completed: ${stats.created} new leads, ${stats.duplicates} duplicates, ${stats.failed} failed.`,
          new Date().toISOString(),
          jobId
        ]
      );

      query(`UPDATE icps SET last_run_at = ? WHERE id = ?`, [new Date().toISOString(), icp.id]);

      logger.info(
        `Discovery job ${jobId} completed. items=${allDiscovered.length} ` +
        `new=${stats.created} duplicate=${stats.duplicates} failed=${stats.failed}`
      );
    } finally {
      // Chromium outlives the run unless it is closed explicitly.
      // Scrapling sidecar stays up for enrichment / the next discovery run.
      await Promise.allSettled([
        DDG.shutdown(),
        BraveScrape.shutdown(),
        GoogleScrape.shutdown()
      ]);
    }
  }

  /**
   * A genuinely in-flight job for this ICP, if any.
   *
   * Jobs are marked 'running' in the database, so a crash or restart would
   * otherwise leave a row that blocks every future run. Anything older than the
   * stale threshold is treated as abandoned and swept to 'failed'.
   */
  static _findActiveJob(icpId) {
    const running = query(
      `SELECT id, progress, started_at, last_progress_at FROM discovery_jobs
       WHERE icp_id = ? AND status = 'running'
       ORDER BY started_at DESC`,
      [icpId]
    ).rows;

    let active = null;
    for (const job of running) {
      if (this._isStalled(job)) this._failStalled(job);
      else if (!active) active = job;
    }
    return active;
  }

  /**
   * A job is stalled when it has not written progress recently.
   *
   * Judging by total runtime alone would either kill legitimate long runs or
   * let a dead one linger; the heartbeat distinguishes "slow" from "gone",
   * which matters because discovery runs in-process and does not survive a
   * server restart.
   */
  static _isStalled(job) {
    const heartbeat = new Date(job.last_progress_at || job.started_at).getTime();
    if (!Number.isFinite(heartbeat)) return true;
    return Date.now() - heartbeat > config.DISCOVERY_STALE_JOB_MINUTES * 60000;
  }

  /**
   * Sweep every stalled job, regardless of ICP. Used by the jobs listing so it
   * cannot show a run as 'running' when nothing is executing it.
   */
  static sweepStalledJobs() {
    const running = query(
      `SELECT id, started_at, last_progress_at FROM discovery_jobs WHERE status = 'running'`
    ).rows;
    let swept = 0;
    for (const job of running) {
      if (this._isStalled(job)) { this._failStalled(job); swept++; }
    }
    return swept;
  }

  static _failStalled(job) {
    query(
      `UPDATE discovery_jobs SET status = 'failed', failed_reason = ?, completed_at = ? WHERE id = ?`,
      [
        'Run stopped before finishing (server restarted or the process was killed). Start discovery again.',
        new Date().toISOString(),
        job.id
      ]
    );
    logger.warn(`Marked stalled discovery job ${job.id} as failed (last progress: ${job.last_progress_at || job.started_at})`);
  }

  /**
   * Resolve the requested ICP.
   *
   * Only the explicit placeholders fall back to the newest active ICP. A real
   * but unknown id is an error: silently substituting a different ICP means the
   * user runs discovery against one profile while the dashboard shows another,
   * which is indistinguishable from "changing the target ICP does nothing".
   */
  static async _resolveIcp(icpId) {
    // The seeded starter ICP genuinely has the id 'default', so always try a
    // direct lookup before treating the value as a placeholder.
    if (icpId) {
      const direct = await ICP.getById(icpId);
      if (direct) return direct;
    }

    const isPlaceholder = !icpId || icpId === 'default' || icpId === 'undefined' || icpId === 'null';
    if (!isPlaceholder) {
      throw new Error(`ICP ${icpId} not found. Select or re-save a target ICP and try again.`);
    }

    const activeIcps = await ICP.listActive();
    if (!activeIcps || activeIcps.length === 0) {
      throw new Error('No active ICP configurations found. Please create an ICP first.');
    }

    const icp = activeIcps[0];
    logger.info(`No ICP id supplied ("${icpId}"); using most recent active ICP: ${icp.name} (${icp.id})`);
    return icp;
  }

  /**
   * Insert, enrich and score discovered items with bounded concurrency.
   *
   * At 150+ leads a sequential loop spends minutes waiting on enrichment HTTP
   * calls, so items run in parallel — capped to stay inside provider rate
   * limits. better-sqlite3 is synchronous, so DB writes remain safe.
   */
  static async _processItems(items, icp, updateProgress) {
    const total = items.length;
    const stats = { created: 0, duplicates: 0, failed: 0 };
    let completed = 0;

    // Throttle progress writes: one UPDATE per item would be hundreds of
    // needless statements.
    const progressEvery = Math.max(1, Math.floor(total / 20));

    await mapWithConcurrency(items, config.ENRICHMENT_CONCURRENCY, async item => {
      try {
        if (!item.company_name) {
          stats.failed++;
          return;
        }

        const rawSource = item.source || item.signal?.source || 'DiscoveryPipeline';

        // Carry every field the collectors resolved — the AI extractor works to
        // produce firmographics, and dropping them here would waste that.
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
          source: SOURCE_MAP[rawSource] || 'web_scrape',
          source_url: item.source_url || item.signal?.source_url || null,
          raw_signal_data: item.raw_signal_data || null
        });

        if (isNew) stats.created++;
        else stats.duplicates++;

        // Signals attach to new and existing leads alike: a repeat mention is
        // fresh evidence of intent.
        if (item.signal) {
          await Signal.create(lead.id, item.signal);
        } else if (item.raw_signal_data) {
          await Signal.create(lead.id, {
            signal_type: 'web',
            source: rawSource,
            source_url: item.source_url,
            title: item.company_name ? `${item.company_name} found via ${rawSource}` : `Found via ${rawSource}`,
            content: JSON.stringify(item.raw_signal_data),
            relevance_score: 0.5
          });
        }

        if (isNew) {
          await EnrichmentService.enrich(lead.id);
          await ScoringService.compute(lead.id);
        }
      } catch (itemErr) {
        stats.failed++;
        logger.warn(`Failed to process item ${item.company_name}: ${itemErr.message}`);
      } finally {
        completed++;
        if (completed % progressEvery === 0 || completed === total) {
          const pct = Math.min(99, 40 + Math.round((completed / total) * 59));
          updateProgress(pct, `Public enrichment + scoring (${completed}/${total})...`);
        }
      }
    });

    return stats;
  }

  static async getJobStatus(jobId) {
    const result = query('SELECT * FROM discovery_jobs WHERE id = ?', [jobId]);
    let job = result.rows[0];
    if (!job) return null;

    // Surface a dead run to the poller instead of reporting 'running' forever,
    // which left the UI stuck on a progress bar that could never advance.
    if (job.status === 'running' && this._isStalled(job)) {
      this._failStalled(job);
      job = query('SELECT * FROM discovery_jobs WHERE id = ?', [jobId]).rows[0];
    }

    return {
      id: job.id,
      icp_id: job.icp_id,
      status: job.status,
      state: job.status, // frontend checks state
      progress: job.progress || 0,
      statusText: job.status_text || '',
      failedReason: job.failed_reason || '',
      started_at: job.started_at,
      completed_at: job.completed_at
    };
  }
}

module.exports = DiscoveryService;
