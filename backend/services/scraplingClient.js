const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const logger = require('../utils/logger');
const config = require('../config/env');

/**
 * Node bridge to the Scrapling Python sidecar (backend/scrapling/server.py).
 *
 * Scrapling source lives at backend/scrapling/upstream (cloned from
 * https://github.com/D4Vinci/Scrapling) and is installed editable so the
 * sidecar always runs the local package.
 */

const SERVICE_DIR = path.join(__dirname, '../scrapling');
const SERVER_SCRIPT = path.join(SERVICE_DIR, 'server.py');
const UPSTREAM_DIR = path.join(SERVICE_DIR, 'upstream');

let child = null;
let starting = null;
let lastSpawnAttemptAt = 0;
let consecutiveBootFails = 0;

function baseUrl() {
  const host = config.SCRAPLING_HOST || '127.0.0.1';
  const port = config.SCRAPLING_PORT || 3765;
  return `http://${host}:${port}`;
}

function request(method, route, body, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, baseUrl());
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        timeout: timeoutMs,
        headers: {
          Accept: 'application/json',
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': payload.length,
              }
            : {}),
        },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch (err) {
            return reject(new Error(`Scrapling bad JSON (${res.statusCode}): ${raw.slice(0, 200)}`));
          }
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Scrapling request timed out'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function healthCheck() {
  try {
    const { status, data } = await request('GET', '/health', null, 2500);
    return status === 200 && data?.ok === true;
  } catch {
    return false;
  }
}

function resolvePython() {
  return config.SCRAPLING_PYTHON || process.env.SCRAPLING_PYTHON || 'py';
}

function spawnArgs() {
  const python = resolvePython();
  if (/^py(\.exe)?$/i.test(path.basename(python))) {
    return [python, '-3.10', SERVER_SCRIPT];
  }
  return [python, SERVER_SCRIPT];
}

function pythonEnv() {
  const env = {
    ...process.env,
    SCRAPLING_HOST: config.SCRAPLING_HOST || '127.0.0.1',
    SCRAPLING_PORT: String(config.SCRAPLING_PORT || 3765),
    SCRAPLING_DEFAULT_MODE: config.SCRAPLING_DEFAULT_MODE || 'fetcher',
    PYTHONUNBUFFERED: '1',
  };

  // Prefer the vendored clone so imports resolve even if pip editable broke.
  if (fs.existsSync(UPSTREAM_DIR)) {
    const src = path.join(UPSTREAM_DIR);
    env.PYTHONPATH = env.PYTHONPATH ? `${src}${path.delimiter}${env.PYTHONPATH}` : src;
  }
  return env;
}

async function ensureStarted() {
  if (!config.SCRAPLING_ENABLED) return false;

  // Always prefer an already-healthy sidecar (even if we did not spawn it).
  if (await healthCheck()) {
    consecutiveBootFails = 0;
    return true;
  }

  if (starting) return starting;

  // Back off after repeated spawn failures so discovery is not blocked.
  const now = Date.now();
  if (consecutiveBootFails >= 3 && now - lastSpawnAttemptAt < 60000) {
    return false;
  }

  starting = (async () => {
    lastSpawnAttemptAt = Date.now();
    try {
      if (child && !child.killed) {
        try { child.kill(); } catch { /* */ }
        child = null;
      }

      const [cmd, ...args] = spawnArgs();
      logger.info(`Starting Scrapling sidecar: ${cmd} ${args.join(' ')}`);
      child = spawn(cmd, args, {
        cwd: SERVICE_DIR,
        env: pythonEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      child.stdout.on('data', buf => {
        const line = String(buf).trim();
        if (line) logger.info(`[scrapling] ${line}`);
      });
      child.stderr.on('data', buf => {
        const line = String(buf).trim();
        if (line) logger.warn(`[scrapling] ${line}`);
      });
      child.on('exit', (code, signal) => {
        logger.warn(`Scrapling sidecar exited (code=${code}, signal=${signal})`);
        child = null;
      });
      child.on('error', err => {
        logger.warn(`Scrapling sidecar spawn error: ${err.message}`);
        child = null;
      });

      const deadline = Date.now() + (config.SCRAPLING_BOOT_TIMEOUT_MS || 25000);
      while (Date.now() < deadline) {
        if (await healthCheck()) {
          consecutiveBootFails = 0;
          logger.info(`Scrapling sidecar ready at ${baseUrl()}`);
          return true;
        }
        await new Promise(r => setTimeout(r, 400));
      }
      consecutiveBootFails += 1;
      logger.warn(
        `Scrapling sidecar did not become healthy (fail #${consecutiveBootFails}). ` +
        `Node scrapers will continue without it.`
      );
      return false;
    } catch (err) {
      consecutiveBootFails += 1;
      logger.warn(`Scrapling start failed: ${err.message}`);
      return false;
    } finally {
      starting = null;
    }
  })();

  return starting;
}

async function fetchHtml(url, opts = {}) {
  if (!config.SCRAPLING_ENABLED) return null;
  const ready = await ensureStarted();
  if (!ready) return null;

  try {
    const { data } = await request(
      'POST',
      '/fetch',
      {
        url,
        mode: opts.mode || config.SCRAPLING_DEFAULT_MODE || 'fetcher',
        timeout_ms: opts.timeoutMs || config.SCRAPER_PAGE_TIMEOUT_MS || 30000,
      },
      Math.max((opts.timeoutMs || 45000) + 5000, 20000)
    );
    if (!data?.ok || !data.html) return null;
    return {
      html: data.html,
      finalUrl: data.url || url,
      status: data.status || 200,
      mode: data.mode,
    };
  } catch (err) {
    logger.warn(`Scrapling fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

async function search(query, engine = 'google', limit = 10, opts = {}) {
  if (!config.SCRAPLING_ENABLED) return { ok: false, results: [], blocked: false };
  const ready = await ensureStarted();
  if (!ready) return { ok: false, results: [], blocked: true, error: 'sidecar_down' };

  try {
    const { data } = await request(
      'POST',
      '/search',
      {
        query,
        engine,
        limit,
        mode: opts.mode || config.SCRAPLING_DEFAULT_MODE || 'fetcher',
      },
      90000
    );
    const results = Array.isArray(data?.results) ? data.results : [];
    if (results.length > 0) {
      logger.info(`Scrapling ${engine} "${query}" -> ${results.length} (${data.mode || 'fetcher'})`);
    }
    return {
      ok: Boolean(data?.ok) && results.length > 0,
      results,
      blocked: Boolean(data?.blocked) || (!data?.ok && results.length === 0),
      mode: data?.mode,
      error: data?.error,
    };
  } catch (err) {
    logger.warn(`Scrapling search failed (${engine}): ${err.message}`);
    return { ok: false, results: [], blocked: true, error: err.message };
  }
}

async function shutdown() {
  if (!child) return;
  const proc = child;
  child = null;
  try {
    proc.kill();
  } catch (err) {
    logger.debug(`Scrapling shutdown: ${err.message}`);
  }
}

module.exports = {
  ensureStarted,
  fetchHtml,
  search,
  shutdown,
  healthCheck,
  baseUrl,
};
