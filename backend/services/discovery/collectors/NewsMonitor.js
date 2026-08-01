const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../../../utils/logger');
const config = require('../../../config/env');
const GroqClient = require('../../groqClient');
const { isNonProspect } = require('./domainFilter');
const { collectWithConcurrency } = require('../../../utils/concurrency');

/**
 * Finds companies through news coverage.
 *
 * Two sources, because neither alone gives enough volume:
 *
 *  - Google News RSS — keyless, returns up to 100 items per query, and is not
 *    bot-blocked the way the scrapeable search engines are. This is the
 *    dependable bulk source, and the reason discovery still produces leads when
 *    DuckDuckGo is rate-limiting the web scraper.
 *  - NewsAPI — richer descriptions, but the free tier caps hard, so it is used
 *    for a few queries rather than all of them.
 *
 * `article.source.name` is the publisher, not a prospect, so the subject
 * company of each story is resolved with the AI extractor instead.
 */
class NewsMonitor {
  static async searchNews(icp) {
    const queries = this._buildQueries(icp);
    if (queries.length === 0) return [];

    logger.info(`NewsMonitor: ${queries.length} queries across Google News RSS${config.NEWS_API_KEY ? ' + NewsAPI' : ''}`);

    // ── 1. Collect articles from both sources ────────────────────────────────
    const rss = await collectWithConcurrency(
      queries,
      config.NEWS_CONCURRENCY,
      query => this._googleNews(query)
    );

    const newsapi = config.NEWS_API_KEY
      ? await collectWithConcurrency(
          queries.slice(0, config.NEWSAPI_MAX_QUERIES),
          1, // free tier is request-capped; keep it serial
          query => this._newsApi(query)
        )
      : [];

    // ── 2. Deduplicate ───────────────────────────────────────────────────────
    const byKey = new Map();
    for (const article of [...newsapi, ...rss]) {
      if (!article?.title) continue;
      const key = (article.url || article.title).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 90);
      if (!byKey.has(key)) byKey.set(key, article);
    }

    const articles = [...byKey.values()].slice(0, config.NEWS_MAX_ARTICLES);
    logger.info(`NewsMonitor: ${articles.length} unique articles (rss=${rss.length}, newsapi=${newsapi.length})`);
    if (articles.length === 0) return [];

    // ── 3. Resolve the company each article is about ─────────────────────────
    const companies = await this._resolveCompanies(articles, icp);

    const signals = [];
    const seenCompany = new Set();
    for (let i = 0; i < articles.length; i++) {
      const company = companies[i];
      if (!company?.name) continue;

      const key = company.name.toLowerCase().trim();
      if (seenCompany.has(key)) continue;
      seenCompany.add(key);

      signals.push({
        company_name: company.name,
        company_website: company.website || null,
        company_industry: company.industry || null,
        source: 'NewsAPI',
        signal: {
          signal_type: 'news',
          source: articles[i].source || 'News',
          source_url: articles[i].url,
          title: articles[i].title,
          content: articles[i].description || '',
          relevance_score: 0.8
        }
      });
    }

