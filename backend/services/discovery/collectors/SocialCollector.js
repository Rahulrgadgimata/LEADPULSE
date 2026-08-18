const axios = require('axios');
const logger = require('../../../utils/logger');
const config = require('../../../config/env');
const { isNonProspect } = require('./domainFilter');
const { sleep } = require('../../../utils/concurrency');
const providerHealth = require('../../providerHealth');

const X_SEARCH_URL = 'https://api.twitter.com/2/tweets/search/recent';

// X caps recent-search queries at 512 characters on Basic and 1024 on Pro;
// staying under the lower bound keeps the same query valid on either plan.
const MAX_QUERY_LENGTH = 480;

class SocialCollector {
  /**
   * Search social channels for buying signals related to ICP keywords.
   *
   * Both sources are gated on credentials and fail soft — a social outage must
   * not take down the whole discovery run. Failures log the exact provider
   * status so a plan/quota problem is distinguishable from a code bug.
   */
  static async searchSocial(icp) {
    const keywords = this._parseList(icp.keywords);
    if (keywords.length === 0) return [];

    const [twitter, reddit] = await Promise.all([
      this._searchTwitter(keywords),
      this._searchReddit(keywords)
    ]);

    const signals = [...twitter, ...reddit].filter(s => {
      // Only keep social hits we can turn into a real company outreach target.
      const website = s.company_website;
      const name = String(s.company_name || '');
      if (!website) return false;
      if (/^@/.test(name)) return false;
      return true;
    });
    logger.info(`SocialCollector produced ${signals.length} company-ready signals (X: ${twitter.length}, Reddit: ${reddit.length} raw)`);
    return signals;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // X / Twitter
  // ──────────────────────────────────────────────────────────────────────────

  static async _searchTwitter(keywords) {
    const signals = [];

    if (!config.TWITTER_BEARER_TOKEN) {
      logger.warn('TWITTER_BEARER_TOKEN missing. Skipping X/Twitter.');
      return signals;
    }

    // The token is valid but the X account has no credits (HTTP 402), which no
    // retry fixes. Once seen, skip the source for the rest of the process
    // instead of opening the same doomed request on every run.
    if (providerHealth.isDisabled('twitter')) {
      logger.debug(`X/Twitter skipped: ${providerHealth.reasonFor('twitter')}`);
      return signals;
    }

    const query = this._buildTwitterQuery(keywords);
    let nextToken = null;
    let page = 0;

    while (page < config.TWITTER_MAX_PAGES) {
      page++;

      let data;
      try {
        data = await this._twitterRequest(query, nextToken);
      } catch (err) {
        this._logTwitterFailure(err, page);
        break;
      }

      const tweets = data?.data || [];
      if (tweets.length === 0) break;

      // Expansions let a tweet resolve to the account behind it, so a signal
      // carries a real company name instead of a numeric author id.
      const users = new Map();
      for (const user of data?.includes?.users || []) users.set(user.id, user);

      for (const tweet of tweets) {
        const signal = this._toSignal(tweet, users.get(tweet.author_id));
        if (signal) signals.push(signal);
      }

      nextToken = data?.meta?.next_token;
      if (!nextToken) break;
    }

    if (signals.length > 0) {
      logger.info(`X/Twitter returned ${signals.length} signals across ${page} page(s)`);
    }
    return signals;
  }

  /**
   * Build a recent-search query, trimming keywords until it fits the plan limit.
   */
  static _buildTwitterQuery(keywords) {
    const suffix = ') -is:retweet -is:reply lang:en';
    let selected = keywords.slice(0, 6);

    while (selected.length > 1) {
      const candidate = '(' + selected.map(k => (k.includes(' ') ? `"${k}"` : k)).join(' OR ') + suffix;
      if (candidate.length <= MAX_QUERY_LENGTH) return candidate;
      selected = selected.slice(0, -1);
    }

    return '(' + selected.map(k => (k.includes(' ') ? `"${k}"` : k)).join(' OR ') + suffix;
  }

  /**
   * One search request, retrying on rate limits and transient 5xx.
   */
  static async _twitterRequest(query, nextToken) {
    const maxAttempts = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await axios.get(X_SEARCH_URL, {
          params: {
            query,
            max_results: Math.min(Math.max(config.TWITTER_RESULTS_PER_PAGE, 10), 100),
            'tweet.fields': 'created_at,author_id,public_metrics,entities',
            expansions: 'author_id',
            'user.fields': 'name,username,description,entities,public_metrics,location,verified',
            ...(nextToken ? { next_token: nextToken } : {})
          },
          headers: { Authorization: `Bearer ${config.TWITTER_BEARER_TOKEN}` },
          timeout: 20000
        });
        return res.data;
      } catch (err) {
        lastError = err;
        const status = err.response?.status;

        // 402/401/403 are account-level and will not change on retry.
        if (status && ![429, 500, 502, 503, 504].includes(status)) throw err;
        if (attempt === maxAttempts) throw err;

        // X sends x-rate-limit-reset as an epoch second.
        const reset = Number(err.response?.headers?.['x-rate-limit-reset']);
        let delay = 1000 * Math.pow(2, attempt);
        if (status === 429 && Number.isFinite(reset)) {
          const untilReset = reset * 1000 - Date.now();
          // Cap the wait: a full 15-minute window would stall the whole run.
          if (untilReset > 0) delay = Math.min(untilReset + 1000, 60000);
        }

        logger.debug(`X/Twitter attempt ${attempt} failed (${status || err.code}); retrying in ${delay}ms`);
        await sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * Convert a tweet plus its author into a lead-bearing signal. Returns null
   * when the account cannot plausibly represent a company.
   */
  static _toSignal(tweet, user) {
    if (!tweet?.text) return null;

    let companyName = null;
    let companyWebsite = null;

    if (user) {
      // The account's own link is the best available company domain.
      const linked = user.entities?.url?.urls?.[0]?.expanded_url;
      if (linked) {
        try {
          const domain = new URL(linked).hostname.replace(/^www\./, '');
          if (!isNonProspect(domain)) companyWebsite = domain;
        } catch (e) { /* unusable url */ }
      }

      const name = String(user.name || '').trim();
      // Personal accounts make poor company records; prefer names that look
      // like an organisation or that come with a corporate domain.
      if (name && (companyWebsite || /\b(inc|labs|technologies|systems|software|solutions|group|hq|io|ai)\b/i.test(name))) {
        companyName = name.replace(/\s*\b(inc|llc|ltd|corp)\.?$/i, '').trim();
      } else if (companyWebsite) {
        const base = companyWebsite.split('.')[0];
        companyName = base.charAt(0).toUpperCase() + base.slice(1);
      }
    }

    // Without a resolvable company the tweet is still a signal, but it is
    // attributed to the handle rather than inventing a company.
    if (!companyName) {
      const handle = user?.username;
      if (!handle) return null;
      companyName = `@${handle}`;
    }

    const metrics = tweet.public_metrics || {};
    const engagement = (metrics.like_count || 0) + (metrics.retweet_count || 0) + (metrics.reply_count || 0);

    return {
      company_name: companyName,
      company_website: companyWebsite,
      source: 'Twitter',
      signal: {
        signal_type: 'social',
        source: 'Twitter',
        source_url: `https://twitter.com/${user?.username || 'i/web'}/status/${tweet.id}`,
        title: user?.name ? `${user.name} on X` : 'X post matching ICP keywords',
        content: tweet.text.slice(0, 2000),
        // Engagement is a weak popularity proxy; keep it a modest bump.
        relevance_score: Math.min(0.6 + Math.min(engagement, 100) / 500, 0.8)
      }
    };
  }

  static _logTwitterFailure(err, page) {
    const status = err.response?.status;
    const detail = err.response?.data?.detail || err.response?.data?.title || err.message;

    // Account-level refusals park the source; a 429 or a network blip does not.
    providerHealth.noteFailure('twitter', err);

    if (status === 402) {
      logger.warn(
        `X/Twitter search unavailable (HTTP 402: ${detail}). The bearer token is accepted, ` +
        `but recent search needs an X API plan with available credits. Add credits at ` +
        `developer.x.com, or unset TWITTER_BEARER_TOKEN to skip this source cleanly.`
      );
    } else if (status === 403) {
      logger.warn(`X/Twitter denied the request (HTTP 403: ${detail}). The plan likely lacks recent-search access.`);
    } else if (status === 401) {
      logger.warn(`X/Twitter rejected the bearer token (HTTP 401: ${detail}). Check TWITTER_BEARER_TOKEN.`);
    } else if (status === 429) {
      logger.warn(`X/Twitter rate limit not cleared after retries (HTTP 429) on page ${page}. Keeping results gathered so far.`);
    } else {
      logger.warn(`X/Twitter collector failed on page ${page} (HTTP ${status || 'n/a'}): ${detail}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Reddit — optional, requires an OAuth "script" app
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Reddit's public .json endpoints return 403 for server-side callers
   * regardless of User-Agent, so OAuth credentials are required. Set
   * REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET to enable this source.
   */
  static async _searchReddit(keywords) {
    const signals = [];

    if (!config.REDDIT_CLIENT_ID || !config.REDDIT_CLIENT_SECRET) {
      logger.debug('Reddit credentials not set; skipping Reddit.');
      return signals;
    }

    let token;
    try {
      const auth = Buffer.from(`${config.REDDIT_CLIENT_ID}:${config.REDDIT_CLIENT_SECRET}`).toString('base64');
      const tokenRes = await axios.post(
        'https://www.reddit.com/api/v1/access_token',
        new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
        {
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': config.REDDIT_USER_AGENT
          },
          timeout: 15000
        }
      );
      token = tokenRes.data?.access_token;
    } catch (err) {
      logger.warn(`Reddit OAuth token request failed (HTTP ${err.response?.status || 'n/a'}): ${err.response?.data?.message || err.message}`);
      return signals;
    }

    if (!token) {
      logger.warn('Reddit OAuth returned no access token. Skipping Reddit.');
      return signals;
    }

    try {
      const res = await axios.get('https://oauth.reddit.com/search', {
        params: { q: keywords.slice(0, 3).join(' OR '), limit: 25, sort: 'new', t: 'month' },
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': config.REDDIT_USER_AGENT
        },
        timeout: 15000
      });

      for (const child of res.data?.data?.children || []) {
        const post = child.data;
        if (!post || post.over_18) continue;

        signals.push({
          company_name: `@${post.author}`,
          source: 'Reddit',
          signal: {
            signal_type: 'social',
            source: 'Reddit',
            source_url: `https://www.reddit.com${post.permalink}`,
            title: post.title,
            content: (post.selftext || post.title || '').slice(0, 2000),
            relevance_score: 0.6
          }
        });
      }
    } catch (err) {
      logger.warn(`Reddit search failed (HTTP ${err.response?.status || 'n/a'}): ${err.response?.data?.message || err.message}`);
    }

    return signals;
  }

  static _parseList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }
}

module.exports = SocialCollector;
