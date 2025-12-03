import { Queue } from 'bullmq';
import sharp from 'sharp';

const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || 'redis://localhost:6379';
const JOB_QUEUE_NAME = 'image-jobs';

(async () => {
  // create a 256x256 white JPEG buffer
  const buf = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .jpeg()
    .toBuffer();
  const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;

  const jobId = 'job_remote_large_' + Date.now();
  const imageId = 'img_remote_large_' + Date.now();
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
    console.log('Enqueued remote large job:', jobId, 'imageId:', imageId);
  } catch (e) {
    console.error('Enqueue failed:', e);
    process.exit(2);
  } finally {
    await q.close();
  }
  process.exit(0);
})();