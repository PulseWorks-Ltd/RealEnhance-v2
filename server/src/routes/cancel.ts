import { Router } from "express";
import { Queue } from "bullmq";
import { createClient } from "redis";
import { JOB_QUEUE_NAME } from "../shared/constants.js";
import { REDIS_URL } from "../config.js";
import { deleteBatchState, getJob, listBatchJobIds, listBatchJobIdsForUser, updateJob } from "../services/jobs.js";

const cancelKey = (id: string) => `re:cancel:${id}`;

function isTerminalStatus(status: string | undefined) {
  return status === "complete" || status === "failed" || status === "cancelled";
}

async function markCancellingIfActive(jobId: string) {
  try {
    const existing = await getJob(jobId);
    if (isTerminalStatus(existing?.status)) return;
    await updateJob(jobId as any, {
      status: "cancelled",
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

  const cancelJobIds = async (ids: string[]) => {
    const redis = createClient({ url: REDIS_URL });
    const q = new Queue(JOB_QUEUE_NAME, { connection: { url: REDIS_URL } });
    try {
      await redis.connect();
      for (const id of ids) {
        await redis.set(cancelKey(id), "1", { EX: 60 * 60 });
        await markCancellingIfActive(id);
        console.log("[JOB_CANCELLED]", { jobId: id });
        const job = await q.getJob(id);
        if (job) {
          const st = await job.getState();
          if (st === "waiting" || st === "delayed") await job.remove();
        }
      }
    } finally {
      await Promise.allSettled([redis.quit(), q.close()]);
    }
  };

  r.post("/api/jobs/:id/cancel", async (req, res) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser?.id) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const { id } = req.params;
    const record = await getJob(id);
    if (!record || String(record.userId || "") !== String(sessUser.id)) {
      return res.status(403).json({ error: "forbidden" });
    }

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
    const records = await Promise.all(ids.map((id) => getJob(String(id))));
    const hasForbidden = records.some((record) => !record || String(record.userId || "") !== String(sessUser.id));
    if (hasForbidden) {
      return res.status(403).json({ error: "forbidden" });
    }

    try {
      await cancelJobIds(ids);
      console.log("[BATCH_CANCELLED]", { userId: sessUser.id, count: ids.length, mode: "ids" });
    } catch (err) {
      console.error("[BATCH_CANCELLED] failed", { userId: sessUser.id, count: ids.length, mode: "ids", error: (err as any)?.message || String(err) });
      return res.status(500).json({ error: "cancel_failed" });
    }
    res.json({ ok: true, count: ids.length });
  });

  r.post("/api/batch/cancel", async (req, res) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser?.id) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const batchId = String(req.body?.batchId || "").trim();
    if (!batchId) {
      return res.status(400).json({ error: "missing_batch_id" });
    }

    try {
      const allBatchIds = await listBatchJobIds(batchId);
      const ids = await listBatchJobIdsForUser(batchId, String(sessUser.id));

      // Require full batch ownership to prevent cancelling or clearing another user's batch state.
      if (!allBatchIds.length || ids.length !== allBatchIds.length) {
        return res.status(403).json({ error: "forbidden" });
      }

      if (ids.length) {
        await cancelJobIds(ids);
      }

      await deleteBatchState(batchId);
      console.log("[BATCH_CANCELLED]", { userId: sessUser.id, batchId, count: ids.length, mode: "batchId" });
      console.log("[BATCH_STATE_CLEARED]", { userId: sessUser.id, batchId });
      res.json({ ok: true, batchId, count: ids.length });
    } catch (err) {
      console.error("[BATCH_CANCELLED] failed", { userId: sessUser.id, batchId, mode: "batchId", error: (err as any)?.message || String(err) });
      return res.status(500).json({ error: "cancel_failed" });
    }
  });

  r.post("/api/batch/:batchId/cancel", async (req, res) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser?.id) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const batchId = String(req.params?.batchId || "").trim();
    if (!batchId) {
      return res.status(400).json({ error: "missing_batch_id" });
    }

    try {
      const allBatchIds = await listBatchJobIds(batchId);
      const ids = await listBatchJobIdsForUser(batchId, String(sessUser.id));

      if (!allBatchIds.length || ids.length !== allBatchIds.length) {
        return res.status(403).json({ error: "forbidden" });
      }

      if (ids.length) {
        await cancelJobIds(ids);
      }

      await deleteBatchState(batchId);
      console.log("[BATCH_CANCELLED]", { userId: sessUser.id, batchId, count: ids.length, mode: "batchId_param" });
      console.log("[BATCH_STATE_CLEARED]", { userId: sessUser.id, batchId });
      res.json({ ok: true, batchId, count: ids.length });
    } catch (err) {
      console.error("[BATCH_CANCELLED] failed", { userId: sessUser.id, batchId, mode: "batchId_param", error: (err as any)?.message || String(err) });
      return res.status(500).json({ error: "cancel_failed" });
    }
  });

  return r;
}
