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
    // Requests in the last 24h. Groq's free tier caps daily requests (1000 on
    // the current key) and reports no daily counter, so it is tracked here:
    // without it a long run walks off the daily cliff mid-job and every
    // subsequent call 429s with no way to tell that apart from a burst limit.
    dayWindow: [],
    // Ceilings the API itself reported, which override the configured guesses.
    observedTpm: null,
    observedRpm: null,
    dayRemaining: null,
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

const DAY_MS = 86400000;

function prune(window, now, span = 60000) {
  while (window.length > 0 && now - window[0].at > span) window.shift();
}

function tokensUsed(state, now) {
  prune(state.tokenWindow, now);
  return state.tokenWindow.reduce((sum, entry) => sum + entry.tokens, 0);
}

/** Per-minute token ceiling: whatever the API last reported, else the config. */
function tpmFor(state) {
  return state.observedTpm || config.GROQ_TPM_LIMIT;
}

function rpmFor(state) {
  return state.observedRpm || config.GROQ_RPM_LIMIT;
}

/**
 * Earliest time this key could serve a request of `cost` tokens.
 * Returns Infinity for keys that are unusable for the rest of the process.
 */
function readyAt(state, cost, now) {
  if (state.disabled) return Infinity;
  if (state.cooldownUntil > now) return state.cooldownUntil;

  prune(state.requestWindow, now);
  prune(state.dayWindow, now, DAY_MS);
  const used = tokensUsed(state, now);

  const tokensFit = used + cost <= tpmFor(state) || state.tokenWindow.length === 0;
  const requestsFit = state.requestWindow.length < rpmFor(state);
  // The server's own daily counter beats the local one when it is available:
  // it also sees spend from other processes sharing this key.
  const dayFits = Number.isFinite(state.dayRemaining)
    ? state.dayRemaining > 0
    : state.dayWindow.length < config.GROQ_RPD_LIMIT;

  if (tokensFit && requestsFit && dayFits) return now;

  const waits = [];
  if (!tokensFit) waits.push(state.tokenWindow[0].at + 60000);
  if (!requestsFit) waits.push(state.requestWindow[0].at + 60000);
  // The daily bucket refills hours from now. Report it as unusable rather than
  // parking the whole run on a sleep — another key or provider should take over.
  if (!dayFits) return Infinity;
  return Math.max(...waits);
}

/**
 * Adopt the limits the API reported.
 *
 * The configured TPM was 11000 while the account's real ceiling is 8000, so the
 * pacer approved calls the server then rejected. Reading the ceiling back from
 * every response means a stale or optimistic setting costs one 429 at most.
 */
