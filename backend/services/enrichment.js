const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config/env');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const Search = require('./discovery/collectors/search');
const { isNonProspect } = require('./discovery/collectors/domainFilter');
const scrapling = require('./scraplingClient');
const providerHealth = require('./providerHealth');
const PeopleFinder = require('./discovery/collectors/peopleFinder');
const firecrawl = require('./firecrawlClient');

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
      const result = await query('SELECT * FROM leads WHERE id = ?', [leadId]);
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

      // ── 2b. Decision-maker from the company's own team page ───────────────
      // This is where buyer contacts come from now. The LinkedIn people route
      // needs a search engine that indexes profiles, which no keyless source
      // does any more, and a company's own leadership page names the same
      // people with their exact titles — verified against live sites, it
      // resolves a named buyer for roughly half of the companies tried.
      const buyerDomain = enrichedData.company_website || domain;
      if (buyerDomain && !lead.contact_name && !enrichedData.contact_name) {
        try {
          const icpTitles = await this._icpTitlesFor(lead.icp_id);
          const buyer = await PeopleFinder.findBuyer(buyerDomain, icpTitles);
          if (buyer) {
            enrichedData.contact_name = buyer.name;
            if (!lead.contact_title) enrichedData.contact_title = buyer.title;
            logger.info(`Buyer found for ${lead.company_name}: ${buyer.name} (${buyer.title})`);
          }
        } catch (err) {
          logger.debug(`Team-page buyer lookup failed for ${buyerDomain}: ${err.message}`);
        }
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
      // Apollo's free plan excludes every enrichment endpoint (HTTP 403
      // API_INACCESSIBLE), so the first refusal parks the provider instead of
      // spending a 15-second timeout per lead for the rest of the run.
      const enrichDomain = enrichedData.company_website || domain;
      if (config.APOLLO_API_KEY && enrichDomain && !providerHealth.isDisabled('apollo')) {
        try {
          const apolloRes = await axios.post(
            // The path is /api/v1/...; the old /v1/... URL 404s on every call.
            'https://api.apollo.io/api/v1/organizations/enrich',
            {},
            {
              params: {
                domain: String(enrichDomain).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
              },
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
          if (!providerHealth.noteFailure('apollo', apolloErr)) {
            logger.warn(`Apollo failed for ${enrichDomain}: ${apolloErr.response?.data?.error || apolloErr.message}`);
          }
        }
      }

      // ── 5. Hunter (paid contact emails) ───────────────────────────────────
      // Free Hunter plans allow 50 domain searches per billing period; once
      // they are gone every call returns 429 and the provider is parked until
      // the reset date rather than retried per lead.
      if (
        config.HUNTER_API_KEY && enrichDomain &&
        !lead.contact_email && !enrichedData.contact_email &&
        !providerHealth.isDisabled('hunter')
      ) {
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
          const parked = providerHealth.noteFailure('hunter', hunterErr, {
            quotaPatterns: [/searches per billing period/i, /reached the limit/i]
          });
          if (!parked) logger.warn(`Hunter failed for ${enrichDomain}: ${hunterErr.message}`);
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
        await query(`UPDATE leads SET ${fields.join(', ')} WHERE id = ?`, params);
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
    const out = {};

    // The homepage first, because it names where everything else lives.
    let discovered = [];
    try {
      const home = await this._fetchHtml(`https://${host}`);
      if (home) {
        mergePreferExisting(out, this._extractFromHtml(home.html, host));
        discovered = this._discoverContactPages(home.html, host);
      }
    } catch (err) {
      logger.debug(`Homepage ${host} soft-failed: ${err.message}`);
    }

    // Guessing paths only finds a contact page that happens to be called
    // "/contact". MathWorks keeps theirs at /company/aboutus/contact_us.html,
    // with every office phone number on it, and no amount of guessing reaches
    // that — but the homepage links to it by name. Follow the site's own links
    // first and fall back to the common paths for sites that link to none.
    const fallback = [
      '/contact', '/contact-us', '/about', '/about-us', '/company',
      '/team', '/support', '/imprint', '/impressum', '/legal', '/privacy'
    ].map(path => `https://${host}${path}`);

    const targets = [...new Set([...discovered, ...fallback])].slice(0, config.ENRICHMENT_MAX_PAGES);

    for (const url of targets) {
      // Everything worth having is already in hand.
      if (out.contact_email && out.contact_phone && out.contact_linkedin && out.company_description) break;

      try {
        const page = await this._fetchHtml(url);
        if (!page) continue;
        mergePreferExisting(out, this._extractFromHtml(page.html, host));
      } catch (err) {
        logger.debug(`Public page ${url} soft-failed: ${err.message}`);
      }
    }

    return out;
  }

  /**
   * Links on a homepage that lead to contact details, best first.
   *
   * Matched on both the href and the link text, because the two disagree often
   * enough to matter: "Contact Us" frequently points at
   * /company/aboutus/contact_us.html, and /kontakt is a contact page whose text
   * says nothing an English pattern would match.
   */
  static _discoverContactPages(html, host) {
    const $ = cheerio.load(html);
    const scored = new Map();

    // Weighted by how likely the page is to carry a phone number or an address.
    const rules = [
      [/contact|kontakt|contacto|reach-us|get-in-touch/i, 100],
      [/impressum|imprint|legal-notice/i, 90],
      [/team|leadership|our-people|management|founders/i, 70],
      [/about|company|who-we-are|nosotros/i, 50],
      [/support|help-?center|customer-service/i, 40],
      [/locations?|offices?|worldwide/i, 60]
    ];

    $('a[href]').each((_, el) => {
      const href = String($(el).attr('href') || '').trim();
      if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;

      let url;
      try {
        url = new URL(href, `https://${host}`);
      } catch (e) {
        return;
      }

      // Offsite links are somebody else's contact details.
      const linkHost = url.hostname.replace(/^www\./, '');
      if (linkHost !== host && !linkHost.endsWith(`.${host}`)) return;
      if (/\.(pdf|jpe?g|png|gif|svg|zip|mp4|css|js)$/i.test(url.pathname)) return;

      const haystack = `${url.pathname} ${$(el).text()}`;
      let best = 0;
      for (const [pattern, weight] of rules) {
        if (pattern.test(haystack)) best = Math.max(best, weight);
      }
      if (best === 0) return;

      const clean = `${url.origin}${url.pathname}`;
      if (!scored.has(clean) || scored.get(clean) < best) scored.set(clean, best);
    });

    return [...scored.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([url]) => url);
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

    const usable = res.status < 400 &&
      typeof res.data === 'string' &&
      /text\/html/i.test(String(res.headers?.['content-type'] || 'text/html'));

    if (usable) return { html: res.data, finalUrl: res.request?.res?.responseUrl || url };

    // Last resort: a page that refuses both Scrapling and plain HTTP is either
    // Cloudflare-fronted or rendered entirely in JavaScript, and it is often the
    // "/team" page holding the name we are looking for. Firecrawl renders it on
    // its own machines, so the memory cost stays off this instance. Every call
    // spends plan credits, which is why it runs only once the free paths fail.
    if (config.FIRECRAWL_SCRAPE_FALLBACK && firecrawl.available) {
      const rendered = await firecrawl.scrape(url);
      if (rendered?.html) {
        logger.debug(`Firecrawl rendered ${url} after the direct fetch failed.`);
        return { html: rendered.html, finalUrl: rendered.finalUrl || url };
      }
    }

    return null;
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
      // Every candidate, not just the first. A page that prints a sample
      // address ("you@example.com") before its real one used to end the
      // search on the sample and report no email at all.
      for (const candidate of text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []) {
        const email = trimGluedTail(candidate);
        if (isUsefulEmail(email, host)) { out.contact_email = email; break; }
      }
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

  /** The buyer titles this lead's ICP targets, best-match first. */
  static async _icpTitlesFor(icpId) {
    if (!icpId) return [];
    const row = (await query('SELECT job_titles FROM icps WHERE id = ?', [icpId])).rows[0];
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.job_titles || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
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

/**
 * Strip a word that stripped HTML glued onto the end of an address.
 *
 * `<a>support@ghost.org</a>To contact us` flattens to "support@ghost.orgTo",
 * which the address pattern happily swallows whole — one import stored exactly
 * that as the company's email. A capital letter directly after the TLD is never
 * part of it, so the address ends there.
 */
function trimGluedTail(email) {
  return String(email).replace(/^([^@]+@[^@]*?\.[a-z]{2,24})(?=[A-Z])[\s\S]*$/, '$1');
}

function isUsefulEmail(email, host) {
  if (!email || !email.includes('@')) return false;
  const lower = email.toLowerCase();
  // Only genuinely undeliverable or non-human addresses are refused. An earlier
  // version also rejected support@ and help@, but for outbound prospecting a
  // published role address is frequently the only way in — and rejecting them
  // left companies that do publish a contact looking as though they publish
  // none.
  if (/noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|webmaster|example\.com|sentry\.io|wixpress/i.test(lower)) {
    return false;
  }
  // Retina and sized asset filenames — "icon@400.png", "logo@2x.jpg" — satisfy
  // the email pattern exactly, and a page's srcset is full of them. One was
  // imported as a company's contact address.
  if (ASSET_FILENAME.test(lower)) return false;

  // An address on someone else's domain is someone else's address. Company
  // pages link to customers, partners, agencies and case studies, so the first
  // email in the body text is frequently not the company's own — an import of
  // buttondown.com came back with contact@cssclub.nyc, a site they merely link
  // to, presented as Buttondown's contact.
  //
  // The company's own domain is accepted, as are the free providers a small
  // business legitimately runs on. Anything else is another company.
  if (host) {
    const domain = host.replace(/^www\./, '').toLowerCase();
    const base = domain.split('.').slice(-2).join('.');
    const emailDomain = lower.split('@').pop();
    if (!emailDomain) return false;

    // A company often sends from a sibling domain of its own brand —
    // buttondown.com publishes @buttondown.email, and a strict host match threw
    // that away as if it belonged to someone else.
    const brand = base.split('.')[0];
    const emailBrand = emailDomain.split('.')[0];

    const onCompanyDomain = emailDomain === domain ||
      emailDomain.endsWith(`.${base}`) ||
      emailDomain === base ||
      (brand.length >= 4 && emailBrand === brand);

    if (!onCompanyDomain && !FREE_MAIL_DOMAINS.has(emailDomain)) return false;
  }

  return true;
}

// Small businesses genuinely run on these, so an address here is not evidence
// that it belongs to a different company.
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'proton.me', 'protonmail.com',
  'icloud.com', 'aol.com', 'zoho.com', 'gmx.com', 'mail.com', 'rediffmail.com'
]);

// An "address" whose domain part is really a file extension, or whose local
// part is a size suffix rather than a name.
const ASSET_FILENAME =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|css|js|json|woff2?|ttf|eot|mp4|webm|mp3|pdf|zip)$/i;

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
