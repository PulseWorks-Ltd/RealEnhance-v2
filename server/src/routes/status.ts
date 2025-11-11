import { Router, Request, Response } from "express";
import { getJob } from "../services/jobs.js";
import { Queue } from "bullmq";
import { JOB_QUEUE_NAME } from "../shared/constants.js";
import { REDIS_URL } from "../config.js";
import { getImageRecord } from "../services/images.js";
import path from "path";

export function statusRouter() {
  const r = Router();

  // IMPORTANT: More specific routes MUST come before parameterized routes!
  // /status/batch must be before /status/:jobId or Express will match "batch" as a jobId
  
  // Batch status endpoint: /api/status/batch?ids=a,b,c
  r.get("/status/batch", async (req: Request, res: Response) => {
    // In development, allow unauthenticated access for testing
    const isDev = process.env.NODE_ENV === 'development';
    const sessUser = isDev ? { id: 'user_test' } : (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "not_authenticated" });

    const idsParam = String(req.query.ids || "").trim();
    if (!idsParam) return res.json({ items: [], done: true, count: 0 });
    const ids = idsParam.split(",").map(s => s.trim()).filter(Boolean);
    
    if (ids.length === 0) {
      return res.json({ items: [], done: true, count: 0 });
    }

    const q = new Queue(JOB_QUEUE_NAME, { connection: { url: REDIS_URL } });
    const items: any[] = [];
    let completed = 0;

    try {
      for (const id of ids) {
        let job;
        try {
          job = await q.getJob(id);
        } catch (e) {
          items.push({ id, status: 'failed', error: 'job_error' });
          continue;
        }
        if (!job) {
          items.push({ id, status: 'failed', error: 'not_found' });
          continue;
        }
        
        const state = await job.getState();
        let status: 'queued'|'processing'|'completed'|'failed' = 'queued';
        if (state === 'completed') status = 'completed';
        else if (state === 'failed') status = 'failed';
        else if (state === 'active') status = 'processing';

        const payload: any = job.data || {};
        
        // Extract URLs from worker's return value
        const rv: any = (job as any).returnvalue || {};
        
        // CRITICAL DEBUG: Log what BullMQ actually has
        console.log(`[status/batch] Job ${id} state=${status} returnvalue:`, {
          exists: !!rv,
          type: typeof rv,
          keys: rv ? Object.keys(rv) : [],
          resultUrl: rv?.resultUrl ? String(rv.resultUrl).substring(0, 80) + '...' : 'MISSING',
          full: JSON.stringify(rv).substring(0, 300)
        });
        
        const resultUrl = rv.resultUrl || null;
        const originalUrl = rv.originalUrl || null;
        const stageUrls = rv.stageUrls || {};
        
        // Build resultImages array
        const resultImages: string[] = [];
        if (Array.isArray(rv.stageUrls)) {
          for (const u of rv.stageUrls) if (u) resultImages.push(u);
        } else if (rv && typeof rv.stageUrls === 'object') {
          const preferOrder = ['1A','1B','2'];
          for (const k of preferOrder) {
            if (rv.stageUrls[k]) resultImages.push(rv.stageUrls[k]);
          }
        }
        if (resultUrl && !resultImages.includes(resultUrl)) resultImages.push(resultUrl);
        
        // Debug logging if URLs are missing
        if (status === 'completed' && !resultUrl) {
          console.warn(`[status/batch] ⚠️ Job ${id} completed but no resultUrl:`, {
            hasReturnvalue: !!rv,
            returnvalueKeys: Object.keys(rv),
            sample: JSON.stringify(rv).substring(0, 200)
          });
        }
        
        if (status === 'completed') completed++;
        
        // Push clean, predictable shape
        items.push({
          id,
          status,
          imageId: payload.imageId,
          // Multiple formats for compatibility
          imageUrl: resultUrl,
          resultUrl: resultUrl,
          originalImageUrl: originalUrl,
          resultImages,
          stageUrls,
          filename: job.name || undefined
        });
      }

      const done = completed === ids.length || items.every(i => i.status === 'failed');
      res.json({ items, count: ids.length, done });
    } finally {
      await q.close();
    }
  });

  // Single job status: /api/status/:jobId
  // NOTE: This MUST come after /status/batch to avoid matching "batch" as a jobId!
  r.get("/status/:jobId", async (req: Request, res: Response) => {
    // In development, allow unauthenticated access for testing
    const isDev = process.env.NODE_ENV === 'development';
    const sessUser = isDev ? { id: 'user_test' } : (req.session as any)?.user;
    if (!sessUser) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    // Read job state from BullMQ (authoritative source across containers)
    try {
      const q = new Queue(JOB_QUEUE_NAME, { connection: { url: REDIS_URL } });
      const job = await q.getJob(req.params.jobId);
      
      if (!job) {
        await q.close();
        // Fallback to local JSON store
        const legacy = getJob(req.params.jobId);
        if (!legacy) return res.status(404).json({ error: 'not_found' });
        if (legacy.userId !== sessUser.id) return res.status(403).json({ error: 'forbidden' });
        return res.json(legacy);
      }

      const state = await job.getState();
      let status: 'queued'|'processing'|'completed'|'failed' = 'queued';
      if (state === 'completed') status = 'completed';
      else if (state === 'failed') status = 'failed';
      else if (state === 'active') status = 'processing';

      const payload: any = job.data || {};
      if (payload.userId && payload.userId !== sessUser.id) {
        await q.close();
        return res.status(403).json({ error: 'forbidden' });
      }

      // Read worker's return value from BullMQ
      const rv: any = (job as any).returnvalue || {};
      
      // CRITICAL DEBUG: Log what BullMQ actually has
      console.log(`[status] Job ${job.id} state=${status}:`, {
        hasReturnvalue: !!rv,
        type: typeof rv,
        keys: rv ? Object.keys(rv) : [],
        resultUrl: rv?.resultUrl ? String(rv.resultUrl).substring(0, 100) + '...' : 'MISSING',
        originalUrl: rv?.originalUrl ? String(rv.originalUrl).substring(0, 100) + '...' : 'MISSING',
        stageUrlsKeys: rv.stageUrls ? Object.keys(rv.stageUrls) : [],
        full: JSON.stringify(rv).substring(0, 400)
      });
      
      // Worker returns: { resultUrl, originalUrl, stageUrls: { "1A": "...", "2": "..." }, imageId, jobId }
      const resultUrl = rv.resultUrl || null;
      const originalUrl = rv.originalUrl || null;
      const stageUrls = rv.stageUrls || {};
      
      // Build resultImages array for client (expects array of URLs)
      const resultImages: string[] = [];
      // If worker provided explicit stageUrls as an array, use it
      if (Array.isArray(rv.stageUrls)) {
        for (const u of rv.stageUrls) if (u) resultImages.push(u);
      } else if (rv && typeof rv.stageUrls === 'object') {
        // stageUrls may be an object like { "1A": url, "1B": url, "2": url }
        const preferOrder = ['1A','1B','2'];
        for (const k of preferOrder) {
          if (rv.stageUrls[k]) resultImages.push(rv.stageUrls[k]);
        }
      }
      // Ensure final resultUrl is present as a fallback / canonical entry
      if (resultUrl && !resultImages.includes(resultUrl)) resultImages.push(resultUrl);
      
      // Debug logging if completed job has no URLs
      if (status === 'completed' && !resultUrl) {
        console.warn(`[status] ⚠️ Job ${job.id} completed but returnvalue.resultUrl is missing`, {
          hasReturnvalue: !!rv,
          keys: Object.keys(rv),
          sample: JSON.stringify(rv).substring(0, 300)
        });
      }

      await q.close();
      
      // Return URLs in multiple fields for client compatibility
      return res.json({
        id: job.id,
        jobId: job.id,
        userId: payload.userId,
        imageId: payload.imageId,
        status,
        imageUrl: resultUrl,           // client checks this
        resultUrl: resultUrl,           // client checks this
        originalImageUrl: originalUrl,
        resultImages,                   // array format: [url]
        stageUrls,                      // { "1A": "...", "2": "..." }
        updatedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : undefined
      });
    } catch (e) {
      console.error('[status] Error reading job from BullMQ:', e);
      // Fallback to local JSON store
    }

    // Legacy/local fallback: JSON store (may not be updated in multi-service deployments)
    const legacy = getJob(req.params.jobId);
    if (!legacy) return res.status(404).json({ error: 'not_found' });
    if (legacy.userId !== sessUser.id) return res.status(403).json({ error: 'forbidden' });
    return res.json(legacy);
  });

  return r;
}

