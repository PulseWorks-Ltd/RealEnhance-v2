import { Router, Request, Response } from "express";
import { getJob } from "../services/jobs.js";
import { Queue } from "bullmq";
import { JOB_QUEUE_NAME } from "../shared/constants.js";
import { REDIS_URL } from "../config.js";
import { getImageRecord } from "../services/images.js";
import path from "path";

export function statusRouter() {
  const r = Router();

  r.get("/status/:jobId", (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "not_found" });

    if (job.userId !== sessUser.id) {
      return res.status(403).json({ error: "forbidden" });
    }

    res.json(job);
  });

  // Batch status: /api/status/batch?ids=a,b,c
  r.get("/status/batch", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "not_authenticated" });

    const idsParam = String(req.query.ids || "").trim();
    if (!idsParam) return res.json({ items: [], done: true, count: 0 });
    const ids = idsParam.split(",").map(s => s.trim()).filter(Boolean);

    const q = new Queue(JOB_QUEUE_NAME, { connection: { url: REDIS_URL } });
    const items: any[] = [];
    let completed = 0;

    for (const id of ids) {
      const job = await q.getJob(id);
      if (!job) {
        items.push({ id, status: 'failed', error: 'not_found' });
        continue;
      }
      const st = await job.getState();
      let status: 'queued'|'processing'|'completed'|'failed' = 'queued';
      if (st === 'completed') status = 'completed';
      else if (st === 'failed') status = 'failed';
      else if (st === 'active') status = 'processing';
      else status = 'queued';

      const payload: any = job.data || {};
      const imgId = payload.imageId;
      let imageUrl: string | undefined;
      let originalImageUrl: string | undefined;
      // Prefer explicit return value from worker (BullMQ exposes `.returnvalue` on completed jobs)
      const rv: any = (job as any).returnvalue;
      if (rv && rv.resultUrl) {
        imageUrl = rv.resultUrl;
      }
      if (rv && rv.originalUrl) {
        originalImageUrl = rv.originalUrl;
      }
      if (!imageUrl && rv && rv.finalPath) {
        const rel = String(rv.finalPath).split(path.join(process.cwd(), 'server') + path.sep)[1];
        if (rel) imageUrl = `/files/${rel.replace(/\\/g,'/')}`;
      }
      if (status === 'completed' && imgId) {
        // Try to construct a URL for the latest version if present in server-side data store
        const rec = getImageRecord(imgId as any);
        if (rec && !imageUrl) {
          const latest = rec.history.find(v => v.versionId === rec.currentVersionId) || rec.history[rec.history.length-1];
          if (latest?.filePath) {
            // map absolute path to /files route
            const rel = latest.filePath.split(path.join(process.cwd(), 'server') + path.sep)[1];
            if (rel) imageUrl = `/files/${rel.replace(/\\/g,'/')}`;
          }
        }
      }
      if (status === 'completed') completed++;
  items.push({ id, status, imageId: imgId, imageUrl, originalImageUrl, filename: job.name || undefined });
    }

    const done = completed === ids.length || items.every(i => i.status === 'failed');
    res.json({ items, count: ids.length, done });
  });

  return r;
}
