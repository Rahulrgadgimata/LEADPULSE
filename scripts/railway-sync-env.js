/**
 * Push local .env vars to Railway via GraphQL (OAuth session).
 * Usage: node scripts/railway-sync-env.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT = '03792e29-4b41-4e84-9776-d6a241fe9473';
const SERVICE = process.env.RAILWAY_SERVICE_ID || '42af3647-4a73-4e13-8977-8203f5c12fe9';
const ENV = '404518fd-d43a-4157-a69c-a31e95b4e3d2';

const cfg = JSON.parse(
  fs.readFileSync(path.join(process.env.USERPROFILE, '.railway', 'config.json'), 'utf8')
);
const token = cfg.user.accessToken;
if (!token) {
  console.error('Not logged in — run railway login first');
  process.exit(1);
}

function gql(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request(
      {
        hostname: 'backboard.railway.com',
        path: '/graphql/v2',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(data.slice(0, 400)));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const overrides = {
  NODE_ENV: 'production',
  TRUST_PROXY: 'true',
  SQLITE_PATH: '/data/database.sqlite',
  SCRAPLING_ENABLED: 'true',
  SCRAPLING_HOST: '127.0.0.1',
  SCRAPLING_PORT: '3765',
  SCRAPLING_PYTHON: 'python3',
};

const vars = { ...overrides };
const envPath = path.join(__dirname, '../.env');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const i = trimmed.indexOf('=');
  if (i < 1) continue;
  const key = trimmed.slice(0, i).trim();
  const val = trimmed.slice(i + 1).trim();
  if (key && val) vars[key] = val;
}

(async () => {
  const r = await gql(
    `mutation($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }`,
    {
      input: {
        projectId: PROJECT,
        environmentId: ENV,
        serviceId: SERVICE,
        variables: vars,
        skipDeploys: true,
      },
    }
  );
  if (r.errors) {
    console.error(JSON.stringify(r.errors, null, 2));
    process.exit(1);
  }
  console.log(`synced ${Object.keys(vars).length} variables to leadpulse-web`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
