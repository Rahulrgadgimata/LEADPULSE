const https = require('https');

const token = process.env.RAILWAY_TOKEN;
if (!token) {
  console.error('RAILWAY_TOKEN required');
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

(async () => {
  const projectId = '03792e29-4b41-4e84-9776-d6a241fe9473';
  const serviceId = '42af3647-4a73-4e13-8977-8203f5c12fe9';
  const envId = '404518fd-d43a-4157-a69c-a31e95b4e3d2';
  const action = process.argv[2] || 'deps';

  if (action === 'deps') {
    console.log(
      JSON.stringify(
        await gql(
          `query($projectId: String!, $serviceId: String!, $envId: String!) {
            deployments(first: 3, input: { projectId: $projectId, serviceId: $serviceId, environmentId: $envId }) {
              edges { node { id status createdAt staticUrl } }
            }
          }`,
          { projectId, serviceId, envId }
        ),
        null,
        2
      )
    );
  }

  if (action === 'redeploy') {
    const deps = await gql(
      `query($projectId: String!, $serviceId: String!, $envId: String!) {
        deployments(first: 1, input: { projectId: $projectId, serviceId: $serviceId, environmentId: $envId }) {
          edges { node { id status } }
        }
      }`,
      { projectId, serviceId, envId }
    );
    const depId = deps.data?.deployments?.edges?.[0]?.node?.id;
    console.log('latest', JSON.stringify(deps));
    if (!depId) process.exit(1);
    console.log(
      JSON.stringify(
        await gql(
          `mutation($id: String!) { deploymentRedeploy(id: $id) { id status } }`,
          { id: depId }
        ),
        null,
        2
      )
    );
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
