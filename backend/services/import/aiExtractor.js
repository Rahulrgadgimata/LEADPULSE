const cheerio = require('cheerio');
const logger = require('../../utils/logger');
const config = require('../../config/env');
const GroqClient = require('../groqClient');
const Search = require('../discovery/collectors/search');

/**
 * Read what has been gathered about a company and pull out what was asked for.
 *
 * Two sources, tried in that order:
 *
 *   the company's own pages — where most small companies publish everything;
 *   web search results      — where most large ones effectively do.
 *
 * Pattern matching only finds a detail written as one, and a page routinely
 * does not oblige: a founder named in prose, "jane [at] acme.io", a name and a
 * title sitting in separate elements. Those are the cases a reader has no
 * trouble with and a regex cannot see.
 *
 * The requested fields are the user's, not a fixed list — whatever they type on
 * the upload form becomes the schema the model fills in.
 */

// Fields the pipeline already has columns for. Anything else the user asks for
// is kept alongside as free-form extracted data.
const KNOWN_FIELDS = {
  contact_email: ['email', 'e-mail', 'email address', 'contact email'],
  contact_phone: ['phone', 'telephone', 'mobile', 'contact number', 'phone number'],
  contact_name: ['name', 'contact name', 'owner', 'owner name', 'founder', 'ceo', 'decision maker', 'contact person'],
  contact_title: ['title', 'job title', 'role', 'designation', 'position'],
  contact_linkedin: ['linkedin', 'linkedin url', 'linkedin profile'],
  company_location: ['location', 'address', 'city', 'headquarters', 'hq'],
  company_size: ['size', 'employees', 'employee count', 'headcount', 'team size'],
  company_industry: ['industry', 'sector', 'vertical', 'niche'],
  company_description: ['description', 'what they do', 'about', 'summary', 'overview']
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
 * Condense a page into something worth sending to a model.
 *
 * Whole pages are mostly navigation and boilerplate, and tokens per minute are
 * the binding constraint on a free tier — so chrome is stripped and the links
 * that carry contact details are lifted to the front, where they survive the
 * truncation.
 */
function condense(html, maxChars = 4000) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe').remove();

  const parts = [];

  // mailto:/tel: links are the highest-signal thing on any page, and they
  // survive here even when the visible text obfuscates the address.
  $('a[href^="mailto:"], a[href^="tel:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href) parts.push(href.replace(/^mailto:/i, 'email: ').replace(/^tel:/i, 'phone: '));
  });

  $('a[href*="linkedin.com"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href) parts.push('linkedin: ' + href);
  });

  parts.push($('body').text().replace(/\s+/g, ' ').trim());
  return parts.join('\n').slice(0, maxChars);
}

class AiExtractor {
  static get available() {
    return GroqClient.available;
  }

  /**
   * Read the company's own pages.
   *
   * @param {Object} opts
   * @param {string} opts.companyName
   * @param {string} opts.website
   * @param {Array<{url: string, html: string}>} opts.pages
   * @param {Array<string>} opts.fields   what the user asked for
   * @param {Array<string>} opts.missing  which of those are still unknown
   * @returns {Promise<Object|null>} field -> value, only for what it found
   */
  static async extract({ companyName, website, location, pages, fields, missing }) {
    if (!this.available || !pages?.length) return null;

    const wanted = (missing?.length ? missing : fields) || [];
    if (wanted.length === 0) return null;

    const corpus = pages
      .map(p => '--- ' + p.url + ' ---\n' + condense(p.html, config.AI_EXTRACT_CHARS_PER_PAGE))
      .join('\n\n')
      .slice(0, config.AI_EXTRACT_MAX_CHARS);

    if (corpus.trim().length < 100) return null;

    const system = [
      "You read a company's own web pages and report the details asked for.",
      '',
      'Return ONLY JSON: {"fields":{"<requested field>":"<value>"}}',
      '',
      'Rules:',
      '- Include a field only when the pages actually support it. Omit it otherwise; never guess.',
      '- Report an address written awkwardly ("jane [at] acme dot io") in its normal form.',
      '- The contact must belong to ' + companyName + '. Pages link to customers, partners and agencies; their details are not this company\'s.',
      '- Prefer a named decision maker (founder, owner, CEO, head of…) over a generic inbox when the pages name one.',
      location
        ? '- This row is about the ' + location + ' office. Where the pages list several offices, report that one — a head-office number in another country is the wrong answer here.'
        : '- Report the main office when the pages list several.',
      '- Values are plain strings, no markdown, no commentary.'
    ].join('\n');

    const user = [
      'Company: ' + companyName + (website ? ' (' + website + ')' : ''),
      'Fields wanted: ' + wanted.join(', '),
      '',
      'Pages:',
      corpus
    ].join('\n');

    return this._ask(system, user, companyName, 'pages');
  }

