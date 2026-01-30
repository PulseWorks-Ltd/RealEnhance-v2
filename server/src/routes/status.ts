
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
type QueueStatus = "queued" | "active" | "completed" | "failed" | "delayed" | "unknown";
type NormalizedState = "queued" | "processing" | "completed" | "failed" | "unknown";

type StatusItem = {
  id: string;
  state: NormalizedState;               // canonical pipeline status
  status: NormalizedState;              // alias for backward compatibility
  uiStatus: UiStatus;                   // UI severity (ok/warning/error)
  queueStatus: QueueStatus;             // raw BullMQ state (legacy)
  success: boolean;
  imageId: string | null;
  imageUrl: string | null;
  originalUrl: string | null;
  maskUrl: string | null;
  stageUrls: Record<string, string | null> | null; // normalized + legacy keys
  publishedUrl?: string | null;
  warnings?: string[];
  hardFail?: boolean;
  validation?: {
    hardFail?: boolean;
    warnings?: string[];
    normalized?: boolean;
    modeConfigured?: string;
    modeEffective?: string;
    blockingEnabled?: boolean;
  };
  attempts?: { current?: number; max?: number };
  currentStage?: string;
  finalStage?: string;
  resultStage?: string | null;
  resultUrl?: string | null;
  fallbackUsed?: string | null;
  retryReason?: string | null;
  blockedStage?: string | null;
  fallbackStage?: string | null;
  validationNote?: string | null;
  parentJobId?: string | null;
  requestedStages?: any;
  retryInfo?: {
    retryType?: string;
    sourceStage?: string;
    sourceUrl?: string;
    sourceKey?: string;
    parentImageId?: string;
    parentJobId?: string;
    clientBatchId?: string;
  };
  meta: any;
  mode?: string;
  error?: string | null;
};

