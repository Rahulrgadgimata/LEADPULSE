const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const { sleep } = require('../utils/concurrency');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';

// Mistral keys are 32 alphanumeric characters with no prefix.
function looksLikeMistralKey(key) {
  return /^[A-Za-z0-9]{28,40}$/.test(key) && !key.startsWith('gsk_');
}

/**
 * Single entry point for every Groq call in the app.
 *
 * Two things are routed here:
 *
 *  purpose 'extraction' — lead generation: turning scraped pages into companies,
 *      resolving the company a news article is about, and writing score
 *      explanations.
 *  purpose 'chat'       — the sales copilot.
 *
 * Each purpose has its own key pool and model, so a long discovery run cannot
 * starve the copilot of quota (and vice versa). Rate-limit windows are tracked
 * per API key rather than per pool, so a key shared by both purposes is still
 * accounted for exactly once.
 */

/** Groq secret keys look like "gsk_" + ~52 chars. */
function looksLikeGroqKey(key) {
  return /^gsk_[A-Za-z0-9]{20,}$/.test(key);
}

// One state object per distinct key, shared across pools.
const keyRegistry = new Map();

function registerKey(rawKey, provider) {
  const key = String(rawKey || '').trim();
  if (!key) return null;

  if (keyRegistry.has(key)) return keyRegistry.get(key);

  // Reject malformed keys up front. Left in place they burn a retry on every
  // call and then 401, which reads like a rate-limit problem.
  const valid = provider === 'mistral' ? looksLikeMistralKey(key) : looksLikeGroqKey(key);
  if (!valid) {
    logger.warn(
      `[ai] Ignoring a configured ${provider} key that does not match that ` +
      `provider's format ("${key.slice(0, 4)}…", ${key.length} chars).`
    );
    return null;
  }

  const state = {
    key,
    provider,
    label: `${provider}:${key.slice(0, 6)}…`,
    tokenWindow: [],
    requestWindow: [],
    disabled: false,
    cooldownUntil: 0
  };
  keyRegistry.set(key, state);
  return state;
}

/**
 * A tier is one provider's keys plus the model to use with them. Tiers are
 * tried in order, so Groq carries normal traffic and Mistral only picks up
 * whatever Groq cannot serve.
 */
function buildTier(provider, url, keys, model) {
  const states = [];
  for (const raw of keys) {
    for (const part of String(raw || '').split(',')) {
      const state = registerKey(part, provider);
      if (state && !states.includes(state)) states.push(state);
    }
  }
  return { provider, url, model, states };
}

function buildPool(label, groqKeys, groqModel, mistralModel) {
  const tiers = [
    buildTier('groq', GROQ_URL, groqKeys, groqModel),
    buildTier('mistral', MISTRAL_URL, [config.MISTRAL_API_KEY], mistralModel)
  ].filter(tier => tier.states.length > 0);

  if (tiers.length === 0) {
    logger.warn(`[ai] No usable API key for "${label}" — that capability is disabled.`);
  } else {
    logger.info(
      `[ai] ${label}: ` +
      tiers.map(t => `${t.provider}(${t.states.length} key${t.states.length === 1 ? '' : 's'}, ${t.model})`).join(' → ')
    );
  }
  return { tiers, label };
}

// Chat falls back to the main key when no dedicated chat key is configured.
const pools = {
  extraction: buildPool(
    'lead generation',
    [config.GROQ_API_KEY, config.GROQ_API_KEY_FALLBACK],
    config.GROQ_MODEL_EXTRACTION,
    config.MISTRAL_MODEL_EXTRACTION
  ),
  chat: buildPool(
    'copilot chat',
    [config.GROQ_CHAT_API_KEY || config.GROQ_API_KEY, config.GROQ_API_KEY_FALLBACK],
    config.GROQ_MODEL_CHAT,
    config.MISTRAL_MODEL_CHAT
  )
};

function poolFor(purpose) {
  return pools[purpose] || pools.extraction;
}

function prune(window, now) {
  while (window.length > 0 && now - window[0].at > 60000) window.shift();
}

function tokensUsed(state, now) {
  prune(state.tokenWindow, now);
  return state.tokenWindow.reduce((sum, entry) => sum + entry.tokens, 0);
}