function reconcileLimits(state, headers) {
  if (!headers) return;

  const limitTokens = Number(headers['x-ratelimit-limit-tokens']);
  if (Number.isFinite(limitTokens) && limitTokens > 0 && limitTokens !== state.observedTpm) {
    if (!state.observedTpm) {
      logger.info(
        `[ai] ${state.label} reports ${limitTokens} tokens/min` +
        (limitTokens < config.GROQ_TPM_LIMIT
          ? ` — below the configured GROQ_TPM_LIMIT of ${config.GROQ_TPM_LIMIT}; pacing to the reported value.`
          : '.')
      );
    }
    state.observedTpm = limitTokens;
  }

  // A request ceiling in the hundreds is Groq's daily bucket, not a per-minute
  // one (the current key reports 1000/day). Recording it means the client knows
  // the day is spent before the run walks into a wall of 429s.
  const limitRequests = Number(headers['x-ratelimit-limit-requests']);
  const remainingRequests = Number(headers['x-ratelimit-remaining-requests']);
  if (Number.isFinite(limitRequests) && limitRequests >= 200) {
    if (Number.isFinite(remainingRequests)) {
      state.dayRemaining = remainingRequests;
      if (remainingRequests <= 25) {
        logger.warn(
          `[ai] ${state.label} has only ${remainingRequests} of ${limitRequests} daily requests left.`
        );
      }
    }
  } else if (Number.isFinite(limitRequests) && limitRequests > 0) {
    state.observedRpm = limitRequests;
  }

  // Trust the server's own view of what is left this minute: it accounts for
  // spend from other processes sharing the key, which the local window cannot.
  const remainingTokens = Number(headers['x-ratelimit-remaining-tokens']);
  if (Number.isFinite(remainingTokens)) {
    const ceiling = tpmFor(state);
    const consumed = Math.max(0, ceiling - remainingTokens);
    const localView = tokensUsed(state, Date.now());
    if (consumed > localView) {
      state.tokenWindow.push({ at: Date.now(), tokens: consumed - localView });
    }
  }
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
      const daily = pool.tiers.some(tier =>
        tier.states.some(s => !s.disabled && (
          Number.isFinite(s.dayRemaining) ? s.dayRemaining <= 0 : s.dayWindow.length >= config.GROQ_RPD_LIMIT
        ))
      );
      throw new Error(
        daily
          ? `Daily request quota is spent on every key for ${pool.label}. It resets on a rolling 24h window — ` +
            `add another key (GROQ_API_KEY_FALLBACK) or MISTRAL_API_KEY to keep running today.`
          : `No usable API key for ${pool.label} (all keys invalid or exhausted)`
      );
    }

    if (bestAt <= now) {
      // Reserve synchronously, before yielding, so concurrent callers observe
      // this spend instead of all racing on the same reading.
      best.tokenWindow.push({ at: now, tokens: cost });
      best.requestWindow.push({ at: now });
      best.dayWindow.push({ at: now });
      if (Number.isFinite(best.dayRemaining)) best.dayRemaining--;
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
          usableKeys: tier.states.filter(s => !s.disabled).length,
          // The measured ceilings, so the dashboard shows what the account can
          // actually do rather than what the config hopes for.
          limits: tier.states.map(s => ({
            key: s.label,
            tokensPerMinute: s.observedTpm || config.GROQ_TPM_LIMIT,
            dailyRequestsLeft: Number.isFinite(s.dayRemaining)
              ? s.dayRemaining
              : Math.max(0, config.GROQ_RPD_LIMIT - s.dayWindow.length),
            cooling: s.cooldownUntil > Date.now(),
            disabled: s.disabled
          }))
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

        // Adopt the ceilings and remaining budget the API just reported before
        // returning, so the next call paces against reality rather than config.
        reconcileLimits(state, res.headers);

        const content = res.data?.choices?.[0]?.message?.content;
        if (!content) throw new Error('empty completion');
        return content;
      } catch (err) {
        lastError = err;
        const status = err.response?.status;
        reconcileLimits(state, err.response?.headers);

        // Not every model accepts every reasoning_effort value — Groq's
        // openai/gpt-oss-* reject "none" and allow only low/medium/high.
        // Step down to the cheapest accepted value before giving up on the
        // parameter entirely: dropping it outright lets a reasoning model spend
        // the whole max_tokens budget thinking and return empty content, which
        // surfaces as "empty completion" rather than as the config problem it is.
        if (status === 400 && effort && /reasoning_effort/i.test(JSON.stringify(err.response?.data || ''))) {
          const nextEffort = effort === 'none' ? 'low' : null;
          logger.debug(
            `[ai] ${tier.model} rejected reasoning_effort="${effort}"; ` +
            `retrying with ${nextEffort ? `"${nextEffort}"` : 'the parameter removed'}`
          );
          effort = nextEffort;
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
          // A daily wall is not a burst limit: cooling down for the reported
          // few seconds would just retry into the same wall on every attempt.
          const detail = String(err.response?.data?.error?.message || '');
          if (/per day|daily|RPD/i.test(detail)) {
            state.dayRemaining = 0;
            logger.warn(`[groq] key ${state.label} has spent its daily request quota; switching keys.`);
            if (!this.availableFor(purpose)) break;
            continue;
          }

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
