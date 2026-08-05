// backend/services/outreach/geminiClient.js
const axios = require('axios');
const config = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Google Generative Language API (Gemini).
 *
 * This is the keyed path. The keyless path the user asked about — "call Gemini
 * with my browser login, like other sites do" — is not something a server can
 * do: Google issues no mechanism for a backend to borrow a signed-in browser
 * session, and scraping one would break on the first UI change even setting
 * aside the terms. Those other sites are either using a key of their own
 * server-side, or handing the prompt to the browser. LeadPulse does the second,
 * in outreach.js `mode=handoff`, with the user pasting the reply back.
 *
 * A free key from https://aistudio.google.com/apikey turns this path on and
 * makes generation one click instead of three.
 */

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Model names move faster than deployments do. If the configured model is not
// available to this key, fall through the list rather than failing the request
// — a slightly older Flash model writes a perfectly good cold email.
const MODEL_FALLBACKS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

function modelsToTry() {
  const configured = String(config.GEMINI_MODEL || '').trim();
  const chain = configured ? [configured, ...MODEL_FALLBACKS] : [...MODEL_FALLBACKS];
  return [...new Set(chain)];
}

/** A missing-model error is worth retrying on another model; a bad key is not. */
function isModelUnavailable(err) {
  const status = err.response?.status;
  if (status !== 404 && status !== 400) return false;
  const detail = JSON.stringify(err.response?.data || '');
  return /not found|not supported|unsupported|invalid model|does not exist/i.test(detail);
}

function errorDetail(err) {
  return err.response?.data?.error?.message || err.message || 'unknown error';
}

class GeminiClient {
  static get available() {
    return Boolean(config.GEMINI_API_KEY);
  }

  static get model() {
    return modelsToTry()[0];
  }

  /**
   * One generation call. Returns the model's text.
   *
   * @param {Object} opts
   * @param {string} opts.system       instructions applied to the whole turn
   * @param {string} opts.user         the request itself
   * @param {boolean} [opts.json]      ask for a JSON object back
   * @param {number} [opts.maxTokens]
   * @param {number} [opts.temperature]
   */
  static async generate({ system, user, json = false, maxTokens = 900, temperature = 0.7 }) {
    if (!this.available) {
      throw new Error('GEMINI_API_KEY is not set.');
    }

    let lastError;

    for (const model of modelsToTry()) {
      try {
        const res = await axios.post(
          `${API_ROOT}/${encodeURIComponent(model)}:generateContent`,
          {
            contents: [{ role: 'user', parts: [{ text: user }] }],
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            generationConfig: {
              temperature,
              maxOutputTokens: maxTokens,
              ...(json ? { responseMimeType: 'application/json' } : {}),
            },
          },
          {
            // The key goes in a header, not the query string: query strings end
            // up in proxy and server access logs.
            headers: {
              'x-goog-api-key': config.GEMINI_API_KEY,
              'Content-Type': 'application/json',
            },
            timeout: 45000,
          }
        );

        const candidate = res.data?.candidates?.[0];

        // A safety block returns 200 with no content, which would otherwise
        // surface as a confusing "empty response".
        if (!candidate && res.data?.promptFeedback?.blockReason) {
          throw new Error(`Gemini blocked the prompt (${res.data.promptFeedback.blockReason}).`);
        }

        const text = (candidate?.content?.parts || [])
          .map(part => part.text || '')
          .join('')
          .trim();

        if (!text) {
          const reason = candidate?.finishReason;
          throw new Error(
            reason === 'MAX_TOKENS'
              ? 'Gemini hit the output limit before writing anything usable.'
              : `Gemini returned an empty response${reason ? ` (${reason})` : ''}.`
          );
        }

        if (model !== modelsToTry()[0]) {
          logger.info(`[gemini] used fallback model ${model}`);
        }
        return text;
      } catch (err) {
        lastError = err;

        if (isModelUnavailable(err)) {
          logger.debug(`[gemini] ${model} unavailable for this key; trying the next model`);
          continue;
        }

        const status = err.response?.status;
        if (status === 401 || status === 403) {
          throw new Error(`Gemini rejected the API key (HTTP ${status}): ${errorDetail(err)}`);
        }
        if (status === 429) {
          throw new Error(`Gemini rate limit reached: ${errorDetail(err)}`);
        }
        throw new Error(`Gemini request failed${status ? ` (HTTP ${status})` : ''}: ${errorDetail(err)}`);
      }
    }

    throw new Error(
      `No Gemini model available to this key (tried ${modelsToTry().join(', ')}): ${errorDetail(lastError)}`
    );
  }
}

module.exports = GeminiClient;
