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
const runBudget = require('./runBudget');
const providerHealth = require('../providerHealth');

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

// ── Scheduler state ─────────────────────────────────────────────────────────
// One discovery run executes at a time, process-wide. The limit is not
// per-ICP: a run holds Chromium, the search engines' patience and the AI rate
// limit windows, all of which are shared, so two concurrent runs made each
// other fail rather than doubling throughput.
//
// Requests that arrive while a run is in flight are queued instead of
// rejected, and the queue only starts the next run once the cooldown has
// elapsed — giving search engines and the per-minute AI budgets time to
// recover before the next run leans on them.
const queue = [];              // [{ jobId, icpId, icpName, enqueuedAt }]
let activeRun = null;          // { jobId, icpId }
let nextRunAllowedAt = 0;      // cooldown expiry after the previous run
let pumpTimer = null;

class DiscoveryService {
  /**
   * Queue a discovery run for an ICP.
   *
   * Returns `{ jobId, state, position, startsInMs }`. `state` is 'running' when
   * the run started immediately and 'queued' when it is waiting — either behind
   * another run or behind the cooldown that follows one.
   */
  static async run(icpId, triggerType = 'manual') {
    // Resolve before creating the job so an unknown ICP fails the request
    // itself, and so the job row records the ICP actually used rather than the
    // placeholder the UI sent.
    const icp = await this._resolveIcp(icpId);

    // Repeated clicks (and the dashboard's auto-run) must not stack up runs for
    // the same target: attach to the one already in flight or waiting.
    const active = this._findActiveJob(icp.id);
    if (active) {
      logger.info(`Discovery for "${icp.name}" already ${active.status}; attaching to job ${active.id}.`);
      return {
        jobId: active.id,
        state: active.status,
        attached: true,
        position: this._queuePosition(active.id),
        startsInMs: active.status === 'queued' ? this._estimatedStartMs(active.id) : 0
      };
    }

    if (queue.length >= config.DISCOVERY_QUEUE_LIMIT) {
      const err = new Error(
        `${queue.length} discovery runs are already waiting. Let them finish before queueing another.`
      );
      err.code = 'DISCOVERY_QUEUE_FULL';
      throw err;
    }

    const jobId = uuidv4();
    const now = new Date().toISOString();

    // Every job starts life as 'queued'. The pump promotes it to 'running' when
    // its turn comes, so the row and the scheduler can never disagree about
    // what is executing.
    query(
      `INSERT INTO discovery_jobs (id, icp_id, status, trigger_type, started_at, last_progress_at, progress, status_text)
       VALUES (?, ?, 'queued', ?, ?, ?, 0, ?)`,
      [jobId, icp.id, triggerType, now, now, 'Queued...']
    );

    queue.push({ jobId, icpId: icp.id, icpName: icp.name, enqueuedAt: Date.now() });
    this._pump();

    const state = activeRun?.jobId === jobId ? 'running' : 'queued';
    return {
      jobId,
      state,
      attached: false,
      position: this._queuePosition(jobId),
      startsInMs: state === 'queued' ? this._estimatedStartMs(jobId) : 0
    };
  }

  /**
   * Start the next queued run if nothing is executing and the cooldown has
   * passed; otherwise arm a timer for the moment it has.
   */
  static _pump() {
    if (activeRun || queue.length === 0) return;

    const wait = nextRunAllowedAt - Date.now();
    if (wait > 0) {
      this._describeQueue();
      if (!pumpTimer) {
        pumpTimer = setTimeout(() => {
          pumpTimer = null;
          this._pump();
        }, wait + 250);
        if (typeof pumpTimer.unref === 'function') pumpTimer.unref();
      }
      return;
    }

    const next = queue.shift();
    activeRun = { jobId: next.jobId, icpId: next.icpId };

    const now = new Date().toISOString();
    query(
      `UPDATE discovery_jobs SET status = 'running', started_at = ?, last_progress_at = ?, status_text = ? WHERE id = ?`,
      [now, now, 'Starting discovery...', next.jobId]
    );

    const waited = Math.round((Date.now() - next.enqueuedAt) / 1000);
    logger.info(
      `Discovery job ${next.jobId} starting for "${next.icpName}"` +
      (waited > 2 ? ` after waiting ${waited}s in the queue.` : '.')
    );

    this._executeCollectors(next.jobId, next.icpId)
      .catch(err => {
        logger.error(`Discovery job ${next.jobId} failed:`, err);
        query(
          `UPDATE discovery_jobs SET status = 'failed', failed_reason = ?, completed_at = ? WHERE id = ?`,
          [err.message, new Date().toISOString(), next.jobId]
        );
      })
      .finally(() => {
        activeRun = null;
        // The cooldown is the point of the queue: back-to-back runs hit the
        // same search engines and AI quota that the previous run just drained.
        nextRunAllowedAt = Date.now() + config.DISCOVERY_COOLDOWN_MS;
        if (queue.length > 0) {
          logger.info(
            `Discovery cooldown: next of ${queue.length} queued run(s) starts in ` +
            `${Math.round(config.DISCOVERY_COOLDOWN_MS / 1000)}s.`
          );
        }
        this._pump();
      });

    this._describeQueue();
  }

