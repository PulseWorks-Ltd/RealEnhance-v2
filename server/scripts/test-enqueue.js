import fs from 'fs';
import path from 'path';
import { Queue } from 'bullmq';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

(async () => {
  const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || 'redis://localhost:6379';
  const DATA_DIR = path.resolve(__dirname, '..', 'data');
  const UPLOADS_DIR = path.join(DATA_DIR, 'uploads', 'user_test');
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  // create a tiny 1x1 PNG
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAn0B9cQz5QAAAABJRU5ErkJggg==';
  const imgPath = path.join(UPLOADS_DIR, 'sample.png');
  fs.writeFileSync(imgPath, Buffer.from(pngBase64, 'base64'));

  const imagesFile = path.join(DATA_DIR, 'images.json');
  const jobsFile = path.join(DATA_DIR, 'jobs.json');
  const now = new Date().toISOString();
  const imageId = 'img_test_' + Date.now();
  const jobId = 'job_test_' + Date.now();
  const userId = 'user_test';

  // write images.json
  let images = {};
  try { images = JSON.parse(fs.readFileSync(imagesFile, 'utf8')); } catch (e) { images = {}; }
  images[imageId] = {
    id: imageId,
    userId,
    originalPath: imgPath,
    history: [],
    currentVersionId: null,
    meta: {},
    createdAt: now,
    updatedAt: now
  };
  fs.writeFileSync(imagesFile, JSON.stringify(images, null, 2));

  // write jobs.json
  let jobs = {};
  try { jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8')); } catch (e) { jobs = {}; }
  jobs[jobId] = {
    id: jobId,
    jobId,
    userId,
    imageId,
    status: 'enqueued',
    createdAt: now,
    updatedAt: now
  };
  fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));

  console.log('Wrote image and job records:');
  console.log(' - imageId:', imageId);
  console.log(' - jobId:', jobId);
  console.log('Original path:', imgPath);

  // enqueue to BullMQ
  const JOB_QUEUE_NAME = 'image-jobs';
  const q = new Queue(JOB_QUEUE_NAME, { connection: { url: REDIS_URL } });
  try {
    const added = await q.add(jobId, {
      type: 'enhance',
      imageId,
      jobId,
      userId,
      fileName: 'sample.png',
      profile: undefined,
      options: { declutter: true, virtualStage: false, roomType: 'living_room', sceneType: 'interior' }
    }, { jobId });
    console.log('Enqueued job to Redis:', added.id || added.jobId || jobId);
  } catch (e) {
    console.error('Failed to enqueue job (is Redis running?):', e.message || e);
    process.exit(2);
  } finally {
    await q.close();
  }
  process.exit(0);
})();