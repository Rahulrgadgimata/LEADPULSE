// backend/services/outreach/messageGenerator.js
const axios = require('axios');
const config = require('../../config/env');
const logger = require('../../utils/logger');
const GroqClient = require('../groqClient');
const GeminiClient = require('./geminiClient');
const promptBuilder = require('./promptBuilder');

/**
 * Writes the first-draft email for a lead.
 *
 * Four engines sit behind one function, because the useful property is that the
 * Generate button always produces something. A missing key should downgrade the
 * draft's quality, never leave the user staring at an error with a lead they
 * still have to email.
 *
 *   gemini   — Google Generative Language API (GEMINI_API_KEY)
 *   claude   — Anthropic Messages API (ANTHROPIC_API_KEY)
 *   groq     — reuses the keys discovery already runs on
 *   template — deterministic, no network call, no key
 *
 * A fifth mode, `handoff`, returns the prompt instead of a draft so the browser
 * can open Gemini under the user's own login. See buildHandoff below.
 */

const PROVIDERS = ['gemini', 'claude', 'groq', 'template'];

/** Which engines can actually run right now. */
function availableProviders() {
  const available = [];
  if (GeminiClient.available) available.push('gemini');
  if (config.ANTHROPIC_API_KEY) available.push('claude');
  if (GroqClient.availableFor('chat')) available.push('groq');
  available.push('template'); // always
  return available;
}

/**
 * Resolve the configured preference to a provider that can run.
 *
 * An explicitly configured provider that is not usable falls back rather than
 * failing: the alternative is a Generate button that breaks the moment a key
 * expires, which is exactly when the user least wants to debug configuration.
 */
function resolveProvider(requested = null) {
  const available = availableProviders();
  const wanted = String(requested || config.OUTREACH_AI_PROVIDER || 'auto').toLowerCase();

  if (wanted !== 'auto' && PROVIDERS.includes(wanted)) {
    if (available.includes(wanted)) return wanted;
    logger.warn(`[outreach] provider "${wanted}" is not configured; falling back to ${available[0]}`);
  }

  return available[0];
}

/**
 * Pull {subject, body} out of whatever the model returned.
 *
 * The prompt asks for "Subject: ...\n\n<body>", but models wrap replies in code
 * fences, prefix them with "Here's your email:", or answer in JSON anyway. All
 * of those are recoverable, and recovering beats showing the user a parse error
 * over an email that is sitting right there in the response. The same parser
 * handles text pasted back from the Gemini web app, which is why it tolerates
 * markdown bolding around the labels.
 */
function parseDraft(raw) {
  const text = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();

  if (!text) throw new Error('The model returned an empty draft.');

  // 1. The requested format: "Subject: ...", then the body.
  const subjectMatch = text.match(/^[ \t]*(?:\*\*)?subject(?:\*\*)?[ \t]*:[ \t]*(.+)$/im);
  if (subjectMatch) {
    const subject = subjectMatch[1].replace(/\*\*/g, '').trim();
    const body = text
      .slice(text.indexOf(subjectMatch[0]) + subjectMatch[0].length)
      .replace(/^[ \t]*(?:\*\*)?body(?:\*\*)?[ \t]*:[ \t]*/i, '')
      .trim();
    if (body) return { subject, body };
  }

  // 2. JSON, if the model decided to answer that way regardless.
  const fromJson = candidate => {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== 'object') return null;
    const body = String(parsed.body || parsed.message || '').trim();
    if (!body) return null;
    return { subject: String(parsed.subject || '').trim(), body };
  };

  const braced = text.match(/\{[\s\S]*\}/);
  for (const candidate of [text, braced ? braced[0] : null]) {
    if (!candidate) continue;
    try {
      const parsed = fromJson(candidate);
      if (parsed) return parsed;
    } catch (e) { /* not JSON; keep going */ }
  }

  // 3. No subject anywhere — treat the whole response as the body. The user is
  //    about to read and edit this, so a missing subject line is a far smaller
  //    problem than losing the draft.
  return { subject: '', body: text };
}

