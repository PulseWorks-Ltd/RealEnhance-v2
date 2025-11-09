import { Router, Request, Response } from "express";
import { NODE_ENV, REDIS_URL } from "../config.js";
import { Queue } from "bullmq";
import { JOB_QUEUE_NAME } from "../shared/constants.js";
import { ensureS3Ready } from "../utils/s3.js";

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

  // Redis env visibility (sanitized) to confirm which URL is used in prod
  r.get("/health/redis", async (_req: Request, res: Response) => {
    try {
      const envUsed = process.env.REDIS_PRIVATE_URL ? "REDIS_PRIVATE_URL" : (process.env.REDIS_URL ? "REDIS_URL" : "default");
      let parsed: any = null;
      try {
        const u = new URL(REDIS_URL);
        parsed = {
          protocol: u.protocol.replace(":", ""),
          hostname: u.hostname,
          port: u.port || (u.protocol === "rediss:" ? "6380" : "6379"),
          // never expose username/password
        };
      } catch {
        parsed = { raw: REDIS_URL ? "set" : "unset" };
      }
      res.json({ ok: true, envUsed, redis: parsed });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // S3 health
  r.get("/health/s3", async (_req: Request, res: Response) => {
    try {
      const status = await ensureS3Ready();
      if (!status.ok) {
        const { ok, ...rest } = status as any;
        return res.status(500).json({ ok: false, ...rest });
      }
      const { ok, ...rest } = status as any;
      res.json({ ok: true, ...rest });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });
  return r;
}
