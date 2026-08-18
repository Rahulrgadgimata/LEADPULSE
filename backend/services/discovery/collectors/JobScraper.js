const logger = require('../../../utils/logger');
const Search = require('./search');
const { isNonProspect, registrableName } = require('./domainFilter');
const runBudget = require('../runBudget');

// Applicant-tracking hosts put the employer in the first path segment
// (boards.greenhouse.io/acme/jobs/123), so the company is recoverable even
// though the host itself is not a prospect.
const ATS_HOSTS = new Set([
  'greenhouse', 'lever', 'ashbyhq', 'workable', 'bamboohr', 'smartrecruiters',
  'recruitee', 'teamtailor', 'personio', 'jazzhr', 'breezy', 'workday',
  'myworkdayjobs', 'applytojob', 'freshteam', 'zohorecruit', 'keka', 'darwinbox',
]);

/** Comparable form of a company name or domain label. */
const normalise = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

class JobScraper {
  /**
   * Scrapes job boards via search engine for roles related to ICP.
   * Detects buying intent — if a company is hiring a "Head of DevOps", they are
   * likely investing in the infrastructure our ICP targets.
   */
  static async searchJobs(icp) {
    const signals = [];
    const jobTitles = JSON.parse(icp.job_titles || '[]');
    const geographies = JSON.parse(icp.geographies || '[]');

    if (jobTitles.length === 0) return signals;

    // Search titles separately — OR-ing four long titles together returns
    // mostly irrelevant aggregator pages. Two constraints from the DDG HTML
    // endpoint shape these queries:
    //   - quoted phrases ("Head of DevOps") return an empty result set, so
    //     titles are passed unquoted;
    //   - a single `site:` term works, but OR-ing several triggers the
    //     anti-bot page, so ATS hosts are probed one query at a time.
    // Each query carries the title it came from, so a result missing its own
    // headline can still be labelled correctly.
    // Only applicant-tracking URLs name an employer, so the queries aim
    // straight at the boards. Two titles against two ATS hosts produced too
    // little to matter — the collector contributed nothing on entire runs while
    // news filled the pipeline — so the sweep is wider and carries the
    // geography, which also keeps the employers inside the target region.
    const geo = geographies[0] || '';
    const atsSites = [
      'boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com',
      'apply.workable.com', 'careers.smartrecruiters.com'
    ];

    const queries = [];
    for (const title of jobTitles.slice(0, 3)) {
      for (const site of atsSites) {
        queries.push({ text: `site:${site} ${title} ${geo}`.trim(), title });
      }
      // Without the site: operator, for engines that handle it poorly.
      queries.push({ text: `${title} jobs greenhouse lever ${geo}`.trim(), title });
      queries.push({ text: `${title} hiring careers ${geo}`.trim(), title });
    }

    // One ATS employer often appears several times (job page, apply page, board
    // root), which would otherwise create duplicate signals for one company.
    const seenEmployers = new Set();

    for (const { text: query, title } of queries) {
      if (runBudget.collectExpired(runBudget.PRIMARY_SHARE)) {
        logger.info('JobScraper stopped early: collection budget reached.');
        break;
      }
      logger.info(`JobScraper searching: ${query}`);

      const results = await Search.run(query, 6);

      for (const res of results) {
        try {
          const parsed = new URL(res.url);
          const domain = parsed.hostname.replace(/^www\./, '');

          // Only an applicant-tracking URL names the employer. Every other
          // result is merely a page that ranked for the job title, and turning
          // those into leads is what filled the pipeline with dictionary.com,
          // merriam-webster.com and windowsforum.kr — none of which are hiring
          // anyone. A hiring signal needs a company, not a matching keyword.
          const employer = this._employerFromAts(parsed);
          if (!employer) {
            logger.debug(`JobScraper skipping non-employer result: ${domain}`);
            continue;
          }

          const key = employer.toLowerCase();
          if (seenEmployers.has(key)) continue;
          seenEmployers.add(key);

          const companyName = employer.charAt(0).toUpperCase() + employer.slice(1);
          // Intake quality requires a website, so resolve the employer's own
          // domain from its name.
          const companyWebsite = await this._guessWebsite(companyName, employer);
          if (!companyWebsite) continue;

          signals.push({
            company_name: companyName,
            company_website: companyWebsite,
            contact_title: title,
            source: 'JobScraper',
            source_url: res.url,
            raw_signal_data: { icp_fit: 'strong', hiring_title: title },
            signal: {
              signal_type: 'job_posting',
              source: 'JobScraper',
              source_url: res.url,
              title: res.title || `Hiring: ${title}`,
              content: res.snippet,
              relevance_score: 0.9
            }
          });
        } catch (e) {
          // ignore invalid URLs
        }
      }
    }

    const LeadQuality = require('../../leadQuality');
    const best = LeadQuality.filterBest(signals);
    logger.info(`JobScraper produced ${best.length} best hiring-intent leads`);
    return best;
  }

  /**
   * Resolve the employer's own domain.
   *
   * The match is verified rather than assumed: taking the first non-aggregator
   * result for `"<name>" official website` attributed unrelated domains
   * (clair.com, startups.com, xapo61.com) to whichever ATS slug was being
   * looked up. An unverifiable employer yields null and is dropped.
   */
  static async _guessWebsite(companyName, slug) {
    const wanted = normalise(slug);
    try {
      const results = await Search.run(
        `"${companyName}" official website -site:linkedin.com -site:greenhouse.io -site:lever.co`,
        5
      );
      for (const result of results) {
        let domain;
        try {
          domain = new URL(result.url).hostname.replace(/^www\./, '');
        } catch (e) {
          continue;
        }
        if (isNonProspect(domain)) continue;
        if (this._domainMatchesEmployer(domain, wanted)) return domain;
      }
    } catch (e) { /* soft */ }

    // Last resort: the slug as a .com, which at least cannot be a mismatch.
    const guess = `${wanted}.com`;
    if (wanted.length >= 4 && !isNonProspect(guess)) return guess;
    return null;
  }

  /** Does this domain plausibly belong to the employer we looked up? */
  static _domainMatchesEmployer(domain, wanted) {
    if (wanted.length < 4) return false;
    const name = normalise(registrableName(domain));
    if (!name) return false;
    return name === wanted || name.includes(wanted) || wanted.includes(name);
  }

  /**
   * Recover the employer slug from an ATS URL, e.g.
   * "boards.greenhouse.io/acmecorp/jobs/123" -> "acmecorp", and the
   * subdomain form "acmecorp.recruitee.com" -> "acmecorp".
   * Returns null when the host is not a known ATS.
   */
  static _employerFromAts(parsedUrl) {
    const host = parsedUrl.hostname.replace(/^www\./, '');
    if (!ATS_HOSTS.has(registrableName(host))) return null;

    const first = parsedUrl.pathname.split('/').filter(Boolean)[0];
    const generic = ['jobs', 'job', 'companies', 'company', 'embed', 'search', 'en', 'o', 'careers'];

    if (first && !generic.includes(first.toLowerCase()) && first.length >= 2 && first.length <= 40) {
      return first.replace(/[-_]+/g, ' ').trim();
    }

    // Subdomain-hosted boards put the employer in front of the ATS host.
    const labels = host.split('.');
    if (labels.length >= 3) {
      const sub = labels[0].toLowerCase();
      if (!['boards', 'jobs', 'apply', 'careers', 'www', 'api'].includes(sub) && sub.length >= 2) {
        return sub.replace(/[-_]+/g, ' ').trim();
      }
    }

    return null;
  }
}

module.exports = JobScraper;