/**
 * Earliest time this key could serve a request of `cost` tokens.
 * Returns Infinity for keys that are unusable for the rest of the process.
 */
function readyAt(state, cost, now) {
  if (state.disabled) return Infinity;
  if (state.cooldownUntil > now) return state.cooldownUntil;

  prune(state.requestWindow, now);
  const used = tokensUsed(state, now);

  const tokensFit = used + cost <= config.GROQ_TPM_LIMIT || state.tokenWindow.length === 0;
  const requestsFit = state.requestWindow.length < config.GROQ_RPM_LIMIT;
  if (tokensFit && requestsFit) return now;

  const waits = [];
  if (!tokensFit) waits.push(state.tokenWindow[0].at + 60000);
  if (!requestsFit) waits.push(state.requestWindow[0].at + 60000);
  return Math.max(...waits);
}

/**
 * Block until some key in this pool can take the call, then record the
 * reservation against it and return that key's state.
 */
async function reserve(pool, estimatedTokens) {
  const cost = Math.min(estimatedTokens, config.GROQ_TPM_LIMIT);

  while (true) {
    const now = Date.now();

    // Walk tiers in order: an immediately-available key in the preferred
    // provider always beats waiting, but a lower tier that is free right now
    // beats sitting idle on a rate-limited primary.
    let best = null;
    let bestTier = null;
    let bestAt = Infinity;

    for (const tier of pool.tiers) {
      for (const state of tier.states) {
        const at = readyAt(state, cost, now);
        if (at < bestAt) {
          bestAt = at;
          best = state;
          bestTier = tier;
        }
      }
      // Preferred provider can serve immediately — no need to consider fallbacks.
      if (bestAt <= now) break;
    }

    if (!best || bestAt === Infinity) {
      throw new Error(`No usable API key for ${pool.label} (all keys invalid or exhausted)`);
    }

    if (bestAt <= now) {
      // Reserve synchronously, before yielding, so concurrent callers observe
      // this spend instead of all racing on the same reading.
      best.tokenWindow.push({ at: now, tokens: cost });
      best.requestWindow.push({ at: now });
      return { state: best, tier: bestTier };
    }

    const wait = Math.min(Math.max(bestAt - now + 250, 250), 60000);
    logger.debug(`[ai] ${pool.label}: all keys saturated, waiting ${wait}ms`);
    await sleep(wait);
  }
}

/**
 * Groq states the exact wait in the 429 body ("Please try again in 9.03s") and
 * sometimes in retry-after; both beat blind backoff.
 */
function retryDelay(err, attempt) {
  const header = Number(err.response?.headers?.['retry-after']);
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000 + 250, 65000);

  const message = err.response?.data?.error?.message || '';
  const match = message.match(/try again in ([\d.]+)s/i);
  if (match) return Math.min(parseFloat(match[1]) * 1000 + 500, 65000);

  return Math.min(1000 * Math.pow(2, attempt), 30000);
}

class GroqClient {
  /** Whether a given purpose has at least one usable key on any provider. */
  static availableFor(purpose = 'extraction') {
    return poolFor(purpose).tiers.some(tier => tier.states.some(state => !state.disabled));
  }

  static get available() {
    return this.availableFor('extraction');
  }

  /** The model of the highest tier that still has a usable key. */
  static modelFor(purpose = 'extraction') {
    const tier = poolFor(purpose).tiers.find(t => t.states.some(s => !s.disabled));
    return tier ? tier.model : null;
  }

  static keyCountFor(purpose = 'extraction') {
    return poolFor(purpose).tiers
      .reduce((n, tier) => n + tier.states.filter(state => !state.disabled).length, 0);
  }

  /** Per-purpose provider/model/key summary, for the status endpoint. */
  static describe() {
    const out = {};
    for (const [purpose, pool] of Object.entries(pools)) {
      out[purpose] = {
        label: pool.label,
        tiers: pool.tiers.map(tier => ({
          provider: tier.provider,
          model: tier.model,
          keys: tier.states.length,
          usableKeys: tier.states.filter(s => !s.disabled).length
        }))
      };
    }
    return out;
  }

