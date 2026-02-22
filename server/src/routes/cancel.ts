import { Router } from "express";
import { Queue } from "bullmq";
import { createClient } from "redis";
import { JOB_QUEUE_NAME } from "../shared/constants.js";
import { REDIS_URL } from "../config.js";
import { getJob, updateJob } from "../services/jobs.js";

const cancelKey = (id: string) => `re:cancel:${id}`;

function isTerminalStatus(status: string | undefined) {
  return status === "complete" || status === "failed" || status === "cancelled";
}

async function markCancellingIfActive(jobId: string) {
  try {
    const existing = await getJob(jobId);
    if (isTerminalStatus(existing?.status)) return;
    await updateJob(jobId as any, {
      errorMessage: "cancel_requested",
      cancelRequested: true,
      cancelledAt: new Date().toISOString(),
    });
  } catch {
    // Best-effort only
  }
}

export function cancelRouter() {
  const r = Router();

  r.post("/api/jobs/:id/cancel", async (req, res) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser?.id) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const { id } = req.params;
    const redis = createClient({ url: REDIS_URL });
    const q = new Queue(JOB_QUEUE_NAME, { connection: { url: REDIS_URL } });
    try {
      await redis.connect();
      await redis.set(cancelKey(id), "1", { EX: 60 * 60 });
      await markCancellingIfActive(id);
      const job = await q.getJob(id);
      if (job) {
        const st = await job.getState();
        if (st === "waiting" || st === "delayed") await job.remove();
      }
    } finally {
      await Promise.allSettled([redis.quit(), q.close()]);
    }
    res.json({ ok: true });
  });

  r.post("/api/jobs/cancel-batch", async (req, res) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser?.id) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const redis = createClient({ url: REDIS_URL });
    const q = new Queue(JOB_QUEUE_NAME, { connection: { url: REDIS_URL } });
    try {
      await redis.connect();
      for (const id of ids) {
        await redis.set(cancelKey(id), "1", { EX: 60 * 60 });
        await markCancellingIfActive(id);
        const job = await q.getJob(id);
        if (job) {
          const st = await job.getState();
          if (st === "waiting" || st === "delayed") await job.remove();
        }
      }
    } finally {
      await Promise.allSettled([redis.quit(), q.close()]);
    }
    res.json({ ok: true, count: ids.length });
  });

  return r;
}
