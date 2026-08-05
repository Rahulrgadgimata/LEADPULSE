// backend/services/outreach/promptBuilder.js
const config = require('../../config/env');
const Signal = require('../../models/Signal');

/**
 * Turns a lead into the prompt that writes its first-touch email.
 *
 * One builder serves every path — the API providers and the browser handoff to
 * Gemini both use exactly this text. That is deliberate: if the handoff sent a
 * different prompt, drafts would silently differ in quality depending on which
 * button the user pressed, and neither would be a fair test of the other.
 */

// Row titles the collectors write as plumbing rather than as content. Handing
// "Orangemantra found via WebScraper" to the model as the reason for writing
// produces an email that opens by referencing nothing — so this matches the
// phrase anywhere in the title, not only at the start, because collectors
// prefix it with the company name.
const GENERIC_TITLE = /\b(?:found|discovered|scraped|collected|indexed)\s+(?:via|from|by|on)\b|^\s*(?:source|via)\s*:/i;

/**
 * Clean text that another model wrote and this app stored.
 *
 * Reasoning-capable models emit a <think>…</think> block, and some of the score
 * explanations in lead_scores were saved with it still attached. Feeding that
 * into the message prompt hands the writer a transcript of another model's
 * deliberations instead of a fact about the prospect — and it surfaced in the
 * UI as "Personalised around: <think> Here's a thinking process…".
 *
 * An unterminated block is truncated rather than kept: a half-open <think> means
 * everything after it is reasoning that ran out of budget mid-sentence.
 */
