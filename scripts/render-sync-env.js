/**
 * Push local .env values to a Render service.
 *
 *   RENDER_API_KEY=rnd_xxx RENDER_SERVICE_ID=srv_xxx node scripts/render-sync-env.js
 *
 * Render's env-var endpoint is a full replace, not a patch, so this reads the
 * service's current variables first and merges. Anything Render generated (a
 * `generateValue` secret, for instance) survives unless .env overrides it.
 * Blank values in .env are skipped rather than written as empty strings —
 * an unset key falls back to the code's default, an empty one does not.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const apiKey = process.env.RENDER_API_KEY;
const serviceId = process.env.RENDER_SERVICE_ID;

if (!apiKey || !serviceId) {
  console.error('RENDER_API_KEY and RENDER_SERVICE_ID are required.');
  process.exit(1);
}

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.render.com',
        path: urlPath,
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`${method} ${urlPath} → ${res.statusCode}: ${data.slice(0, 400)}`));
          }
          try {
            resolve(data ? JSON.parse(data) : null);
          } catch (e) {
            reject(new Error(data.slice(0, 400)));
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Values that must differ from a developer's machine. SCRAPLING_PYTHON is `py`
// locally (the Windows launcher) and `python3` in the container.
//
// DATABASE_URL is deliberately absent: it is a secret that comes from .env like
// the API keys, and it is now the only place application data lives.
const overrides = {
  NODE_ENV: 'production',
  TRUST_PROXY: 'true',
  SCRAPLING_ENABLED: 'true',
  SCRAPLING_HOST: '127.0.0.1',
  SCRAPLING_PORT: '3765',
  SCRAPLING_PYTHON: 'python3',

  // ── Fitting inside the 512Mi free instance ────────────────────────────────
  // The container was OOM-killed (exit 137) twice mid-discovery, and because
  // the free plan has no disk, each kill also wiped the database. A dev machine
  // has memory to spare, so these are set here rather than in .env.
  // 512Mi holds a Node process, a Python Scrapling sidecar and the run's
  // working set. Runs at 30 and then 15 leads both ended with the container
  // restarting mid-run, and with no disk each restart wiped the database — so
  // everything below is sized for survival rather than throughput.
  //
  // The heap cap is the safety net, not the fix: it makes V8 collect garbage
  // rather than grow until the kernel steps in, and leaves room for Python.
  NODE_OPTIONS: '--max-old-space-size=256',
  SCRAPER_BROWSER_ENABLED: 'false',
  SCRAPLING_STEALTH_ENABLED: 'false',

  // Serial. Peak memory is set by how many scraped pages are held at once, and
  // concurrency is the direct multiplier on that — the one lever that cuts the
  // peak without giving up a source. A run takes longer instead, which the
  // ten-minute budget already allows for.
  SCRAPER_CONCURRENCY: '1',
  ENRICHMENT_CONCURRENCY: '1',
  SCRAPLING_CONCURRENCY: '1',

  // News holds every article in memory before batching them through the model,
  // so it was the largest single allocation in a run — 150 articles with their
  // content against a handful of companies per web query.
  NEWS_MAX_ARTICLES: '60',
  NEWS_MAX_QUERIES: '6',
  NEWS_CONCURRENCY: '2',

  // Discovery volume, matching render.yaml rather than .env: a dev machine is
  // sized for far more, and syncing its numbers onto the free instance is what
  // OOM-killed it. Raise these together with the `disk:` block on a paid plan.
  DISCOVERY_TARGET_LEADS: '10',
  DISCOVERY_MAX_QUERIES: '6',
  LINKEDIN_TARGET_LEADS: '5',
  LINKEDIN_MAX_QUERIES: '3',
  BUYER_TARGET_LEADS: '5',
  BUYER_MAX_QUERIES: '3',
  DISCOVERY_DIRECTORY_PAGES: '2',
  DISCOVERY_DIRECTORY_LINKS: '10',

  // A spreadsheet import enriches every row, so it is capped like a run.
  IMPORT_MAX_ROWS: '150',
  IMPORT_MAX_FILE_MB: '5',
};

// Render injects PORT itself and routes to whatever the service binds. Copying
// the local PORT over that makes the two disagree, so it never gets synced.
const NEVER_SYNC = new Set(['PORT']);

function readDotEnv() {
  const vars = {};
  const envPath = path.join(__dirname, '../.env');
  if (!fs.existsSync(envPath)) return vars;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i < 1) continue;
    const key = trimmed.slice(0, i).trim();
    const val = trimmed.slice(i + 1).trim();
    if (key && val) vars[key] = val;
  }
  return vars;
}

(async () => {
  const [service, existing] = await Promise.all([
    api('GET', `/v1/services/${serviceId}`),
    api('GET', `/v1/services/${serviceId}/env-vars?limit=100`),
  ]);

  const merged = {};
  for (const row of existing || []) {
    const v = row.envVar || row;
    if (v && v.key) merged[v.key] = v.value;
  }

  Object.assign(merged, readDotEnv(), overrides);

  // Unsubscribe links have to resolve for the recipient, so APP_BASE_URL must
  // be the public origin — read it off the service rather than trusting a local
  // .env that almost certainly points at localhost.
  const publicUrl = service && service.serviceDetails && service.serviceDetails.url;
  if (publicUrl) merged.APP_BASE_URL = publicUrl.replace(/\/$/, '');

  for (const key of NEVER_SYNC) delete merged[key];

  const payload = Object.entries(merged).map(([key, value]) => ({ key, value: String(value) }));
  await api('PUT', `/v1/services/${serviceId}/env-vars`, payload);

  console.log(`Synced ${payload.length} variables to ${serviceId}.`);
  console.log('Render redeploys automatically when environment variables change.');
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