  /** Keep every waiting job's row explaining why it has not started yet. */
  static _describeQueue() {
    queue.forEach((entry, index) => {
      const startsIn = Math.round(this._estimatedStartMs(entry.jobId) / 1000);
      const text = index === 0 && !activeRun
        ? `Waiting out the cooldown between runs — starts in about ${startsIn}s.`
        : `Queued behind ${index + 1} run${index === 0 ? '' : 's'} — starts in about ${Math.round(startsIn / 60)} min.`;
      query(
        `UPDATE discovery_jobs SET status_text = ?, last_progress_at = ? WHERE id = ? AND status = 'queued'`,
        [text, new Date().toISOString(), entry.jobId]
      );
    });
  }

  /** 0 when running, 1-based place in line when queued, null when unknown. */
  static _queuePosition(jobId) {
    if (activeRun?.jobId === jobId) return 0;
    const index = queue.findIndex(entry => entry.jobId === jobId);
    return index === -1 ? null : index + 1;
  }

  /**
   * Rough time until a queued job starts: the cooldown still to run, plus a
   * whole run and cooldown for everything ahead of it.
   */
  static _estimatedStartMs(jobId) {
    const index = queue.findIndex(entry => entry.jobId === jobId);
    if (index === -1) return 0;

    const cooldownLeft = Math.max(0, nextRunAllowedAt - Date.now());
    const perRun = config.DISCOVERY_RUN_BUDGET_MS + config.DISCOVERY_COOLDOWN_MS;
    const runsAhead = index + (activeRun ? 1 : 0);
    return cooldownLeft + Math.max(0, runsAhead) * perRun;
  }

