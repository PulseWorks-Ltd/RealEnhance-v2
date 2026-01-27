
import { Router, Request, Response } from "express";
import { Queue } from "bullmq";
import { JOB_QUEUE_NAME } from "../shared/constants.js";
import { REDIS_URL } from "../config.js";
import { getJob } from "../services/jobs.js";

/**
 * Normalized job item type we send to the client.
 * (Kept inline to avoid import cycles / build issues.)
 */
type UiStatus = "ok" | "warning" | "error";

type StatusItem = {
  id: string;
  state: "queued" | "processing" | "completed" | "failed" | "unknown";
  status: UiStatus; // UI-facing
  queueStatus: "queued" | "active" | "completed" | "failed" | "delayed" | "unknown"; // legacy
  success: boolean;
  imageId: string | null;
  imageUrl: string | null;
  originalUrl: string | null;
  maskUrl: string | null;
  stageUrls: Record<string, string | null> | null; // normalized + legacy keys
  publishedUrl?: string | null;
  warnings?: string[];
  hardFail?: boolean;
  meta: any;
  mode?: string;
  error?: string | null;
};

function normalizeStateToStatus(state: string | null): StatusItem["status"] {
  switch (state) {
    case "waiting":
    case "waiting-children":
    case "delayed":
      return "queued";
    case "active":
      return "active";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

function normalizeQueueState(state: string | null): StatusItem["state"] {
  const s = normalizeStateToStatus(state);
  if (s === "active") return "processing";
  return s as any;
}

export function statusRouter() {
  const r = Router();

  // IMPORTANT: More specific routes MUST come before parameterized routes!
  // /status/batch must be before /status/:jobId or Express will match "batch" as a jobId

  /**
   * Batch status endpoint
   * GET /api/status/batch?ids=job_1,job_2,...
   */
  r.get("/status/batch", async (req: Request, res: Response) => {
    const idsParam = String(req.query.ids || "").trim();
    if (!idsParam) {
      return res.status(400).json({ success: false, error: "missing_ids" });
    }

    const ids = Array.from(
      new Set(
        idsParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      )
    );

    if (!ids.length) {
      return res.status(400).json({ success: false, error: "no_valid_ids" });
    }

    try {
      const queue = new Queue(JOB_QUEUE_NAME, {
        connection: { url: REDIS_URL },
      });

      const items: StatusItem[] = [];
      let completed = 0;

      for (const id of ids) {
        let state: string | null = null;
        let payload: any = null;
        let rv: any = null;
        let failedReason: string | undefined;

        try {
          const job = await queue.getJob(id);
          if (job) {
            state = await job.getState();
            payload = job.data || null;
            rv = job.returnvalue || null;
            failedReason = job.failedReason || undefined;
          } else {
            state = null;
          }
        } catch (e) {
          // If BullMQ lookup fails, fall back to local JSON only
          state = null;
        }

        const queueStatus = normalizeStateToStatus(state);
        const stateNormalized = normalizeQueueState(state);

        // Merge in Redis job record (written by worker via updateJob)
        const local = await getJob(id) || ({} as any);

        // Resolve URLs from BullMQ returnvalue first, then Redis job record
        const resultUrl: string | null =
          (rv && rv.resultUrl) ||
          local.resultUrl ||
          local.imageUrl ||
          null;

        const originalUrl: string | null =
          (rv && rv.originalUrl) || local.originalUrl || null;

        const maskUrl: string | null =
          (rv && rv.maskUrl) || local.maskUrl || null;

        const stageUrlsRaw: Record<string, string> | null =
          (rv && rv.stageUrls) || local.stageUrls || null;

        // Normalize stageUrls into a predictable shape so clients can rely on keys
        const stageUrls: Record<string, string | null> = {
          stage1A: stageUrlsRaw?.['stage1A'] ?? stageUrlsRaw?.['1A'] ?? stageUrlsRaw?.['1'] ?? null,
          stage1B: stageUrlsRaw?.['stage1B'] ?? stageUrlsRaw?.['1B'] ?? stageUrlsRaw?.['1b'] ?? null,
          stage2: stageUrlsRaw?.['stage2'] ?? stageUrlsRaw?.['2'] ?? null,
          // Legacy keys retained for backward compatibility
          '1A': stageUrlsRaw?.['1A'] ?? stageUrlsRaw?.['1'] ?? null,
          '1B': stageUrlsRaw?.['1B'] ?? stageUrlsRaw?.['1b'] ?? null,
          '2': stageUrlsRaw?.['2'] ?? null,
        };

        const imageId: string | null =
          payload?.imageId || local.imageId || null;

        const mode: string | null =
          payload?.mode || local.mode || null;

        const unified = (local?.meta || {})?.unifiedValidation || {};
        const warnings: string[] = Array.isArray(unified?.warnings) ? unified.warnings : [];
        const hardFail = !!unified?.hardFail || !!local?.hardFail;

        const hasOutputs = !!(stageUrls.stage2 || stageUrls.stage1B || stageUrls.stage1A || resultUrl);
        let uiStatus: UiStatus = "ok";

        if (hardFail && !hasOutputs) uiStatus = "error";
        else if (hardFail && hasOutputs) uiStatus = "warning";
        else if (warnings.length) uiStatus = "warning";

        const success =
          stateNormalized === "completed" && typeof resultUrl === "string";

        if (stateNormalized === "completed") completed++;

        // Apply hardFail-driven state remap per contract
        let stateOut = stateNormalized;
        if (hardFail && !hasOutputs) stateOut = "failed";
        if (hardFail && hasOutputs) stateOut = "completed";

        const item: StatusItem = {
          id,
          state: stateOut,
          status: uiStatus,
          queueStatus,
          success,
          imageId,
          imageUrl: resultUrl,
          originalUrl,
          maskUrl,
          publishedUrl: resultUrl,
          warnings,
          hardFail,
          // ensure stageUrls is either an object map or null
          stageUrls: Object.values(stageUrls).some(Boolean) ? (stageUrls as any) : null,
          meta: local.meta ?? {},
          error: uiStatus === "error" ? (local.errorMessage || failedReason || null) : null,
        };
        // Add mode if it exists
        if (mode) {
          item.mode = mode;
        }

        // Edge case: hardFail + outputs → downgrade error into warning text
        if (uiStatus === "warning" && hardFail && hasOutputs) {
          item.warnings = [...(item.warnings || []), local.errorMessage || failedReason || "Output generated but flagged"];
        }

        // Reduce log verbosity: Only log failed jobs or every 10th request
        // Reduce log verbosity: Only log failed jobs or every 50th request
        if (item.status === 'failed' || Math.floor(Math.random() * 50) === 0) {
          console.log('[status/batch] Merged job status for', id, JSON.stringify(item, null, 2));
        }

        // Always log the final response shape for debugging
        // (only once per request, after all items are built)
        // We'll log this just before sending the response below

        items.push(item);
      }

      // Top-level shape:
      //  - items / jobs: full list
      //  - completed, total
      //  - done: true when all jobs are completed or failed (no more processing)
      //  - For convenience / backwards-compat, if there's exactly one job,
      //    also expose jobId/imageUrl/originalUrl/stageUrls at the top level.

      // Check if all jobs are in a terminal state (completed or failed)
      const allDone = items.every((item: StatusItem) =>
        item.status === 'completed' || item.status === 'failed'
      );

      const base: any = {
        success: true,
        items,
        jobs: items,
        completed,
        total: items.length,
        done: allDone,  // Signal to client that polling can stop
      };

      if (items.length === 1) {
              // Debug: log the final response shape for all items
              console.log('[status/batch] response items:',
                items.map(i => ({
                  id: i.id,
                  status: i.status,
                  imageUrl: i.imageUrl,
                  // type: i.type, // Removed: not present on StatusItem
                }))
              );
        const j = items[0];
        base.jobId = j.id;
        base.imageUrl = j.imageUrl;
        base.originalUrl = j.originalUrl;
        base.stageUrls = j.stageUrls;
        base.state = j.state;
        base.status = j.status;
        base.job = j;
      }

      return res.json(base);
    } catch (e: any) {
      console.error("[status/batch] ERROR:", e);
      return res
        .status(500)
        .json({ success: false, error: e?.message || "status_batch_failed" });
    }
  });

  /**
   * Optional single-job helper:
   * GET /api/status/:jobId
   * (wraps the batch endpoint so it always returns the normalized shape above)
   */
  r.get("/status/:jobId", async (req: Request, res: Response) => {
    const jobId = req.params.jobId;
    if (!jobId) {
      return res.status(400).json({ success: false, error: "missing_jobId" });
    }
    // Manually invoke the batch handler logic for a single job
    try {
      const queue = new Queue(JOB_QUEUE_NAME, {
        connection: { url: REDIS_URL },
      });
      let state: string | null = null;
      let payload: any = null;
      let rv: any = null;
      let failedReason: string | undefined;
      let job;
      try {
        job = await queue.getJob(jobId);
        if (job) {
          state = await job.getState();
          payload = job.data || null;
          rv = job.returnvalue || null;
          failedReason = job.failedReason || undefined;
        } else {
          state = null;
        }
      } catch (e) {
        state = null;
      }
      const queueStatus = normalizeStateToStatus(state);
      const stateNormalized = normalizeQueueState(state);
      const local = await getJob(jobId) || ({} as any);
      const resultUrl: string | null =
        (rv && rv.resultUrl) ||
        local.resultUrl ||
        local.imageUrl ||
        null;
      const originalUrl: string | null =
        (rv && rv.originalUrl) || local.originalUrl || null;
      const maskUrl: string | null =
        (rv && rv.maskUrl) || local.maskUrl || null;
      const stageUrlsRaw: Record<string, string> | null =
        (rv && rv.stageUrls) || local.stageUrls || null;

      const stageUrls: Record<string, string | null> = {
        stage1A: stageUrlsRaw?.['stage1A'] ?? stageUrlsRaw?.['1A'] ?? stageUrlsRaw?.['1'] ?? null,
        stage1B: stageUrlsRaw?.['stage1B'] ?? stageUrlsRaw?.['1B'] ?? stageUrlsRaw?.['1b'] ?? null,
        stage2: stageUrlsRaw?.['stage2'] ?? stageUrlsRaw?.['2'] ?? null,
        '1A': stageUrlsRaw?.['1A'] ?? stageUrlsRaw?.['1'] ?? null,
        '1B': stageUrlsRaw?.['1B'] ?? stageUrlsRaw?.['1b'] ?? null,
        '2': stageUrlsRaw?.['2'] ?? null,
      };
      const imageId: string | null =
        payload?.imageId || local.imageId || null;
      const unified = (local?.meta || {})?.unifiedValidation || {};
      const warnings: string[] = Array.isArray(unified?.warnings) ? unified.warnings : [];
      const hardFail = !!unified?.hardFail || !!local?.hardFail;
      const hasOutputs = !!(stageUrls.stage2 || stageUrls.stage1B || stageUrls.stage1A || resultUrl);

      let uiStatus: UiStatus = "ok";
      if (hardFail && !hasOutputs) uiStatus = "error";
      else if (hardFail && hasOutputs) uiStatus = "warning";
      else if (warnings.length) uiStatus = "warning";

      let stateOut = normalizeQueueState(state);
      if (hardFail && !hasOutputs) stateOut = "failed";
      if (hardFail && hasOutputs) stateOut = "completed";

      const success =
        stateOut === "completed" && typeof resultUrl === "string";
      const item: StatusItem = {
        id: jobId,
        state: stateOut,
        status: uiStatus,
        queueStatus,
        success,
        imageId,
        imageUrl: resultUrl,
        originalUrl,
        maskUrl,
        publishedUrl: resultUrl,
        warnings,
        hardFail,
        stageUrls: Object.values(stageUrls).some(Boolean) ? (stageUrls as any) : null,
        meta: local.meta ?? {},
        error: uiStatus === "error" ? (local.errorMessage || failedReason || null) : null,
      };
      if (uiStatus === "warning" && hardFail && hasOutputs) {
        item.warnings = [...(item.warnings || []), local.errorMessage || failedReason || "Output generated but flagged"];
      }
      const base: any = {
        success: true,
        items: [item],
        jobs: [item],
        completed: success ? 1 : 0,
        total: 1,
        jobId: item.id,
        imageUrl: item.imageUrl,
        originalUrl: item.originalUrl,
        stageUrls: item.stageUrls,
        state: item.state,
        status: item.status,
        job: item,
      };
      return res.json(base);
    } catch (e: any) {
      console.error("[status/:jobId] ERROR:", e);
      return res.status(500).json({ success: false, error: e?.message || "status_single_failed" });
    }
  });

  return r;
}

/**
 * Debug-only helper route to inspect BullMQ job return values (sanitized).
 * Keep this behind authentication in production.
 */
export function debugStatusRouter() {
  const r = Router();

  r.get("/debug/job/:jobId", async (req: Request, res: Response) => {
    const isDev = process.env.NODE_ENV === "development";
    const sessUser = isDev ? { id: "user_test" } : (req.session as any)?.user;
    if (!sessUser)
      return res.status(401).json({ error: "not_authenticated" });

    try {
      const q = new Queue(JOB_QUEUE_NAME, { connection: { url: REDIS_URL } });
      const job = await q.getJob(req.params.jobId);

      if (!job) return res.status(404).json({ error: "job_not_found" });

      const st = await job.getState();
      const data = job.data || {};
      const rv = (job.returnvalue || {}) as any;

      return res.json({
        id: job.id,
        state: st,
        payload: { imageId: data.imageId, type: data.type },
        returnvalue: rv
          ? {
              resultUrl: rv.resultUrl,
              originalUrl: rv.originalUrl,
              stageUrls: rv.stageUrls,
              finalPath: rv.finalPath ? true : false,
            }
          : null,
      });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  return r;
}