    logger.info(`NewsMonitor produced ${signals.length} company signals from ${articles.length} articles`);
    return signals;
  }

  /**
   * Query set built from the ICP. Distinct queries matter more than a single
   * broad one: each returns its own 100-item feed.
   */
  static _buildQueries(icp) {
    const industries = this._parseList(icp.industries);
    const keywords = this._parseList(icp.keywords);
    const geo = this._parseList(icp.geographies)[0] || '';

    const queries = [];
    const seen = new Set();
    const add = (...parts) => {
      const q = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (!q || seen.has(q.toLowerCase())) return;
      seen.add(q.toLowerCase());
      queries.push(q);
    };

    for (const industry of industries) {
      add(industry, 'company', geo);
      add(industry, 'funding raises', geo);
      add(industry, 'startup launch', geo);
    }
    for (const keyword of keywords) {
      add(keyword, 'company', geo);
    }
    for (const industry of industries.slice(0, 2)) {
      for (const keyword of keywords.slice(0, 2)) {
        add(industry, keyword, geo);
      }
    }

    return queries.slice(0, config.NEWS_MAX_QUERIES);
  }

  /**
   * Google News RSS. Keyless and generous, so it carries the bulk of the load.
   */
  static async _googleNews(query) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': config.SCRAPER_USER_AGENT, Accept: 'application/rss+xml,*/*' },
        timeout: 20000
      });

      const $ = cheerio.load(res.data, { xmlMode: true });
      const out = [];
      $('item').each((_, el) => {
        const item = $(el);
        // Google formats titles as "Headline - Publisher"; the publisher is
        // also given separately, so strip it to leave a clean headline.
        const rawTitle = item.find('title').first().text().trim();
        const publisher = item.find('source').first().text().trim();
        const title = publisher && rawTitle.endsWith(` - ${publisher}`)
          ? rawTitle.slice(0, -(publisher.length + 3)).trim()
          : rawTitle;
        if (!title) return;

        const description = cheerio.load(item.find('description').first().text() || '').root().text().trim();
        out.push({
          title,
          url: item.find('link').first().text().trim(),
          description: description.slice(0, 400),
          source: publisher || 'Google News'
        });
      });
      return out;
    } catch (err) {
      logger.warn(`Google News RSS failed for "${query}": ${err.response?.status || err.message}`);
      return [];
    }
  }

  static async _newsApi(query) {
    try {
      const res = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          q: query,
          language: 'en',
          sortBy: 'publishedAt',
          pageSize: config.NEWSAPI_PAGE_SIZE,
          apiKey: config.NEWS_API_KEY
        },
        timeout: 20000
      });
      return (res.data.articles || []).map(a => ({
        title: a.title,
        url: a.url,
        description: a.description || a.content || '',
        source: a.source?.name || 'NewsAPI'
      }));
    } catch (err) {
      const detail = err.response?.data?.message || err.message;
      logger.warn(`NewsAPI failed for "${query}": ${detail}`);
      return [];
    }
  }

  /**
   * Ask the model which company each article is about. Returns an array aligned
   * with `articles`; entries are null when no company could be identified.
   */
  static async _resolveCompanies(articles, icp) {
    const empty = articles.map(() => null);
    if (!GroqClient.availableFor('extraction')) {
      logger.warn('No Groq key for extraction; cannot resolve subject companies from news.');
      return empty;
    }

    const industries = this._parseList(icp.industries);
    const system =
      `You identify the company a news item is ABOUT — the subject, not the publisher ` +
      `and not companies merely quoted as commentators.\n` +
      `Target industries: ${industries.join(', ') || 'B2B technology'}.\n` +
      `Return ONLY JSON: {"results":[{"index":<n>,"name":"<company>","website":"<domain or empty>","industry":"<specific>"}]}\n` +
      `Rules: omit an index entirely if the item is about a person, a government, ` +
      `a general trend, or has no clear company subject. Never return a news ` +
      `publisher, media outlet or press-release wire. Use the plain company name ` +
      `and its primary domain (e.g. "Stripe","stripe.com").`;

    const size = config.GROQ_BATCH_SIZE;
    const batches = [];
    for (let i = 0; i < articles.length; i += size) {
      batches.push({ start: i, items: articles.slice(i, i + size) });
    }

    const out = empty.slice();
    await collectWithConcurrency(batches, config.GROQ_CONCURRENCY, async batch => {
      const listing = batch.items
        .map((a, i) => `[${i}] ${a.title} :: ${(a.description || '').slice(0, 160)}`)
        .join('\n');

      try {
        const parsed = await GroqClient.chatJson({
          system,
          user: listing,
          purpose: 'extraction',
          maxTokens: 2000,
          temperature: 0.1,
          reasoningEffort: config.GROQ_EXTRACTION_REASONING
        });

        for (const row of parsed.results || parsed.companies || []) {
          const local = Number(row.index);
          if (!Number.isInteger(local) || local < 0 || local >= batch.items.length) continue;
          const name = String(row.name || '').trim();
          if (name.length < 2) continue;

          const website = row.website
            ? String(row.website).trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
            : null;
          // A publisher slipping through would become a junk lead.
          if (website && isNonProspect(website)) continue;

          out[batch.start + local] = { name, website, industry: row.industry || null };
        }
      } catch (err) {
        logger.warn(`News company resolution failed for a batch: ${err.message}`);
      }
      return null;
    });

    logger.info(`NewsMonitor resolved ${out.filter(Boolean).length}/${articles.length} subject companies`);
    return out;
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

module.exports = NewsMonitor;