/** Strip the formatting a plain-text email should not carry. */
function tidyBody(body) {
  return String(body || '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*```[a-z]*\s*$/gim, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function tidySubject(subject, lead) {
  const clean = String(subject || '')
    .replace(/^\s*subject\s*:\s*/i, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();

  if (clean) return clean.slice(0, 200);
  // Never send a blank subject line — it reads as spam to both filters and
  // people. The company name is the least presumptuous fallback available.
  return lead?.company_name ? `Quick note for ${lead.company_name}` : 'Quick note';
}

// ─── Providers ──────────────────────────────────────────────────────────────

async function generateWithGemini(prompt) {
  return GeminiClient.generate({
    system: prompt.system,
    user: prompt.user,
    // A 120-word email needs far fewer tokens than this, but reasoning-capable
    // models spend part of the budget thinking before they emit anything. At
    // 900 they were running out mid-sentence, or returning nothing at all.
    maxTokens: 2000,
    temperature: 0.7,
  });
}

async function generateWithGroq(prompt) {
  return GroqClient.chat({
    system: prompt.system,
    user: prompt.user,
    purpose: 'chat',
    // A 120-word email needs far fewer tokens than this, but reasoning-capable
    // models spend part of the budget thinking before they emit anything. At
    // 900 they were running out mid-sentence, or returning nothing at all.
    maxTokens: 2000,
    temperature: 0.7,
    attempts: 2,
    reasoningEffort: config.GROQ_CHAT_REASONING,
  });
}

async function generateWithClaude(prompt) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: config.ANTHROPIC_MODEL,
      max_tokens: 2000,
      temperature: 0.7,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    },
    {
      headers: {
        'x-api-key': config.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 45000,
    }
  );

  const text = (res.data?.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();

  if (!text) throw new Error('Claude returned an empty response.');
  return text;
}

/**
 * The no-API-key path: a real, sendable email assembled from the lead's own
 * fields. Deliberately plain — it is a starting point the user edits, and a
 * plain accurate email beats a florid invented one.
 */
function generateFromTemplate(lead, prompt) {
  const firstName = String(lead.contact_name || '').trim().split(/\s+/)[0];
  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
  const company = lead.company_name || 'your team';
  const { signal, sender } = prompt;

  // Only an externally observable signal may be quoted. The other origins are
  // our own internal text — a score explanation reads "The lead scores 68/100
  // because…", and pasting that into a cold email tells the prospect they have
  // been scored by a machine.
  const quotableSignal = signal.origin === 'signal_table' ? signal.summary : '';

  const opening = quotableSignal
    ? `I came across ${company} — ${String(quotableSignal).replace(/\s+/g, ' ').slice(0, 180)}.`
    : `I came across ${company}${lead.company_industry ? ` while looking at ${lead.company_industry} teams` : ''}.`;

  const middle = sender.valueProp
    ? `${sender.valueProp}${sender.company ? ` — that's what we do at ${sender.company}.` : '.'}`
    : `I work with ${lead.company_industry || 'teams'} on exactly the kind of thing that tends to follow.`;

  const ask = lead.contact_title
    ? `Worth a short conversation, or is this not on your plate as ${lead.contact_title}?`
    : 'Is this something you are looking at right now?';

  const signOff = ['Thanks,', sender.name, sender.title, sender.company].filter(Boolean).join('\n');

  const subject = quotableSignal && lead.company_name
    ? `${lead.company_name} — a thought on ${lead.company_industry || 'your roadmap'}`
    : `Quick note for ${company}`;

  // Same "Subject: …" shape the models are asked for, so one parser covers
  // every path in and there is no second format to keep in step.
  return [
    `Subject: ${subject}`,
    '',
    greeting,
    '',
    opening,
    '',
    middle,
    '',
    ask,
    '',
    signOff,
  ].join('\n');
}

// ─── Entry points ───────────────────────────────────────────────────────────

/**
 * Generate a draft for one lead.
 *
 * @param {Object} lead     lead row, joined with its score
 * @param {Object} [icp]    the ICP the lead belongs to, for context
 * @param {Object} [opts]
 * @param {string} [opts.provider]  override the configured provider
 * @returns {Promise<{subject, body, provider, prompt, personalisation, signal, warning}>}
 */
async function generateForLead(lead, icp = null, opts = {}) {
  const prompt = await promptBuilder.buildForLead(lead, icp);
  const provider = resolveProvider(opts.provider);

  let raw;
  let usedProvider = provider;
  let warning = null;

  try {
    if (provider === 'gemini') raw = await generateWithGemini(prompt);
    else if (provider === 'claude') raw = await generateWithClaude(prompt);
    else if (provider === 'groq') raw = await generateWithGroq(prompt);
    else raw = generateFromTemplate(lead, prompt);
  } catch (err) {
    // A provider outage should not cost the user their draft. Drop to the
    // template, and say so — a silently downgraded draft would leave them
    // wondering why the AI suddenly writes like a mail merge.
    if (provider === 'template') throw err;

    logger.warn(`[outreach] ${provider} generation failed (${err.message}); using the template writer instead`);
    warning = `${provider} was unavailable (${err.message}). This draft came from the built-in template writer — worth a closer edit.`;
    usedProvider = 'template';
    raw = generateFromTemplate(lead, prompt);
  }

  const parsed = parseDraft(raw);

  return {
    subject: tidySubject(parsed.subject, lead),
    body: tidyBody(parsed.body),
    provider: usedProvider,
    prompt: `${prompt.system}\n\n---\n\n${prompt.user}`,
    personalisation: { ...prompt.personalisation, provider: usedProvider },
    signal: prompt.signal,
    warning,
  };
}

/**
 * The browser-handoff payload: everything the page needs to open Gemini under
 * the user's own Google login with this lead's prompt in hand.
 *
 * No key is used and no draft is produced here — the user is the one who runs
 * the model, then pastes the answer back into the editor.
 */
async function buildHandoff(lead, icp = null) {
  const prompt = await promptBuilder.buildForLead(lead, icp);
  const text = promptBuilder.buildHandoffPrompt(prompt);

  return {
    provider: 'handoff',
    prompt: text,
    // Gemini's web app has no documented prompt-prefill parameter, so the page
    // copies the prompt to the clipboard and opens a plain chat. `q` is sent
    // anyway: harmless if ignored, one less paste for the user if honoured.
    //
    // Sent whole rather than truncated. A clipped prompt is the worse failure
    // of the two — if Gemini ever does honour the parameter, a half prompt
    // yields a confidently wrong email, whereas a long URL is merely ignored.
    // Chrome takes ~32k; these prompts run to about 3.5k.
    url: `${config.GEMINI_WEB_URL}?q=${encodeURIComponent(text)}`,
    baseUrl: config.GEMINI_WEB_URL,
    personalisation: { ...prompt.personalisation, provider: 'handoff' },
    signal: prompt.signal,
  };
}

/** What the UI shows in its "which engine is writing?" line. */
function describe() {
  const available = availableProviders();
  const active = resolveProvider();

  return {
    configured: config.OUTREACH_AI_PROVIDER,
    active,
    available,
    models: {
      gemini: GeminiClient.available ? GeminiClient.model : null,
      claude: config.ANTHROPIC_API_KEY ? config.ANTHROPIC_MODEL : null,
      groq: GroqClient.availableFor('chat') ? GroqClient.modelFor('chat') : null,
    },
    // The handoff never depends on server configuration — that is its point.
    handoff: { available: true, url: config.GEMINI_WEB_URL },
  };
}

module.exports = {
  generateForLead,
  buildHandoff,
  describe,
  resolveProvider,
  availableProviders,
  parseDraft,
  tidyBody,
  tidySubject,
};
