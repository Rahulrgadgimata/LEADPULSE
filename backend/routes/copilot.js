const express = require('express');
const GroqClient = require('../services/groqClient');
const ICP = require('../models/ICP');
const Lead = require('../models/Lead');
const logger = require('../utils/logger');
const config = require('../config/env');

const router = express.Router();

const MAX_MESSAGE_LENGTH = 2000;
const CONTEXT_LEAD_COUNT = 25;

function stripReasoning(text) {
  let out = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const dangling = out.search(/<think>/i);
  if (dangling !== -1) out = out.slice(0, dangling);
  return out.trim();
}

/**
 * Models often dump broken markdown tables (empty rows of dashes). Convert
 * those into clean numbered lines a sales rep can read in chat.
 */
function polishAssistantReply(text) {
  let out = String(text || '').trim();
  if (!out) return out;

  // Collapse markdown tables into plain lines.
  if (/\|.+\|/.test(out) && /\|\s*-+\s*\|/.test(out)) {
    const lines = out.split(/\r?\n/);
    const rebuilt = [];
    let rank = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        rebuilt.push('');
        continue;
      }
      // Skip separator rows: |---|---|
      if (/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(trimmed)) continue;
      // Skip header-ish rows that are only column labels
      if (/^\|.*(rank|company|industry|contact|email|score).*\|$/i.test(trimmed) &&
          (trimmed.match(/\|/g) || []).length >= 4) {
        continue;
      }
      if (trimmed.includes('|')) {
        const cells = trimmed
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map(c => c.trim())
          .filter(Boolean)
          .filter(c => c !== '-' && c !== '—' && c !== '–' && !/^-+$/.test(c));
        if (cells.length === 0) continue;
        rank += 1;
        // Prefer "1. Company — detail · detail"
        const [first, ...rest] = cells;
        const details = rest.filter(c => !/^(n\/?a|none|null|undefined|-)$/i.test(c));
        rebuilt.push(`${rank}. ${first}${details.length ? ' — ' + details.join(' · ') : ''}`);
      } else {
        rebuilt.push(trimmed);
      }
    }
    out = rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Strip leftover markdown bold/headers that look noisy in the chat bubble.
  out = out
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  return out;
}

function formatLeadLine(l, index) {
  const parts = [
    `${index + 1}. ${l.company_name || 'Unknown company'}`
  ];
  if (l.total_score != null) parts.push(`Score ${l.total_score}/100 (${l.tier || 'unscored'})`);
  if (l.company_industry) parts.push(`Industry: ${l.company_industry}`);
  if (l.company_location) parts.push(`Location: ${l.company_location}`);
  if (l.company_size) parts.push(`Size: ~${l.company_size} employees`);
  if (l.contact_name || l.contact_title) {
    parts.push(
      `Buyer: ${[l.contact_name, l.contact_title].filter(Boolean).join(' · ') || 'title unknown'}`
    );
  }
  if (l.contact_email) parts.push(`Email: ${l.contact_email}`);
  else parts.push('Email: not found yet');
  if (l.contact_linkedin) parts.push(`LinkedIn: ${l.contact_linkedin}`);
  if (l.company_website) parts.push(`Website: ${l.company_website}`);
  if (l.company_description) parts.push(`About: ${String(l.company_description).slice(0, 140)}`);
  return parts.join('\n   ');
}

router.post('/chat', async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'A message is required.' });
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters).` });
    }

    if (!GroqClient.availableFor('chat')) {
      return res.status(503).json({
        error: 'AI copilot is unavailable: no Groq API key is configured for chat. Set GROQ_CHAT_API_KEY (or GROQ_API_KEY) in backend .env.'
      });
    }

    let icp = null;
    let leads = [];
    if (req.body?.icpId) {
      icp = await ICP.getById(String(req.body.icpId));
      if (icp) {
        leads = await Lead.listByIcp(icp.id, CONTEXT_LEAD_COUNT, 0);
        // Prefer highest scores first for "top leads" style questions.
        leads = [...leads].sort((a, b) => (b.total_score || 0) - (a.total_score || 0));
      }
    }

    const leadContext = leads.length > 0
      ? leads.map((l, i) => formatLeadLine(l, i)).join('\n\n')
      : '(No leads in this ICP yet. Tell the user to click Find Leads, then ask again.)';

    const system = [
      'You are LeadPulse Copilot — a sharp B2B sales assistant sitting next to the rep.',
      'Speak like a helpful teammate: clear, direct, practical. No fluff.',
      '',
      'RESPONSE RULES (strict):',
      '- NEVER use markdown tables (| columns |). They break in this chat UI.',
      '- NEVER output empty placeholder rows, dashes-only lines, or "---|---".',
      '- Use short numbered lists or short paragraphs.',
      '- When listing leads, format each as:',
      '  1. Company Name — Score XX (tier)',
      '     Industry · Location · Buyer / title',
      '     Email: ... (or "not found yet") · Website/LinkedIn if available',
      '     One-line why to call them / suggested next step',
      '- If a field is missing, write "not found yet" — never leave blanks or dashes.',
      '- Only use companies from the pipeline data below. Do not invent leads.',
      '- If asked for top N and fewer exist, list what you have and say so.',
      '- End with one concrete next action when helpful (e.g. draft email, call first).',
      '',
      `Active ICP: ${icp?.name || 'none selected'}`,
      icp?.description ? `ICP focus: ${icp.description}` : null,
      '',
      `Pipeline leads (${leads.length}), highest score first:`,
      leadContext
    ].filter(Boolean).join('\n');

    const reply = await GroqClient.chat({
      system,
      user: message,
      purpose: 'chat',
      maxTokens: 1100,
      temperature: 0.35,
      attempts: 2,
      reasoningEffort: config.GROQ_CHAT_REASONING
    });

    const clean = polishAssistantReply(stripReasoning(reply));
    if (!clean) {
      return res.status(502).json({
        error: 'The model returned only internal reasoning and no answer. Try a shorter question.'
      });
    }

    res.json({
      reply: clean,
      leadsInContext: leads.length,
      model: GroqClient.modelFor('chat')
    });
  } catch (err) {
    logger.warn(`Copilot request failed: ${err.message}`);
    res.status(502).json({ error: `AI copilot unavailable: ${err.message}` });
  }
});

module.exports = router;
