const ExcelJS = require('exceljs');
const logger = require('../../utils/logger');

/**
 * Read an uploaded spreadsheet into lead rows.
 *
 * Client sheets never share a schema — the column holding a website might be
 * headed "Website", "URL", "Link" or nothing useful at all — so columns are
 * identified by header keyword *and* by what they contain. A column full of
 * "…@….com" is the email column whatever its heading says, which is the case
 * that pure header matching gets wrong most often.
 */

// Header keywords per field, most specific first: an exact "company name" beats
// a mere mention of "name", which could be a contact's name.
const HEADER_HINTS = {
  company: [
    'company name', 'business name', 'organisation name', 'organization name',
    'companyname', 'company', 'business', 'organisation', 'organization',
    'firm', 'brand', 'account', 'client', 'shop', 'store', 'restaurant', 'outlet'
  ],
  website: ['website', 'web site', 'site url', 'company url', 'domain', 'homepage', 'url', 'web', 'site', 'link'],
  location: ['city', 'location', 'address', 'town', 'region', 'state', 'country', 'area', 'locality'],
  industry: ['industry', 'sector', 'vertical', 'category', 'niche', 'segment'],
  contact_name: ['contact name', 'owner name', 'founder', 'owner', 'contact person', 'poc', 'person'],
  contact_title: ['title', 'designation', 'role', 'position', 'job title'],
  contact_email: ['email', 'e-mail', 'mail id', 'mailid', 'email id', 'contact email'],
  contact_phone: ['phone', 'mobile', 'contact number', 'contact no', 'telephone', 'tel', 'whatsapp', 'number'],
  contact_linkedin: ['linkedin', 'linked in', 'li url', 'linkedin url'],
  company_size: ['employees', 'employee count', 'headcount', 'size', 'staff', 'team size']
};

const URL_RE = /^\s*(https?:\/\/|www\.)|\.[a-z]{2,}(\/|$)/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
const PHONE_RE = /^[\d\s+()\-.]{8,20}$/;
const SOCIAL_DOMAINS = ['linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com'];

