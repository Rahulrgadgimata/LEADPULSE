const fs = require('fs');
const path = require('path');
const https = require('https');

const cfg = JSON.parse(
  fs.readFileSync(path.join(process.env.USERPROFILE, '.railway', 'config.json'), 'utf8')
);
const token = cfg.user.accessToken;
if (!token) {
  console.error('No access token');
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
            reject(new Error(data.slice(0, 500)));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const action = process.argv[2] || 'status';
  const serviceId = process.env.RAILWAY_SERVICE_ID || '42af3647-4a73-4e13-8977-8203f5c12fe9';
  const envId = '404518fd-d43a-4157-a69c-a31e95b4e3d2';
  const projectId = '03792e29-4b41-4e84-9776-d6a241fe9473';

  if (action === 'me') {
    console.log(JSON.stringify(await gql(`query { me { email name } }`), null, 2));
    return;
  }

  if (action === 'status') {
    const r = await gql(
      `query($id: String!) {
        project(id: $id) {
          id name
          services { edges { node { id name } } }
          environments { edges { node { id name } } }
        }
      }`,
      { id: projectId }
    );
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (action === 'create-service') {
    const r = await gql(
      `mutation($input: ServiceCreateInput!) {
        serviceCreate(input: $input) {
          id
          name
        }
      }`,
      {
        input: {
          projectId,
          name: 'leadpulse-web',
          source: {
            repo: 'Rahulrgadgimata/LEADPULSE',
          },
        },
      }
    );
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (action === 'connect') {
    // Connect GitHub repo to service
    const r = await gql(
      `mutation($id: String!, $input: ServiceConnectInput!) {
        serviceConnect(id: $id, input: $input) {
          id
          name
        }
      }`,
      {
        id: serviceId,
        input: { repo: 'Rahulrgadgimata/LEADPULSE', branch: 'main' },
      }
    );
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (action === 'volume') {
    const r = await gql(
      `mutation($input: VolumeCreateInput!) {
        volumeCreate(input: $input) {
          id
          name
        }
      }`,
      {
        input: {
          projectId,
          environmentId: envId,
          serviceId,
          mountPath: '/data',
        },
      }
    );
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (action === 'domain') {
    const r = await gql(
      `mutation($input: ServiceDomainCreateInput!) {
        serviceDomainCreate(input: $input) {
          id
          domain
        }
      }`,
      {
        input: {
          serviceId,
          environmentId: envId,
        },
      }
    );
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (action === 'deploy') {
    // Trigger redeploy / deployment from latest source
    const r = await gql(
      `mutation($input: DeploymentTriggerInput!) {
        deploymentTrigger(input: $input)
      }`,
      {
        input: {
          serviceId,
          environmentId: envId,
          commitSha: null,
        },
      }
    );
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (action === 'config') {
    const r = await gql(
      `mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
        serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
      }`,
      {
        serviceId,
        environmentId: envId,
        input: {
          dockerfilePath: 'Dockerfile',
          healthcheckPath: '/api',
          restartPolicyType: 'ON_FAILURE',
          restartPolicyMaxRetries: 5,
        },
      }
    );
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (action === 'logs') {
    const deps = await gql(
      `query($projectId: String!, $serviceId: String!, $envId: String!) {
        deployments(
          first: 1
          input: { projectId: $projectId, serviceId: $serviceId, environmentId: $envId }
        ) {
          edges { node { id status } }
        }
      }`,
      { projectId, serviceId, envId }
    );
    const depId = deps.data?.deployments?.edges?.[0]?.node?.id;
    console.log(JSON.stringify(deps, null, 2));
    if (!depId) return;
    const logs = await gql(
      `query($deploymentId: String!) {
        buildLogs(deploymentId: $deploymentId, limit: 80) {
          message
          severity
          timestamp
        }
      }`,
      { deploymentId: depId }
    );
    console.log(JSON.stringify(logs, null, 2));
    return;
  }

  if (action === 'deployments') {
    const r = await gql(
      `query($projectId: String!, $serviceId: String!, $envId: String!) {
        deployments(
          first: 5
          input: { projectId: $projectId, serviceId: $serviceId, environmentId: $envId }
        ) {
          edges {
            node {
              id status createdAt staticUrl url
            }
          }
        }
      }`,
      { projectId, serviceId, envId }
    );
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  console.error('Unknown action', action);
  process.exit(1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
