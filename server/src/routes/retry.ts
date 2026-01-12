import { Router, Request, Response } from "express";
import * as crypto from "node:crypto";
import { getJobMetadata, saveJobMetadata } from "@realenhance/shared/imageStore";
import { JOB_QUEUE_NAME } from "../shared/constants.js";
import { Queue } from "bullmq";
import { incrementRetry } from "../services/usageLedger.js";
const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || "redis://localhost:6379";

export function retryRouter() {
  const r = Router();

  r.post("/retry", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "not_authenticated" });

    const { jobId } = (req.body || {}) as { jobId?: string };
    if (!jobId) return res.status(400).json({ error: "missing_jobId" });

    const meta = await getJobMetadata(jobId);
    if (!meta) return res.status(404).json({ error: "job_metadata_not_found" });
    if (meta.userId !== sessUser.id) return res.status(403).json({ error: "forbidden" });

    const retryCheck = await incrementRetry(jobId);
    if (retryCheck.locked) {
      return res.status(429).json({ error: "retry_limit_reached", retryCount: retryCheck.retryCount });
    }

    // Clone with new jobId
    const newJobId = "job_" + crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const cloned: any = { ...meta, jobId: newJobId, createdAt: nowIso, retryOf: jobId };

    await saveJobMetadata(cloned);
    await new Queue(JOB_QUEUE_NAME, { connection: { url: REDIS_URL } }).add(JOB_QUEUE_NAME, cloned, { jobId: newJobId });

    return res.json({ newJobId, status: "retry_accepted" });
  });

  return r;
}