function normaliseHeader(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** How strongly a header name suggests a field. */
function scoreHeader(header, field) {
  const h = normaliseHeader(header);
  if (!h) return 0;
  const hints = HEADER_HINTS[field];
  let best = 0;
  hints.forEach((hint, i) => {
    const weight = hints.length - i;
    if (h === hint) best = Math.max(best, 100 + weight);
    else if (h.startsWith(hint) || h.endsWith(hint)) best = Math.max(best, 60 + weight);
    else if (h.includes(hint)) best = Math.max(best, 40 + weight);
  });
  return best;
}

/** How strongly a column's values suggest a field, 0-100. */
function scoreContent(values, field) {
  const sample = values.filter(v => v && String(v).trim()).slice(0, 25).map(v => String(v).trim());
  if (sample.length === 0) return 0;

  let hits = 0;
  for (const value of sample) {
    const low = value.toLowerCase();
    if (field === 'contact_email' && EMAIL_RE.test(value)) hits++;
    else if (field === 'contact_phone' && PHONE_RE.test(value) && (value.match(/\d/g) || []).length >= 8) hits++;
    else if (field === 'contact_linkedin' && low.includes('linkedin.com')) hits++;
    else if (field === 'website' && URL_RE.test(value) && !SOCIAL_DOMAINS.some(d => low.includes(d))) hits++;
    else if (field === 'company_size' && /^\d{1,6}$/.test(value)) hits++;
  }
  return Math.round((100 * hits) / sample.length);
}

/**
 * Map field -> column index. Each column is claimed by at most one field, so a
 * single "contact" column cannot be read as both the phone and the email.
 */
function detectColumns(headers, columnValues) {
  const candidates = [];
  for (const field of Object.keys(HEADER_HINTS)) {
    headers.forEach((header, index) => {
      const header_score = scoreHeader(header, field);
      const content_score = scoreContent(columnValues[index] || [], field);
      // Content is decisive when it is unambiguous; otherwise the header leads.
      const score = content_score >= 60 ? content_score + 100 : header_score;
      if (score > 0) candidates.push({ score, field, index });
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  const mapping = {};
  const taken = new Set();
  for (const c of candidates) {
    if (mapping[c.field] !== undefined || taken.has(c.index)) continue;
    mapping[c.field] = c.index;
    taken.add(c.index);
  }

  // A sheet with no recognisable company column still has one: whichever text
  // column is neither a URL nor an email is the best available guess, and
  // without it every row would be discarded.
  if (mapping.company === undefined) {
    for (let i = 0; i < headers.length; i++) {
      if (taken.has(i)) continue;
      const sample = (columnValues[i] || []).filter(Boolean).slice(0, 10).map(String);
      if (sample.length === 0) continue;
      const looksLikeData = sample.some(v => /[a-z]/i.test(v) && !EMAIL_RE.test(v) && !URL_RE.test(v));
      if (looksLikeData) { mapping.company = i; taken.add(i); break; }
    }
  }

  return mapping;
}

function cellText(cell) {
  if (cell == null) return '';
  // ExcelJS returns objects for hyperlinks, rich text and formula results.
  if (typeof cell === 'object') {
    if (cell.text) return String(cell.text).trim();
    if (cell.hyperlink) return String(cell.hyperlink).trim();
    if (cell.result !== undefined) return String(cell.result).trim();
    if (Array.isArray(cell.richText)) return cell.richText.map(r => r.text).join('').trim();
    return '';
  }
  return String(cell).trim();
}

function cleanWebsite(value) {
  const raw = cellText(value);
  if (!raw) return null;
  const host = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].trim().toLowerCase();
  if (!host || !host.includes('.')) return null;
  if (SOCIAL_DOMAINS.some(d => host.includes(d))) return null;
  return host;
}

/**
 * Parse a workbook buffer into rows.
 *
 * @returns {{ rows: Array<Object>, columns: Object, sheetName: string, totalRows: number }}
 */
async function readSheet(buffer, filename, maxRows) {
  const workbook = new ExcelJS.Workbook();
  const isCsv = /\.csv$/i.test(filename || '');

  if (isCsv) {
    const { Readable } = require('stream');
    await workbook.csv.read(Readable.from(buffer.toString('utf8')));
  } else {
    await workbook.xlsx.load(buffer);
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('The file has no worksheets.');

  const table = [];
  sheet.eachRow({ includeEmpty: false }, row => {
    const values = row.values || [];
    // ExcelJS row.values is 1-based with a leading hole.
    table.push(values.slice(1).map(cellText));
  });

  if (table.length < 2) {
    throw new Error('The sheet needs a header row and at least one data row.');
  }

  const headers = table[0];
  const body = table.slice(1).filter(r => r.some(v => v && v.trim()));

  const columnValues = headers.map((_, i) => body.map(r => r[i]));
  const columns = detectColumns(headers, columnValues);

  if (columns.company === undefined && columns.website === undefined) {
    throw new Error(
      'Could not find a company or website column. Name one column "Company" or "Website" and upload again.'
    );
  }

  const rows = [];
  for (const raw of body.slice(0, maxRows)) {
    const pick = field => (columns[field] === undefined ? '' : cellText(raw[columns[field]]));

    const website = columns.website === undefined ? null : cleanWebsite(raw[columns.website]);
    const company = pick('company') || (website ? website.split('.')[0] : '');
    if (!company && !website) continue;

    const sizeText = pick('company_size').replace(/[^\d]/g, '');
    rows.push({
      company_name: company.slice(0, 120),
      company_website: website,
      company_location: pick('location').slice(0, 120) || null,
      company_industry: pick('industry').slice(0, 80) || null,
      company_size: sizeText ? Number(sizeText) : null,
      contact_name: pick('contact_name').slice(0, 120) || null,
      contact_title: pick('contact_title').slice(0, 120) || null,
      contact_email: (pick('contact_email').match(EMAIL_RE) ? pick('contact_email') : '') || null,
      contact_phone: pick('contact_phone').slice(0, 40) || null,
      contact_linkedin: (pick('contact_linkedin').includes('linkedin.com') ? pick('contact_linkedin') : '') || null
    });
  }

  const named = Object.entries(columns)
    .map(([field, index]) => `${field}="${headers[index]}"`)
    .join(', ');
  logger.info(`Sheet "${filename}": ${body.length} rows, columns detected — ${named}`);

  return {
    rows,
    columns: Object.fromEntries(Object.entries(columns).map(([f, i]) => [f, headers[i]])),
    sheetName: sheet.name,
    totalRows: body.length
  };
}

module.exports = { readSheet, detectColumns, HEADER_HINTS };