function sanitiseStoredText(value) {
  let text = String(value || '').replace(/<think>[\s\S]*?<\/think>/gi, '');

  const dangling = text.search(/<think>/i);
  if (dangling !== -1) text = text.slice(0, dangling);

  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Pull the human-readable part out of a stored signal.
 *
 * Several collectors put a metadata blob in `content` — the search query, the
 * URL, the page title. The page title and snippet are the only parts a
 * prospect would recognise; the rest is our own plumbing and must not reach the
 * prompt, or the model will happily quote a search query back at them.
 */
function readSignalContent(signal) {
  const rawTitle = sanitiseStoredText(signal.title);
  const rawContent = String(signal.content || '').trim();

  let parsed = null;
  if (/^\s*[{[]/.test(rawContent)) {
    try { parsed = JSON.parse(rawContent); } catch (err) { parsed = null; }
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const title = String(parsed.title || parsed.headline || parsed.name || '').trim();
    const snippet = String(
      parsed.snippet || parsed.description || parsed.summary || parsed.text || parsed.excerpt || ''
    ).trim();

    // Prefer the page's own title over a generic row title.
    const summary = (!rawTitle || GENERIC_TITLE.test(rawTitle)) && title ? title : (rawTitle || title);

    return {
      summary: summary.slice(0, 300),
      detail: snippet.slice(0, 600),
      url: parsed.url || parsed.link || null,
    };
  }

  return {
    summary: (rawTitle || rawContent).slice(0, 300),
    detail: (rawTitle ? rawContent : '').slice(0, 600),
    url: null,
  };
}

/**
 * The signal that made this lead worth contacting.
 *
 * This is the whole point of the personalisation: "you're hiring three DevOps
 * engineers" is a reason to write, where "I saw your website" is not. Ranked by
 * relevance, then recency, and falls back through the lead's own fields when
 * discovery stored no signal rows.
 */
async function resolveSignal(lead) {
  let signals = [];
  try {
    signals = await Signal.listByLead(lead.id);
  } catch (err) {
    signals = [];
  }

  const candidates = signals
    .filter(s => s.title || s.content)
    .map(signal => ({ signal, read: readSignalContent(signal) }))
    .filter(({ read }) => read.summary);

  const best = candidates.sort((a, b) => {
    // A signal that says something specific beats a higher-scored one that
    // only says where it came from.
    const aGeneric = GENERIC_TITLE.test(a.read.summary) ? 1 : 0;
    const bGeneric = GENERIC_TITLE.test(b.read.summary) ? 1 : 0;
    if (aGeneric !== bGeneric) return aGeneric - bGeneric;

    const relevance = (b.signal.relevance_score || 0) - (a.signal.relevance_score || 0);
    if (relevance !== 0) return relevance;
    return String(b.signal.detected_at || '').localeCompare(String(a.signal.detected_at || ''));
  })[0];

  // A signal that only names the collector is no reason to write, so treat it
  // as no signal at all and let the fallbacks below supply real context.
  if (best && !GENERIC_TITLE.test(best.read.summary)) {
    return {
      summary: best.read.summary,
      detail: best.read.detail,
      type: best.signal.signal_type || 'signal',
      source: best.signal.source || lead.source || 'discovery',
      url: best.read.url || best.signal.source_url || null,
      detectedAt: best.signal.detected_at || null,
      origin: 'signal_table',
    };
  }

  // No signal row: fall back to whatever discovery did capture. The AI score
  // explanation is the next best thing — it says why this lead ranked.
  const explanation = sanitiseStoredText(lead.explanation_text);
  if (explanation) {
    return {
      summary: explanation.slice(0, 300),
      detail: '',
      type: 'score_explanation',
      source: lead.source || 'discovery',
      url: lead.source_url || null,
      detectedAt: lead.discovery_timestamp || null,
      origin: 'score_explanation',
    };
  }

  const description = sanitiseStoredText(lead.company_description);
  if (description) {
    return {
      summary: description.slice(0, 300),
      detail: '',
      type: 'company_profile',
      source: lead.source || 'discovery',
      url: lead.source_url || null,
      detectedAt: lead.discovery_timestamp || null,
      origin: 'company_description',
    };
  }

  return {
    summary: '',
    detail: '',
    type: 'none',
    source: lead.source || 'discovery',
    url: lead.source_url || null,
    detectedAt: null,
    origin: 'none',
  };
}

function senderProfile() {
  return {
    name: config.OUTREACH_SENDER_NAME || '',
    title: config.OUTREACH_SENDER_TITLE || '',
    company: config.OUTREACH_SENDER_COMPANY || '',
    valueProp: config.OUTREACH_VALUE_PROP || '',
  };
}

/**
 * The system prompt: the rules a good first-touch email follows.
 *
 * The two hard constraints matter more than the style notes. Inventing facts
 * about a prospect's business is the fastest way to burn a domain's
 * reputation, and a model with thin context will happily do it unless told not
 * to. Same for the length cap: a 400-word cold email does not get read.
 */
const SYSTEM_PROMPT = [
  'You write first-touch B2B sales emails for a sales rep. You write the draft; a human reads and edits it before anything is sent.',
  '',
  'HARD RULES:',
  '- Use ONLY the facts given below. Never invent funding rounds, headcounts, product names, mutual connections, or events.',
  '- Never invent proof: no statistics, percentages, dollar figures, customer names, case studies or results. ' +
    'Sentences like "we helped similar firms cut costs by 30%" are forbidden unless that exact claim appears below. ' +
    'A model with thin context reaches for a number to sound credible; that number would be a lie in a real email to a real person.',
  '- If the trigger signal is thin or missing, write a shorter, more general email. Do NOT fill the gap with plausible-sounding detail.',
  '- Ask about the prospect\'s situation instead of asserting things about it.',
  '- Total body length: 60-120 words. Cold emails longer than that do not get read.',
  '- Exactly one call to action, and make it low-friction (a question they can answer in one line, not a 30-minute meeting request).',
  '',
  'STRUCTURE — the body must follow this shape:',
  '  Line 1: a greeting on its own line — "Hi <first name>," or, when no contact name is given, "Hi there,".',
  '  Then: the email itself, in short paragraphs separated by a blank line.',
  '  Last: a sign-off ("Thanks," or "Best,") and the sender name on the next line. Omit the name line entirely if no sender name is given.',
  '',
  'STYLE:',
  '- Subject line: 4-8 words, specific, no clickbait, no "Quick question", no ALL CAPS, no emoji.',
  '- Open the first paragraph by referencing the trigger signal. That is the reason you are writing.',
  '- Plain sentences. No "I hope this email finds you well", no "I wanted to reach out", no "synergy", "leverage", "circle back", "game-changer".',
  '- Write like one person emailing another, not like marketing copy.',
  '- Plain text only. No markdown, no bold, no bullet points, no HTML.',
  '',
  // Plain text rather than JSON. Every provider's strict-JSON mode chokes on
  // the line breaks a real email needs, and the failure arrives as a 400 that
  // costs the user their draft. This format parses just as reliably, and it is
  // the same shape a human can copy out of the Gemini web app — so one prompt
  // serves both paths.
  'OUTPUT FORMAT — respond with exactly this and nothing else:',
  'Subject: <the subject line>',
  '',
  '<the email body, including the greeting and the sign-off>',
  '',
  'No To: or From: headers, no commentary before or after, no code fences.',
].join('\n');

/**
 * The lead-specific half of the prompt.
 *
 * Fields that are missing are stated as missing rather than omitted. A model
 * shown "Contact name: not found" writes "Hi there"; a model shown nothing at
 * all tends to invent a name.
 */
function buildUserPrompt(lead, icp, signal, sender) {
  const line = (label, value, fallback = 'not found') =>
    `${label}: ${value || fallback}`;

  const sections = [
    'THE PROSPECT',
    line('Contact name', lead.contact_name),
    line('Contact title', lead.contact_title),
    line('Company', lead.company_name),
    line('Industry', lead.company_industry),
    line('Location', lead.company_location),
    line('Company size', lead.company_size ? `~${lead.company_size} employees` : null, 'unknown'),
    line('Website', lead.company_website),
    line('What the company does', lead.company_description
      ? String(lead.company_description).slice(0, 400)
      : null, 'not captured'),
    '',
    'THE TRIGGER SIGNAL — why this lead surfaced now',
  ];

  if (signal.summary && signal.origin === 'signal_table') {
    sections.push(line('Signal', signal.summary));
    if (signal.detail) sections.push(line('Detail', signal.detail));
    sections.push(line('Signal type', signal.type));
    sections.push(line('Found via', signal.source));
    if (signal.detectedAt) sections.push(line('Detected', signal.detectedAt));
  } else if (signal.summary) {
    // A score explanation or a scraped company blurb. Useful for aiming the
    // email, but it is our own internal wording — quoting it back would tell
    // the prospect they have been scored and filed by a machine.
    sections.push(
      'No external trigger event was captured for this lead.',
      'The following is INTERNAL context. Use it to decide what to write about. Never quote it, paraphrase it closely, or mention scores, rankings or ratings.',
      line(signal.origin === 'score_explanation' ? 'Internal note (why this lead ranked)' : 'Company background', signal.summary),
      'Because there is no external event to reference, open with the company or their work rather than pretending to have seen news about them.'
    );
  } else {
    sections.push(
      'No specific trigger signal was captured for this lead.',
      'Write a short, general email based on the company profile only. Do not pretend to have seen news about them.'
    );
  }

  sections.push('', 'THE SENDER — who is writing');
  sections.push(line('Name', sender.name, 'not set (sign off with just the greeting, leave the name blank)'));
  if (sender.title) sections.push(line('Title', sender.title));
  if (sender.company) sections.push(line('Company', sender.company));
  sections.push(line('What they sell', sender.valueProp,
    'not set (keep the ask generic — ask about the prospect\'s situation rather than pitching a product)'));

  if (icp) {
    sections.push('', 'WHO THE SENDER TARGETS (context only — do not quote this back to the prospect)');
    if (icp.name) sections.push(line('Segment', icp.name));
    if (icp.description) sections.push(line('Focus', icp.description));
  }

  sections.push(
    '',
    'Write the first-touch email now, using the Subject:/body format above.'
  );

  return sections.join('\n');
}

/**
 * Build everything the generators need for one lead.
 * Returns the two prompt halves plus the personalisation record stored on the
 * draft, so a draft can be audited later even after the lead has been rescored.
 */
async function buildForLead(lead, icp = null) {
  const signal = await resolveSignal(lead);
  const sender = senderProfile();

  return {
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(lead, icp, signal, sender),
    signal,
    sender,
    personalisation: {
      contact_name: lead.contact_name || null,
      contact_title: lead.contact_title || null,
      company_name: lead.company_name || null,
      company_industry: lead.company_industry || null,
      signal_summary: signal.summary || null,
      signal_type: signal.type,
      signal_source: signal.source,
      signal_origin: signal.origin,
      icp_name: icp?.name || null,
      built_at: new Date().toISOString(),
    },
  };
}

/**
 * The single self-contained block a user pastes into the Gemini web app.
 *
 * The API path can pass a system prompt separately; a chat box cannot, so the
 * two halves are concatenated. Nothing else changes — the handoff and the API
 * paths send byte-identical instructions, which is what makes a draft from
 * either one comparable to a draft from the other.
 */
function buildHandoffPrompt({ system, user }) {
  return [system, '', '─────────────────────────────────', '', user].join('\n');
}

module.exports = {
  buildForLead,
  buildHandoffPrompt,
  resolveSignal,
  senderProfile,
  SYSTEM_PROMPT,
};
