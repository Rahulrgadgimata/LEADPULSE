const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config/env');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const Search = require('./discovery/collectors/search');
const { isNonProspect } = require('./discovery/collectors/domainFilter');
const scrapling = require('./scraplingClient');

/**
 * Deep public-data enrichment for convertible leads.
 *
 * Pulls everything that is publicly available without logging into LinkedIn:
 * homepage + about/contact pages, JSON-LD Organization, mailto/tel links,
 * social profiles, and search-indexed LinkedIn company pages. Apollo/Hunter
 * still run when keyed and only fill gaps.
 */
class EnrichmentService {
  static async enrich(leadId) {
    try {
      const result = query('SELECT * FROM leads WHERE id = ?', [leadId]);
      const lead = result.rows[0];
      if (!lead) return null;

      let enrichedData = {};
      const domain = lead.company_website
        ? String(lead.company_website).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
        : null;

      // ── 1. Public website deep scrape (home + about + contact) ────────────
      if (domain && !isNonProspect(domain)) {
        Object.assign(enrichedData, await this._fromPublicSite(domain));
      }

      // ── 2. Public LinkedIn company page (search index + soft OG fetch) ────
      if (!lead.contact_linkedin && !enrichedData.contact_linkedin && lead.company_name) {
        const li = await this._findLinkedInCompany(lead.company_name, domain);
        if (li) {
          enrichedData.contact_linkedin = li.url;
          if (li.industry && !lead.company_industry) enrichedData.company_industry = li.industry;
          if (li.size && !lead.company_size) enrichedData.company_size = li.size;
          if (li.location && !lead.company_location) enrichedData.company_location = li.location;
          if (li.description && !lead.company_description) {
            enrichedData.company_description = li.description;
          }
        }
      } else if (lead.contact_linkedin || enrichedData.contact_linkedin) {
        const url = enrichedData.contact_linkedin || lead.contact_linkedin;
        const meta = await this._softFetchLinkedIn(url);
        Object.assign(enrichedData, meta);
      }

      // ── 3. Resolve missing website from public search ─────────────────────
      if (!domain && lead.company_name) {
        const site = await this._findWebsite(lead.company_name);
        if (site) {
          enrichedData.company_website = site;
          Object.assign(enrichedData, await this._fromPublicSite(site));
        }
      }

      // ── 4. Apollo (paid gap-fill) ─────────────────────────────────────────
      const enrichDomain = enrichedData.company_website || domain;
      if (config.APOLLO_API_KEY && enrichDomain) {
        try {
          const apolloRes = await axios.post(
            'https://api.apollo.io/v1/organizations/enrich',
            { domain: String(enrichDomain).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] },
            {
              headers: {
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'x-api-key': config.APOLLO_API_KEY
              },
              timeout: 15000
            }
          );
          const org = apolloRes.data.organization;
          if (org) {
            if (org.industry) enrichedData.company_industry = org.industry;
            if (org.estimated_num_employees) enrichedData.company_size = org.estimated_num_employees;
            if (org.short_description) enrichedData.company_description = org.short_description;
            if (org.primary_phone?.number) enrichedData.contact_phone = org.primary_phone.number;
            if (org.linkedin_url) enrichedData.contact_linkedin = org.linkedin_url;
            if (org.city && org.state) enrichedData.company_location = `${org.city}, ${org.state}`;
          }
        } catch (apolloErr) {
          logger.warn(`Apollo failed for ${enrichDomain}: ${apolloErr.response?.data?.error || apolloErr.message}`);
        }
      }

      // ── 5. Hunter (paid contact emails) ───────────────────────────────────
      if (config.HUNTER_API_KEY && enrichDomain && !lead.contact_email && !enrichedData.contact_email) {
        try {
          const host = String(enrichDomain).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
          const hunterRes = await axios.get(
            `https://api.hunter.io/v2/domain-search?domain=${host}&api_key=${config.HUNTER_API_KEY}`,
            { timeout: 15000 }
          );
          const emails = hunterRes.data.data?.emails || [];
          if (emails.length > 0) {
            const best = emails.reduce((a, b) => (a.confidence > b.confidence ? a : b));
            enrichedData.contact_email = best.value;
            if (best.first_name) {
              enrichedData.contact_name = `${best.first_name} ${best.last_name || ''}`.trim();
            }
            if (best.position) enrichedData.contact_title = best.position;
            if (best.linkedin) enrichedData.contact_linkedin = best.linkedin;
          }
        } catch (hunterErr) {
          logger.warn(`Hunter failed for ${enrichDomain}: ${hunterErr.message}`);
        }
      }

      const clean = {};
      for (const [key, value] of Object.entries(enrichedData)) {
        if (value === null || value === undefined || value === '') continue;
        if (lead[key]) continue;
        clean[key] = value;
      }

      if (Object.keys(clean).length > 0) {
        const fields = [];
        const params = [];
        for (const [key, value] of Object.entries(clean)) {
          fields.push(`${key} = ?`);
          params.push(value);
        }
        fields.push('updated_at = ?');
        params.push(new Date().toISOString());
        params.push(leadId);
        query(`UPDATE leads SET ${fields.join(', ')} WHERE id = ?`, params);
        logger.info(`Lead enriched: ${lead.company_name} ← ${Object.keys(clean).join(', ')}`);
        return { ...lead, ...clean };
      }

      return lead;
    } catch (err) {
      logger.error(`Enrichment failed for lead ${leadId}:`, err);
      return null;
    }
  }

  /**
   * Scrape homepage + common public pages for firmographics and contacts.
   */
  static async _fromPublicSite(domain) {
    const host = String(domain).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    const paths = ['', '/about', '/about-us', '/company', '/contact', '/contact-us'];
    const out = {};

    for (const path of paths) {
      try {
        const page = await this._fetchHtml(`https://${host}${path}`);
        if (!page) continue;
        const extracted = this._extractFromHtml(page.html, host);
        mergePreferExisting(out, extracted);
        // One solid homepage is enough for most fields; still try /contact for email.
        if (path === '' && (out.company_description || out.contact_linkedin)) {
          /* continue to contact paths for email/phone */
        }
        if (out.contact_email && out.contact_phone && out.contact_linkedin && out.company_description) {
          break;
        }
      } catch (err) {
        logger.debug(`Public page ${host}${path} soft-failed: ${err.message}`);
      }
    }

    return out;
  }

  static async _fetchHtml(url) {
    // Scrapling first — better success on WAF / soft-block company sites.
    try {
      const via = await scrapling.fetchHtml(url, {
        timeoutMs: config.SCRAPER_PAGE_TIMEOUT_MS || 30000,
      });
      if (via?.html) {
        return { html: via.html, finalUrl: via.finalUrl || url };
      }
    } catch (err) {
      logger.debug(`Scrapling enrich fetch soft-failed: ${err.message}`);
    }

    const res = await axios.get(url, {
      timeout: config.SCRAPER_PAGE_TIMEOUT_MS,
      maxRedirects: 3,
      maxContentLength: 2 * 1024 * 1024,
      responseType: 'text',
      headers: {
        'User-Agent': config.SCRAPER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      validateStatus: () => true
    });
    if (res.status >= 400 || typeof res.data !== 'string') return null;
    if (!/text\/html/i.test(String(res.headers?.['content-type'] || 'text/html'))) return null;
    return { html: res.data, finalUrl: res.request?.res?.responseUrl || url };
  }

  static _extractFromHtml(html, host) {
    const $ = cheerio.load(html);
    const out = {};

    const desc =
      $('meta[name="description"]').attr('content')?.trim() ||
      $('meta[property="og:description"]').attr('content')?.trim();
    if (desc) out.company_description = desc.slice(0, 600);

    // JSON-LD Organization / LocalBusiness
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const raw = $(el).html();
        if (!raw) return;
        const data = JSON.parse(raw);
        const nodes = Array.isArray(data) ? data : [data];
        for (const node of nodes) {
          const graph = node['@graph'] || [node];
          for (const item of graph) {
            const type = String(item['@type'] || '');
            if (!/Organization|LocalBusiness|Corporation/i.test(type)) continue;
            if (item.description && !out.company_description) {
              out.company_description = String(item.description).slice(0, 600);
            }
            if (item.address) {
              const a = item.address;
              const loc = [a.addressLocality, a.addressRegion, a.addressCountry]
                .filter(Boolean)
                .join(', ');
              if (loc) out.company_location = loc;
            }
            if (item.numberOfEmployees) {
              const n = Number(item.numberOfEmployees?.value || item.numberOfEmployees);
              if (Number.isFinite(n) && n > 0) out.company_size = Math.round(n);
            }
            if (item.email && !out.contact_email) out.contact_email = String(item.email).replace(/^mailto:/i, '');
            if (item.telephone && !out.contact_phone) out.contact_phone = String(item.telephone);
            if (item.sameAs) {
              const same = Array.isArray(item.sameAs) ? item.sameAs : [item.sameAs];
              for (const link of same) {
                const m = String(link).match(/linkedin\.com\/company\/([a-zA-Z0-9\-_%]+)/i);
                if (m && !out.contact_linkedin) {
                  out.contact_linkedin = `https://www.linkedin.com/company/${m[1]}`;
                }
              }
            }
          }
        }
      } catch (e) { /* ignore bad JSON-LD */ }
    });

    $('a[href*="linkedin.com"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/linkedin\.com\/company\/([a-zA-Z0-9\-_%]+)/i);
      if (m && !out.contact_linkedin) {
        out.contact_linkedin = `https://www.linkedin.com/company/${m[1]}`;
      }
    });

    // Public mailto / tel — only company-looking emails (not noreply).
    $('a[href^="mailto:"]').each((_, el) => {
      if (out.contact_email) return;
      const email = String($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
      if (isUsefulEmail(email, host)) out.contact_email = email;
    });

    $('a[href^="tel:"]').each((_, el) => {
      if (out.contact_phone) return;
      const phone = String($(el).attr('href') || '').replace(/^tel:/i, '').trim();
      if (phone.length >= 7) out.contact_phone = phone;
    });

    // Visible email patterns in contact copy.
    if (!out.contact_email) {
      const text = $('body').text().replace(/\s+/g, ' ').slice(0, 8000);
      const match = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
      if (match && isUsefulEmail(match[0], host)) out.contact_email = match[0];
    }

    return out;
  }

  static async _findLinkedInCompany(companyName, domain) {
    try {
      const q = domain
        ? `linkedin.com/company "${companyName}" ${domain}`
        : `linkedin.com/company "${companyName}"`;
      const results = await Search.run(q, 8);

      for (const result of results) {
        const m = String(result.url || '').match(/linkedin\.com\/company\/([a-zA-Z0-9\-_%]+)/i);
        if (!m) continue;
        const url = `https://www.linkedin.com/company/${m[1]}`;
        const meta = await this._softFetchLinkedIn(url);
        const fromSnippet = parseLinkedInSnippet(result.snippet || result.title || '');
        return {
          url,
          industry: meta.company_industry || fromSnippet.industry,
          size: meta.company_size || fromSnippet.size,
          location: meta.company_location || fromSnippet.location,
          description: meta.company_description || (result.snippet || '').slice(0, 400)
        };
      }
    } catch (err) {
      logger.debug(`LinkedIn company lookup failed for ${companyName}: ${err.message}`);
    }
    return null;
  }

  static async _softFetchLinkedIn(url) {
    const out = {};
    try {
      const page = await this._fetchHtml(url);
      if (!page) return out;
      const $ = cheerio.load(page.html);
      const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
      const ogDesc = $('meta[property="og:description"]').attr('content')?.trim();
      // A walled page describes LinkedIn itself; storing that as the company's
      // description overwrote real descriptions with the same generic blurb.
      if (ogDesc && !LINKEDIN_BOILERPLATE.test(ogDesc)) {
        out.company_description = ogDesc.slice(0, 600);
        Object.assign(out, mapSnippetFields(parseLinkedInSnippet(ogDesc)));
      }
      if (ogTitle && !/linkedin/i.test(ogTitle)) {
        /* title is company name — already have name on lead */
      }
    } catch (err) {
      logger.debug(`LinkedIn soft-fetch failed: ${err.message}`);
    }
    return out;
  }

  static async _findWebsite(companyName) {
    try {
      const results = await Search.run(
        `"${companyName}" official website -site:linkedin.com -site:facebook.com -site:crunchbase.com`,
        8
      );
      for (const result of results) {
        let domain;
        try {
          domain = new URL(result.url).hostname.replace(/^www\./, '');
        } catch (e) {
          continue;
        }
        if (!isNonProspect(domain)) return domain;
      }
    } catch (err) {
      logger.debug(`Website lookup failed for ${companyName}: ${err.message}`);
    }
    return null;
  }
}