function normalizeStateToQueueStatus(state: string | null): QueueStatus {
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

function normalizeQueueState(state: string | null): NormalizedState {
  const s = normalizeStateToQueueStatus(state);
  if (s === "active") return "processing";
  return s as any;
}

function normalizePipelineState(raw: string | null | undefined): NormalizedState {
  const s = (raw || "").toLowerCase();
  if (s === "processing" || s === "active") return "processing";
  if (s === "complete" || s === "completed" || s === "done") return "completed";
  if (s === "failed" || s === "error") return "failed";
  if (s === "queued" || s === "waiting" || s === "waiting-children" || s === "delayed") return "queued";
  return "unknown";
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
        // Merge in Redis job record (written by worker via updateJob)
        const local = await getJob(id) || ({} as any);

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

        const queueStatus = normalizeStateToQueueStatus(state);
        const localStatusRaw: string | null = local.status || (rv && rv.status) || null;

        // Resolve URLs from BullMQ returnvalue first, then Redis job record
        const resultUrl: string | null =
          (rv && rv.resultUrl) ||
          local.resultUrl ||
          local.imageUrl ||
          null;

        const stateFromLocal = normalizePipelineState(localStatusRaw);
        const stateFromQueue = normalizeQueueState(state);
        const queueCompleted = queueStatus === "completed";
        const queueFailed = queueStatus === "failed";
        let pipelineStatus: NormalizedState;
        if (queueFailed) pipelineStatus = "failed";
        else if (queueCompleted) pipelineStatus = "completed";
        else if (resultUrl) pipelineStatus = "completed";
        else if (stateFromLocal !== "unknown") pipelineStatus = stateFromLocal;
        else pipelineStatus = stateFromQueue;

        const originalUrl: string | null =
          (rv && rv.originalUrl) || local.originalUrl || null;

        const maskUrl: string | null =
          (rv && rv.maskUrl) || local.maskUrl || null;

        const stageUrlsRaw: Record<string, string> | null =
          (rv && rv.stageUrls) || local.stageUrls || null;

        // Log status details for debugging stuck jobs
        const stageKeys = stageUrlsRaw && Object.values(stageUrlsRaw).some(Boolean)
          ? Object.keys(stageUrlsRaw).filter(k => stageUrlsRaw[k])
          : [];
        if (stageKeys.length) {
          console.log('[status/batch] Job with stages:', {
            id,
            pipelineStatus,
            stateFromLocal,
            localStatusRaw,
            bullMQState: state,
            hasResultUrl: !!resultUrl,
            stageKeys,
            localStatus: local.status,
            rvStatus: rv?.status
          });
        }

        if (resultUrl && pipelineStatus === "processing") {
          console.log('[status/batch] Processing despite resultUrl:', {
            id,
            pipelineStatus,
            stateFromLocal,
            localStatusRaw,
            bullMQState: state,
            rvStatus: rv?.status,
            hasResultUrl: true,
            stageKeys,
            localStatus: local.status
          });
        }

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

        const requestedStages =
          local?.metadata?.requestedStages ||
          local?.requestedStages ||
          (payload as any)?.requestedStages ||
          (payload as any)?.metadata?.requestedStages ||
          null;

        const finalStageRaw: string | null =
          local.finalStage || local.resultStage || (rv && (rv.finalStage || rv.resultStage)) || null;

        const stage2Present = !!(stageUrls.stage2 || stageUrls['2']);
        const requestedStage2 = typeof requestedStages?.stage2 === "boolean"
          ? requestedStages.stage2
          : (requestedStages?.stage2 === "true");

        const imageId: string | null =
          payload?.imageId || local.imageId || null;

        const mode: string | null =
          payload?.mode || local.mode || null;

        const validationRaw =
          local?.validation ||
          (local?.meta && local.meta.unifiedValidation ? {
            hardFail: local.meta.unifiedValidation.hardFail,
            warnings: local.meta.unifiedValidation.warnings,
            normalized: local.meta.unifiedValidation.normalized,
          } : undefined) ||
          undefined;

        const blockedStage = (validationRaw as any)?.blockedStage || local.blockedStage || null;
        const fallbackStageMeta = (validationRaw as any)?.fallbackStage ?? local.fallbackStage ?? null;
        const validationNote = (validationRaw as any)?.note || local.validationNote || local?.meta?.validationNote || null;

        const warningSet = new Set<string>(Array.isArray(validationRaw?.warnings)
          ? validationRaw!.warnings as string[]
          : []);
        if (validationNote) warningSet.add(validationNote);
        if (pipelineStatus === "completed" && !resultUrl) {
          warningSet.add("Image Enhancement didn’t finalise. Please retry image.");
        }
        if (requestedStage2 === false && (stage2Present || String(finalStageRaw || "").toLowerCase() === "2")) {
          warningSet.add("Stage 2 output present but not requested.");
        }
        const warnings = Array.from(warningSet);

        const hardFailRaw = validationRaw?.hardFail === true;
        const hardFail = hardFailRaw;

        const hasOutputs = !!(stageUrls.stage2 || stageUrls.stage1B || stageUrls.stage1A || resultUrl);
        let uiStatus: UiStatus = "ok";

        if (blockedStage && hasOutputs) uiStatus = "warning";
        else if (hardFail && !hasOutputs) uiStatus = "error";
        else if (hardFail && hasOutputs) uiStatus = "warning";
        else if (warnings.length) uiStatus = "warning";

        const success =
          pipelineStatus === "completed" && typeof resultUrl === "string";

        if (pipelineStatus === "completed") completed++;

        const currentStage: string | null = local.currentStage || null;
        const finalStage: string | null = finalStageRaw;
        const attempts = local.attempts || (rv && rv.attempts) || null;
        const fallbackUsed = local.fallbackUsed || (rv && rv.fallbackUsed) || null;
        const retryReason = local.retryReason || (rv && rv.retryReason) || null;
        const parentJobId = local.parentJobId || (rv && rv.parentJobId) || null;
        const retryInfo = local.retryInfo || (rv && rv.retryInfo) || null;

        const item: StatusItem = {
          id,
          state: pipelineStatus,
          status: pipelineStatus,
          uiStatus,
          queueStatus,
          success,
          imageId,
          imageUrl: resultUrl,
          originalUrl,
          maskUrl,
          publishedUrl: resultUrl,
          warnings,
          hardFail,
          validation: validationRaw,
          attempts,
          currentStage: currentStage || undefined,
          finalStage: finalStage || undefined,
          resultStage: finalStage ?? null,
          resultUrl: resultUrl ?? null,
          fallbackUsed: fallbackUsed || null,
          retryReason: retryReason || null,
          blockedStage: blockedStage || null,
          fallbackStage: fallbackStageMeta || null,
          validationNote: validationNote || null,
          parentJobId: parentJobId || null,
          requestedStages: requestedStages || null,
          retryInfo: retryInfo || undefined,
          // ensure stageUrls is either an object map or null
          stageUrls: Object.values(stageUrls).some(Boolean) ? (stageUrls as any) : null,
          mode: mode || undefined,
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
        if (item.state === 'failed' || Math.floor(Math.random() * 50) === 0) {
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
        item.state === 'completed' || item.state === 'failed'
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
      const queueStatus = normalizeStateToQueueStatus(state);
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
      const validationRaw =
        local?.validation ||
        (local?.meta && local.meta.unifiedValidation ? {
          hardFail: local.meta.unifiedValidation.hardFail,
          warnings: local.meta.unifiedValidation.warnings,
          normalized: local.meta.unifiedValidation.normalized,
        } : undefined) ||
        undefined;

      const unified = (local?.meta || {})?.unifiedValidation || {};
      const blockedStage = (validationRaw as any)?.blockedStage || local.blockedStage || null;
      const fallbackStageMeta = (validationRaw as any)?.fallbackStage ?? local.fallbackStage ?? null;
      const validationNote = (validationRaw as any)?.note || local.validationNote || local?.meta?.validationNote || null;

      const warningSet = new Set<string>(Array.isArray(unified?.warnings) ? unified.warnings : (Array.isArray(validationRaw?.warnings) ? validationRaw.warnings : []));
      if (validationNote) warningSet.add(validationNote);
      const warnings: string[] = Array.from(warningSet);
      const hardFail = !!validationRaw?.hardFail || !!unified?.hardFail || !!local?.hardFail;
      const hasOutputs = !!(stageUrls.stage2 || stageUrls.stage1B || stageUrls.stage1A || resultUrl);

      let uiStatus: UiStatus = "ok";
      if (blockedStage && hasOutputs) uiStatus = "warning";
      else if (hardFail && !hasOutputs) uiStatus = "error";
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
        status: stateOut,
        uiStatus,
        queueStatus,
        success,
        imageId,
        imageUrl: resultUrl,
        originalUrl,
        maskUrl,
        publishedUrl: resultUrl,
        warnings,
        hardFail,
        blockedStage: blockedStage || null,
        fallbackStage: fallbackStageMeta || null,
        validationNote: validationNote || null,
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