  /**
   * Run a chat completion. Returns the raw assistant string.
   * Throws only after exhausting retries; callers decide how to degrade.
   *
   * @param {Object} opts
   * @param {string} opts.system    system prompt
   * @param {string} opts.user      user payload
   * @param {string} [opts.purpose] 'extraction' (default) or 'chat'
   * @param {number} [opts.maxTokens]
   * @param {number} [opts.temperature]
   * @param {boolean} [opts.json]   request a JSON object response
   * @param {number} [opts.attempts]
   */
  static async chat({
    system, user, purpose = 'extraction', maxTokens = 1000,
    temperature = 0.1, json = false, attempts = 4,
    reasoningEffort = null, expectedOutputTokens = null
  }) {
    const pool = poolFor(purpose);
    if (!this.availableFor(purpose)) {
      throw new Error(`No usable Groq API key configured for ${pool.label}`);
    }

    // ~4 characters per token. Reserve against the output actually expected,
    // not the max_tokens ceiling: with reasoning disabled a call may cap at
    // 6000 yet emit ~400, and over-reserving would idle the whole budget.
    const outputBudget = expectedOutputTokens || maxTokens;
    const estimatedTokens = Math.ceil(((system?.length || 0) + (user?.length || 0)) / 4) + outputBudget;

    // Dropped automatically if this model rejects the parameter.
    let effort = reasoningEffort;

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });

    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const { state, tier } = await reserve(pool, estimatedTokens);

      try {
        const res = await axios.post(
          tier.url,
          {
            model: tier.model,
            messages,
            temperature,
            max_tokens: maxTokens,
            ...(effort ? { reasoning_effort: effort } : {}),
            ...(json ? { response_format: { type: 'json_object' } } : {})
          },
          {
            headers: {
              Authorization: `Bearer ${state.key}`,
              'Content-Type': 'application/json'
            },
            timeout: 60000
          }
        );

        const content = res.data?.choices?.[0]?.message?.content;
        if (!content) throw new Error('empty completion');
        return content;
      } catch (err) {
        lastError = err;
        const status = err.response?.status;

        // Not every model accepts reasoning_effort. Drop it and retry rather
        // than failing the call outright.
        if (status === 400 && effort && /reasoning_effort/i.test(JSON.stringify(err.response?.data || ''))) {
          logger.debug(`[ai] ${tier.model} rejected reasoning_effort="${effort}"; retrying without it`);
          effort = null;
          continue;
        }

        // A rejected or unpaid key will never recover during this process, so
        // retire it and let the remaining keys carry the run.
        if (status === 401 || status === 403 || status === 402) {
          state.disabled = true;
          logger.warn(
            `[groq] key ${state.label} disabled after HTTP ${status} ` +
            `(${err.response?.data?.error?.message || 'rejected'}). ` +
            `${this.keyCountFor(purpose)} usable key(s) remain for ${pool.label}.`
          );
          if (!this.availableFor(purpose)) break;
          continue; // immediately retry on another key
        }

        const retryable = status === 429 || status === 500 || status === 502 ||
          status === 503 || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
        if (!retryable || attempt === attempts) break;

        const delay = retryDelay(err, attempt);
        if (status === 429) {
          // Trust the server over the local estimate: park this key until the
          // window it reported has passed, so other keys get the next call.
          state.cooldownUntil = Date.now() + delay;
          logger.debug(`[groq] key ${state.label} rate-limited; cooling down ${delay}ms`);
          continue;
        }

        logger.debug(`[groq] attempt ${attempt} failed (${status || err.code}); retrying in ${delay}ms`);
        await sleep(delay);
      }
    }

    const status = lastError?.response?.status;
    const detail = lastError?.response?.data?.error?.message || lastError?.message;
    throw new Error(`Groq request failed${status ? ` (HTTP ${status})` : ''}: ${detail}`);
  }

  /**
   * Chat completion parsed as JSON. Tolerates models that wrap JSON in fences
   * or emit a <think> preamble (Qwen reasoning models do this).
   */
  static async chatJson(opts) {
    const raw = await this.chat({ ...opts, json: true });
    try {
      return JSON.parse(raw);
    } catch (err) {
      const cleaned = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      try {
        return JSON.parse(cleaned);
      } catch (e) { /* fall through to brace extraction */ }

      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch (e) { /* fall through */ }
      }
      throw new Error(`Groq returned unparseable JSON: ${String(raw).slice(0, 160)}`);
    }
  }
}

module.exports = GroqClient;