function mergePreferExisting(target, source) {
  for (const [k, v] of Object.entries(source || {})) {
    if (v === null || v === undefined || v === '') continue;
    if (!target[k]) target[k] = v;
  }
}

function isUsefulEmail(email, host) {
  if (!email || !email.includes('@')) return false;
  const lower = email.toLowerCase();
  if (/noreply|no-reply|donotreply|privacy|support@|help@|webmaster|example\.com/i.test(lower)) {
    return false;
  }
  // Prefer emails on the company domain when known.
  if (host) {
    const domain = host.replace(/^www\./, '').toLowerCase();
    if (lower.endsWith(`@${domain}`) || lower.includes(`@${domain.split('.').slice(-2).join('.')}`)) {
      return true;
    }
  }
  return true;
}

/**
 * LinkedIn's own marketing copy, served instead of a company page whenever the
 * fetch is walled ("With more than 1 billion members, managers and executives
 * worldwide, LinkedIn is the world's largest professional network…"). Parsing
 * it produced a lead in the "LinkedIn" industry located at "With more than 1
 * billion members" on every affected record.
 */
const LINKEDIN_BOILERPLATE =
  /\b(\d+ (?:billion|million) members|world's largest professional network|manage your professional identity|sign in to see|join linkedin|create your free account)\b/i;

function parseLinkedInSnippet(snippet) {
  const out = { industry: null, size: null, location: null };
  if (!snippet) return out;
  if (LINKEDIN_BOILERPLATE.test(snippet)) return out;

  const sizeMatch = snippet.match(/([\d,]+\s*-\s*[\d,]+|\d[\d,]+\+?)\s*employees?/i);
  if (sizeMatch) {
    const nums = sizeMatch[1].replace(/,/g, '').match(/\d+/g);
    if (nums?.length) out.size = parseInt(nums[nums.length - 1], 10);
  }

  // A LinkedIn company header is a short list of fields, not prose. Anything
  // sentence-length is description text and must not populate a field.
  const parts = snippet
    .split(/\s*[·•|]\s*/)
    .map(p => p.trim())
    .filter(part => part && part.length <= 60 && part.split(/\s+/).length <= 7);

  for (const part of parts) {
    if (/employees?|followers?/i.test(part)) continue;
    if (/^linkedin$/i.test(part)) continue;

    // \b matters: without it /NY/i matched the "ny" inside "company" and /CA/i
    // the "ca" inside "location", so ordinary prose was stored as a location.
    if (PLACE_HINT.test(part)) {
      out.location = out.location || part.slice(0, 80);
      continue;
    }
    if (!out.industry && part.length > 2) out.industry = part;
  }
  return out;
}

// Matched against a single comma-separated field, never a whole sentence.
const PLACE_HINT =
  /\b(CA|NY|TX|MA|WA|IL|UK|USA|US|EU|UAE|India|Canada|Australia|Singapore|Germany|France|Netherlands|Ireland|London|Bangalore|Bengaluru|Mumbai|Delhi|Pune|Hyderabad|Chennai|Gurugram|Noida|San Francisco|New York|Boston|Seattle|Austin|Chicago|Berlin|Paris|Amsterdam|Dublin|Toronto|Sydney|Dubai|Tokyo|remote)\b/i;

function mapSnippetFields(parsed) {
  const out = {};
  if (parsed.industry) out.company_industry = parsed.industry;
  if (parsed.size) out.company_size = parsed.size;
  if (parsed.location) out.company_location = parsed.location;
  return out;
}

module.exports = EnrichmentService;