  /**
   * Read web search results instead.
   *
   * A company's site is not always where its contact details are, and for a
   * large one it usually is not: MathWorks publishes its India number on a deep
   * worldwide-offices page that no path guess reaches, and plenty of firms are
   * easiest to reach through a directory listing or a regional subsidiary page.
   *
   * Searching for the company and reading what comes back is what a person does
   * when the website does not answer — and it is the step this pipeline was
   * missing against a general-purpose assistant asked the same question.
   */
  static async extractFromSearch({ companyName, website, location, fields, missing }) {
    if (!this.available || !companyName) return null;

    const wanted = (missing?.length ? missing : fields) || [];
    if (wanted.length === 0) return null;

    // Ask the way a person would, and name the place: a sheet of regional
    // subsidiaries otherwise returns the parent company on every query.
    const where = location
      ? ' ' + String(location).split(',').slice(-2).join(' ').trim()
      : '';

    const results = [];
    const seen = new Set();
    for (const q of ['"' + companyName + '"' + where + ' contact phone email address',
                     '"' + companyName + '"' + where + ' office contact number']) {
      if (results.length >= 8) break;
      try {
        for (const r of await Search.run(q, 8)) {
          if (seen.has(r.url)) continue;
          seen.add(r.url);
          results.push(r);
        }
      } catch (err) {
        logger.debug('Contact search failed for ' + companyName + ': ' + err.message);
      }
    }

    if (results.length === 0) return null;

    const corpus = results
      .slice(0, 10)
      .map(r => [r.title, r.url, r.snippet].filter(Boolean).join('\n'))
      .join('\n\n')
      .slice(0, config.AI_EXTRACT_MAX_CHARS);

    const system = [
      'You read web search results and report contact details for one company.',
      '',
      'Return ONLY JSON: {"fields":{"<requested field>":"<value>"}}',
      '',
      'Rules:',
      '- The details must belong to ' + companyName + ' itself. Results mention competitors, directories and unrelated firms; theirs do not count.',
      '- Include a field only when a result actually states it. Omit it otherwise; never guess or construct a number.',
      '- Prefer the office in ' + (location || 'the company\'s main location') + ' when results give several.',
      '- Values are plain strings, no markdown, no commentary.'
    ].join('\n');

    const user = [
      'Company: ' + companyName + (website ? ' (' + website + ')' : ''),
      'Location: ' + (location || 'unknown'),
      'Fields wanted: ' + wanted.join(', '),
      '',
      'Search results:',
      corpus
    ].join('\n');

    return this._ask(system, user, companyName, 'search');
  }

  /** One model call, with the answer cleaned up. */
  static async _ask(system, user, companyName, kind) {
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
      return this._clean(parsed?.fields || parsed || {});
    } catch (err) {
      logger.debug('AI extraction (' + kind + ') failed for ' + companyName + ': ' + err.message);
      return null;
    }
  }

  /**
   * Drop the "not found" answers a model gives instead of omitting the field,
   * which would otherwise be stored as though it were a real value.
   */
  static _clean(found) {
    const out = {};
    for (const [key, value] of Object.entries(found)) {
      if (value == null) continue;
      const text = String(value).trim();
      if (!text) continue;
      if (/^(n\/?a|none|not (found|available|listed|provided|specified)|unknown|null|-|—)$/i.test(text)) continue;
      out[key] = text.slice(0, 400);
    }
    return Object.keys(out).length > 0 ? out : null;
  }
}

module.exports = { AiExtractor, parseRequestedFields, toKnownField, condense, KNOWN_FIELDS };