// Debug-only helper route to inspect BullMQ job return values (sanitized)
// Note: Keep this behind authentication; do not expose secrets.
export function debugStatusRouter() {
  const r = Router();
  r.get("/debug/job/:jobId", async (req: Request, res: Response) => {
    // In development, allow unauthenticated access for testing
    const isDev = process.env.NODE_ENV === 'development';
    const sessUser = isDev ? { id: 'user_test' } : (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "not_authenticated" });
    try {
      const q = new Queue(JOB_QUEUE_NAME, { connection: { url: REDIS_URL } });
      let job = await q.getJob(req.params.jobId);
      // Fallback: search recent jobs by data.jobId in case IDs diverged
      if (!job) {
        try {
          const recent = await q.getJobs(["active", "waiting", "completed", "failed", "delayed"], 0, 200, true);
          job = recent.find(j => (j?.data as any)?.jobId === req.params.jobId) as any;
        } catch {}
      }
      if (!job) {
        await q.close();
        return res.status(404).json({ error: "not_found" });
      }
      const st = await job.getState();
      const data: any = job.data || {};
      if (data.userId && data.userId !== sessUser.id) {
        await q.close();
        return res.status(403).json({ error: "forbidden" });
      }
      const rv: any = (job as any).returnvalue;
      await q.close();
      return res.json({
        id: job.id,
        state: st,
        payload: { imageId: data.imageId, type: data.type },
        returnvalue: rv ? {
          resultUrl: rv.resultUrl,
          originalUrl: rv.originalUrl,
          stageUrls: rv.stageUrls,
          finalPath: rv.finalPath ? true : false,
        } : null
      });
    } catch (e:any) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });
  return r;
}
