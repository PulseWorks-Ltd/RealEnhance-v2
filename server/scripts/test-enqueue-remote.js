import { Queue } from 'bullmq';

const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || 'redis://localhost:6379';
const JOB_QUEUE_NAME = 'image-jobs';

(async () => {
  // tiny 1x1 PNG base64 (same as other test helper)
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAn0B9cQz5QAAAABJRU5ErkJggg==';
  const dataUrl = `data:image/png;base64,${pngBase64}`;

  const jobId = 'job_remote_' + Date.now();
  const imageId = 'img_remote_' + Date.now();
  const userId = 'user_test';

  const payload = {
    jobId,
    userId,
    imageId,
    type: 'enhance',
    remoteOriginalUrl: dataUrl,
    options: { declutter: false, virtualStage: false, roomType: 'living_room', sceneType: 'interior' },
    createdAt: new Date().toISOString(),
  };

  const q = new Queue(JOB_QUEUE_NAME, { connection: { url: REDIS_URL } });
  try {
    const added = await q.add(JOB_QUEUE_NAME, payload, { jobId });
    console.log('Enqueued remote job:', jobId, 'imageId:', imageId);
  } catch (e) {
    console.error('Enqueue failed:', e);
    process.exit(2);
  } finally {
    await q.close();
  }
  process.exit(0);
})();