  /** Scheduler state for the status endpoint. */
  static schedulerStatus() {
    return {
      running: activeRun ? activeRun.jobId : null,
      queued: queue.length,
      cooldownMs: config.DISCOVERY_COOLDOWN_MS,
      cooldownRemainingMs: Math.max(0, nextRunAllowedAt - Date.now()),
      runBudgetMs: config.DISCOVERY_RUN_BUDGET_MS
    };
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

      // Bound the run by the clock rather than by lead counts, so every source
      // gets to contribute and the job still finishes predictably.
      runBudget.start(config.DISCOVERY_RUN_BUDGET_MS);

      logger.info(`Starting discovery for ICP: ${icp.name} (target ${config.DISCOVERY_TARGET_LEADS} leads)`);

      // Name the sources that will not contribute, once per run. Otherwise a
      // quota-exhausted provider looks like a code failure in the logs.
      const parked = providerHealth.snapshot();
      if (Object.keys(parked).length > 0) {
        logger.warn(
          `Sources unavailable this run: ` +
          Object.entries(parked).map(([name, info]) => `${name} (${info.reason})`).join('; ')
        );
      }

      updateProgress(6, 'Searching web, LinkedIn companies & buyers, news, jobs...');

      // ── Collect ───────────────────────────────────────────────────────────
      // Every source runs; LeadQuality then keeps only convertible prospects
      // so Groq / enrichment work on the best pool — not junk volume.
      // LinkedIn company + buyer run sequentially — both depend on Google and
      // parallel bursts trip rate limits that wipe LinkedIn volume to zero.
      const webAndOther = [
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
        { name: 'NewsMonitor', run: () => NewsMonitor.searchNews(icp) },
        { name: 'JobScraper', run: () => JobScraper.searchJobs(icp) },
        { name: 'SocialCollector', run: () => SocialCollector.searchSocial(icp) }
      ];

      const settledOther = await Promise.allSettled(webAndOther.map(c => c.run()));

      // Both LinkedIn collectors depend on a search source that indexes public
      // LinkedIn pages. When there is none, skipping them hands their share of
      // the collection budget back to the sources that do work, instead of
      // spending it on queries that can only return LinkedIn's own login page.
      const linkedInSource = Search.linkedInViable();
      let linkedInCompanies = [];
      let linkedInBuyers = [];

      if (!linkedInSource.ok) {
        logger.warn(`Skipping LinkedIn company + buyer discovery: ${linkedInSource.reason}`);
        updateProgress(39, 'LinkedIn discovery unavailable (needs SERPER_API_KEY or BRAVE_API_KEY)...');
      } else {
        updateProgress(30, 'Searching LinkedIn company pages...');
        try {
          linkedInCompanies = await LinkedInCollector.searchLinkedIn(icp, {
            onProgress: ({ phase, queriesRun, totalQueries, candidates, leads }) => {
              if (phase === 'search' && totalQueries) {
                const pct = 30 + Math.round((queriesRun / totalQueries) * 5);
                updateProgress(pct, `LinkedIn companies (${queriesRun}/${totalQueries}, ${candidates} found)...`);
              } else if (phase === 'enriching') {
                updateProgress(36, `Enriching ${candidates} LinkedIn company pages...`);
              } else if (phase === 'done') {
                updateProgress(38, `LinkedIn companies: ${leads} best matches...`);
              }
            }
          });
        } catch (err) {
          logger.error(`Collector LinkedInCollector failed: ${err.message}`);
        }

        updateProgress(39, 'Searching LinkedIn buyers...');
        try {
          linkedInBuyers = await BuyerCollector.searchBuyers(icp);
        } catch (err) {
          logger.error(`Collector BuyerCollector failed: ${err.message}`);
        }
      }

      const collectors = webAndOther;
      const settled = [
        ...settledOther,
        { status: 'fulfilled', value: linkedInCompanies },
        { status: 'fulfilled', value: linkedInBuyers }
      ];
      collectors.push(
        { name: 'LinkedInCollector', run: async () => linkedInCompanies },
        { name: 'BuyerCollector', run: async () => linkedInBuyers }
      );

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
      // The ICP is passed so the geography filter applies here, at the one
      // point that sees every collector's output.
      const allDiscovered = LeadQuality.filterBest(rawDiscovered, icp);
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
      runBudget.clear();
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
   * A genuinely in-flight job for this ICP — running now or waiting its turn.
   *
   * Jobs are marked in the database, so a crash or restart would otherwise
   * leave a row that blocks every future run. Anything the scheduler does not
   * know about, or that stopped writing progress, is treated as abandoned.
   */
  static _findActiveJob(icpId) {
    const rows = query(
      `SELECT id, status, progress, started_at, last_progress_at FROM discovery_jobs
       WHERE icp_id = ? AND status IN ('running', 'queued')
       ORDER BY started_at DESC`,
      [icpId]
    ).rows;

    let active = null;
    for (const job of rows) {
      if (this._isStalled(job)) this._failStalled(job);
      else if (!active) active = job;
    }
    return active;
  }

  /**
   * A job is stalled when nothing is actually working on it.
   *
   * The scheduler holds the truth: a row is live only while it is the active
   * run or sits in the queue. Anything else marked running/queued is left over
   * from a process that died — discovery runs in memory and does not survive a
   * restart. The progress heartbeat is still checked as a second signal, for a
   * run whose collector wedged without throwing.
   */
  static _isStalled(job) {
    const known = activeRun?.jobId === job.id || queue.some(entry => entry.jobId === job.id);
    if (!known) return true;

    // A queued job is idle by definition, so only running jobs are held to the
    // heartbeat. _describeQueue keeps queued rows fresh anyway.
    if (job.status === 'queued') return false;

    const heartbeat = new Date(job.last_progress_at || job.started_at).getTime();
    if (!Number.isFinite(heartbeat)) return true;
    return Date.now() - heartbeat > config.DISCOVERY_STALE_JOB_MINUTES * 60000;
  }

  /**
   * Sweep every stalled job, regardless of ICP. Used by the jobs listing so it
   * cannot show a run as 'running' when nothing is executing it.
   */
  static sweepStalledJobs(force = false) {
    const rows = query(
      `SELECT id, status, started_at, last_progress_at FROM discovery_jobs
       WHERE status IN ('running', 'queued')`
    ).rows;
    let swept = 0;
    for (const job of rows) {
      if (force || this._isStalled(job)) { this._failStalled(job); swept++; }
    }
    return swept;
  }

  static _failStalled(job) {
    query(
      `UPDATE discovery_jobs SET status = 'failed', failed_reason = ?, completed_at = ? WHERE id = ?`,
      [
        job.status === 'queued'
          ? 'Queued run was lost when the server restarted. Start discovery again.'
          : 'Run stopped before finishing (server restarted or the process was killed). Start discovery again.',
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
    if ((job.status === 'running' || job.status === 'queued') && this._isStalled(job)) {
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
      // Queue position and wait, so the UI can explain a run that has not
      // started yet rather than showing a progress bar stuck at zero.
      queuePosition: this._queuePosition(job.id),
      startsInMs: job.status === 'queued' ? this._estimatedStartMs(job.id) : 0,
      started_at: job.started_at,
      completed_at: job.completed_at
    };
  }
}

module.exports = DiscoveryService;
