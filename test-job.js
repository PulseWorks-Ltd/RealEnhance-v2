const { createClient } = require('redis');
async function run() {
  const client = createClient({ url: 'redis://default:GWlDMYvWAFGbVvdCWPnpyvrDhNWmjhcy@redis.railway.internal:6379' });
  await client.connect();
  const res = await client.hGet('bull:enhanceQueue:job_566ef46e-4809-4f52-9b97-fe490d10da48', 'data');
  console.log(res);
  await client.disconnect();
}
run();
