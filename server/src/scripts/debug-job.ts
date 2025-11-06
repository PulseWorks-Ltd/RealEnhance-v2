import { Queue } from "bullmq";
import { REDIS_URL } from "../config.js";
import { JOB_QUEUE_NAME } from "../shared/constants.js";

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("Usage: tsx src/scripts/debug-job.ts <jobId>");
    process.exit(1);
  }
  const q = new Queue(JOB_QUEUE_NAME, { connection: { url: REDIS_URL } });
  try {
    let job = await q.getJob(id);
    if (!job) {
      const recent = await q.getJobs(["active", "waiting", "completed", "failed", "delayed"], 0, 200, true);
      job = recent.find(j => (j?.data as any)?.jobId === id) as any;
    }
    if (!job) {
      console.error("not_found");
      process.exit(2);
    }
    const rv: any = (job as any).returnvalue;
    const st = await job.getState();
    const data: any = job.data || {};
    const out = {
      id: job.id,
      state: st,
      payload: { imageId: data.imageId, type: data.type },
      returnvalue: rv ? {
        resultUrl: rv.resultUrl,
        originalUrl: rv.originalUrl,
        stageUrls: rv.stageUrls,
        finalPath: !!rv.finalPath,
      } : null
    };
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await q.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
