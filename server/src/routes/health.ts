import { Router, Request, Response } from "express";
import { NODE_ENV, REDIS_URL } from "../config.js";
import { Queue } from "bullmq";
import { JOB_QUEUE_NAME } from "../shared/constants.js";

export function healthRouter() {
  const r = Router();
  r.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      env: NODE_ENV,
      time: new Date().toISOString()
    });
  });

  // Optional: queue/worker health
  r.get("/health/queue", async (_req: Request, res: Response) => {
    try {
      const q = new Queue(JOB_QUEUE_NAME, { connection: { url: REDIS_URL } });
      const counts = await q.getJobCounts();
      await q.close();
      res.json({ ok: true, redis: !!REDIS_URL, counts });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });
  return r;
}
