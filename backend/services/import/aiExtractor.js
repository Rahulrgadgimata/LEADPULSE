const cheerio = require('cheerio');
const logger = require('../../utils/logger');
const config = require('../../config/env');
const GroqClient = require('../groqClient');

/**
 * Read scraped pages with a model and pull out whatever the user asked for.
 *
 * Pattern matching finds an address only when it is written as one. A company
 * page routinely is not: "reach our founder Jane Doe at jane [at] acme.io",
 * a phone printed as "call us on nine-eight-double-seven", a leadership section
 * where the name and the title sit in separate elements. Those are exactly the
 * cases a reader has no trouble with and a regex cannot see, and they are the
 * difference between an imported row that can be contacted and one that cannot.
 *
 * The requested fields are the user's, not a fixed list: whatever they type on
 * the upload form becomes the schema the model fills in.
 */

// Fields the pipeline already has columns for. Anything else the user asks for
// is kept alongside as free-form extracted data.
const KNOWN_FIELDS = {
  'contact_email': ['email', 'e-mail', 'email address', 'contact email'],
  'contact_phone': ['phone', 'telephone', 'mobile', 'contact number', 'phone number'],
  'contact_name': ['name', 'contact name', 'owner', 'owner name', 'founder', 'ceo', 'decision maker', 'contact person'],
  'contact_title': ['title', 'job title', 'role', 'designation', 'position'],
  'contact_linkedin': ['linkedin', 'linkedin url', 'linkedin profile'],
  'company_location': ['location', 'address', 'city', 'headquarters', 'hq'],
  'company_size': ['size', 'employees', 'employee count', 'headcount', 'team size'],
  'company_industry': ['industry', 'sector', 'vertical', 'niche'],
  'company_description': ['description', 'what they do', 'about', 'summary', 'overview']
};

/** Map a user's wording onto a lead column, or null when it is a custom field. */
function toKnownField(label) {
  const clean = String(label).toLowerCase().trim();
  for (const [column, aliases] of Object.entries(KNOWN_FIELDS)) {
    if (aliases.includes(clean) || column === clean) return column;
  }
  return null;
}

/**
 * Parse the free-text field list from the upload form.
 * "owner name, email, phone, tech stack" -> ['owner name','email','phone','tech stack']
 */
function parseRequestedFields(input) {
  if (!input) return [];
  return String(input)
    .split(/[,;\n]/)
    .map(s => s.replace(/^[-*\s]+/, '').trim())
    .filter(s => s.length > 1 && s.length <= 60)
    .slice(0, 12);
}

/**
 * Condense pages into something worth sending to a model.
 *
 * Whole pages are mostly navigation and boilerplate, and the token budget is
 * the binding constraint on a free tier — so scripts and chrome are stripped,
 * and the sections that actually carry contact details are kept.
 */
function condense(html, maxChars = 4000) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, nav, header > nav').remove();

  const parts = [];

  // mailto:/tel: links are the highest-signal thing on any page, and they
  // survive here even when the visible text obfuscates the address.
  $('a[href^="mailto:"], a[href^="tel:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href) parts.push(href.replace(/^mailto:/i, 'email: ').replace(/^tel:/i, 'phone: '));
  });

  $('a[href*="linkedin.com"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href) parts.push(`linkedin: ${href}`);
  });

  const body = $('body').text().replace(/\s+/g, ' ').trim();
  parts.push(body);

  return parts.join('\n').slice(0, maxChars);
}

class AiExtractor {
  static get available() {
    return GroqClient.available;
  }

  /**
   * @param {Object} opts
   * @param {string} opts.companyName
   * @param {string} opts.website
   * @param {Array<{url: string, html: string}>} opts.pages
   * @param {Array<string>} opts.fields   what the user asked for
   * @param {Array<string>} opts.missing  which of those are still unknown
   * @returns {Promise<Object|null>} field -> value, only for what it found
   */
  static async extract({ companyName, website, pages, fields, missing }) {
    if (!this.available || !pages?.length) return null;

    const wanted = (missing?.length ? missing : fields) || [];
    if (wanted.length === 0) return null;

    const corpus = pages
      .map(p => `--- ${p.url} ---\n${condense(p.html, config.AI_EXTRACT_CHARS_PER_PAGE)}`)
      .join('\n\n')
      .slice(0, config.AI_EXTRACT_MAX_CHARS);

    if (corpus.trim().length < 100) return null;

    const system =
      `You read a company's own web pages and report the details asked for.\n\n` +
      `Return ONLY JSON: {"fields":{"<requested field>":"<value>"}}\n\n` +
      `Rules:\n` +
      `- Include a field only when the pages actually support it. Omit it otherwise; never guess.\n` +
      `- Report an address that is written awkwardly ("jane [at] acme dot io") in its normal form.\n` +
      `- The contact must belong to ${companyName}. Pages link to customers, partners and agencies; their details are not this company's.\n` +
      `- Prefer a named decision maker (founder, owner, CEO, head of…) over a generic inbox when the pages name one.\n` +
      `- Values are plain strings, no markdown, no commentary.`;

    const user =
      `Company: ${companyName}${website ? ` (${website})` : ''}\n` +
      `Fields wanted: ${wanted.join(', ')}\n\n` +
      `Pages:\n${corpus}`;

    try {
      const parsed = await GroqClient.chatJson({
        system,
        user,
        purpose: 'extraction',
        reasoningEffort: config.GROQ_EXTRACTION_REASONING,
        maxTokens: 1200,
        expectedOutputTokens: 300,
        temperature: 0
      });

      const found = parsed?.fields || parsed || {};
      const out = {};
      for (const [key, value] of Object.entries(found)) {
        if (value == null) continue;
        const text = String(value).trim();
        // Models sometimes answer the question rather than leaving it out.
        if (!text || /^(n\/?a|none|not (found|available|listed|provided)|unknown|null)$/i.test(text)) continue;
        out[key] = text.slice(0, 400);
      }

      return Object.keys(out).length > 0 ? out : null;
    } catch (err) {
      logger.debug(`AI extraction failed for ${companyName}: ${err.message}`);
      return null;
    }
  }
}

module.exports = { AiExtractor, parseRequestedFields, toKnownField, condense, KNOWN_FIELDS };
