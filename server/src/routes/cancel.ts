import { Router } from "express";
import { Queue } from "bullmq";
import { createClient } from "redis";
import { JOB_QUEUE_NAME } from "../shared/constants.js";
import { REDIS_URL } from "../config.js";

const cancelKey = (id: string) => `re:cancel:${id}`;

export function cancelRouter() {
  const r = Router();

  r.post("/api/jobs/:id/cancel", async (req, res) => {
    const { id } = req.params;
    const redis = createClient({ url: REDIS_URL });
    await redis.connect();
    await redis.set(cancelKey(id), "1", { EX: 60 * 60 });
    const q = new Queue(JOB_QUEUE_NAME, { connection: { url: REDIS_URL } });
    const job = await q.getJob(id);
    if (job) {
      const st = await job.getState();
      if (st === "waiting" || st === "delayed") await job.remove();
    }
    await redis.quit();
    res.json({ ok: true });
  });

  r.post("/api/jobs/cancel-batch", async (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const redis = createClient({ url: REDIS_URL });
    await redis.connect();
    const q = new Queue(JOB_QUEUE_NAME, { connection: { url: REDIS_URL } });
    for (const id of ids) {
      await redis.set(cancelKey(id), "1", { EX: 60 * 60 });
      const job = await q.getJob(id);
      if (job) {
        const st = await job.getState();
        if (st === "waiting" || st === "delayed") await job.remove();
      }
    }
    await redis.quit();
    res.json({ ok: true, count: ids.length });
  });

  return r;
}
