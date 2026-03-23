
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
type NormalizedState = "queued" | "awaiting_payment" | "processing" | "completed" | "failed" | "cancelled" | "unknown";

const STUCK_PROCESSING_MS = 15 * 60 * 1000; // 15 minutes

type StatusItem = {
  id: string;
  state: NormalizedState;               // canonical pipeline status
  status: NormalizedState;              // alias for backward compatibility
  isTerminal?: boolean;                 // authoritative terminal flag
  terminalAt?: string | null;           // terminal write timestamp when available
  terminalReason?: string | null;       // terminal reason (failed reason or completion reason)
  statusSource?: "persisted" | "queue_fallback"; // where status was derived from
  uiStatus: UiStatus;                   // UI severity (ok/warning/error)
  queueStatus: QueueStatus;             // raw BullMQ state (legacy)
  success: boolean;
  imageId: string | null;
  finalOutputUrl: string | null;
  stage2Url?: string | null;
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
  stageCompleted?: string | null;
  stage2Skipped?: boolean;
  stage2SkipReason?: string | null;
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

function isTerminalState(state: NormalizedState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function pickAuthoritativeState(
  localStatusRaw: string | null,
  queueState: string | null
): { state: NormalizedState; source: "persisted" | "queue_fallback" } {
  const stateFromLocal = normalizePipelineState(localStatusRaw);
  const stateFromQueue = normalizeQueueState(queueState);

  // If persisted state is still processing-like but queue reached terminal,
  // prefer queue terminal state to avoid indefinite processing in UI.
  if (
    (stateFromLocal === "processing" || stateFromLocal === "queued" || stateFromLocal === "awaiting_payment") &&
    (stateFromQueue === "completed" || stateFromQueue === "failed")
  ) {
    return { state: stateFromQueue, source: "queue_fallback" };
  }

  if (stateFromLocal !== "unknown") {
    return { state: stateFromLocal, source: "persisted" };
  }

  // Queue state is only used as a non-terminal fallback when persisted status is absent.
  if (stateFromQueue === "queued") {
    return { state: "queued", source: "queue_fallback" };
  }
  if (stateFromQueue === "awaiting_payment") {
    return { state: "awaiting_payment", source: "queue_fallback" };
  }
  return { state: "processing", source: "queue_fallback" };
}

function resolveTerminalMetadata(
  local: any,
  status: NormalizedState,
  failedReason?: string
): { isTerminal: boolean; terminalAt: string | null; terminalReason: string | null } {
  const terminal = isTerminalState(status);
  if (!terminal) {
    return { isTerminal: false, terminalAt: null, terminalReason: null };
  }

  const completedTs = local?.timestamps?.completed;
  const completedIso = typeof completedTs === "number" ? new Date(completedTs).toISOString() : null;
  const terminalAt = local?.updatedAt || local?.updated_at || completedIso || null;
  const terminalReason =
    status === "failed"
      ? (local?.errorMessage || failedReason || "failed")
      : (local?.completionReason || "final_complete");

  return { isTerminal: true, terminalAt, terminalReason };
}

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
  if (s === "awaiting_payment") return "awaiting_payment";
  if (s === "processing" || s === "active") return "processing";
  if (s === "complete" || s === "completed" || s === "done") return "completed";
  if (s === "cancelled" || s === "canceled" || s === "aborted" || s === "terminated") return "cancelled";
  if (s === "failed" || s === "error") return "failed";
  if (s === "queued" || s === "waiting" || s === "waiting-children" || s === "delayed") return "queued";
  return "unknown";
}

function hasStage2ExhaustedSignal(parts: Array<string | null | undefined>): boolean {
  const text = parts
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join(" | ")
    .toLowerCase();
  if (!text) return false;
  return (
    text.includes("stage2_structural_exhausted") ||
    text.includes("stage2_compliance_exhausted") ||
    text.includes("stage2_validation_exhausted") ||
    text.includes("composite_validation_exhausted") ||
    text.includes("stage2_retry_failed") ||
    text.includes("retries exhausted") ||
    text.includes("retry exhausted")
  );
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
        const queueCompleted = queueStatus === "completed";
        const queueFailed = queueStatus === "failed";
        const localStatusRaw: string | null = local.status || (rv && rv.status) || null;
        const localCompleted = local.completed === true || local.success === true || !!local.finalStage;
        const allowLocalImageUrl = localCompleted || queueCompleted || queueFailed;

        // Canonical final artifact URL: all output aliases derive from this.
        const finalOutputUrl: string | null =
          (rv && rv.finalOutputUrl) ||
          local.finalOutputUrl ||
          (rv && rv.resultUrl) ||
          local.resultUrl ||
          (allowLocalImageUrl ? local.imageUrl : null) ||
          null;
        const resultUrl: string | null = finalOutputUrl;

        const stageUrlsRaw: Record<string, string> | null =
          ((local.stageUrls || rv?.stageUrls)
            ? {
                ...((local.stageUrls || {}) as Record<string, string>),
                ...((rv?.stageUrls || {}) as Record<string, string>),
              }
            : null);

        // Normalize stageUrls into a predictable shape so clients can rely on keys
        const stageUrls: Record<string, string | null> = {
          stage1A: stageUrlsRaw?.['stage1A'] ?? stageUrlsRaw?.['1A'] ?? stageUrlsRaw?.['1'] ?? null,
          stage1B: stageUrlsRaw?.['stage1B'] ?? stageUrlsRaw?.['1B'] ?? stageUrlsRaw?.['1b'] ?? null,
          stage2: stageUrlsRaw?.['stage2'] ?? stageUrlsRaw?.['2'] ?? null,
          // Legacy keys retained for backward compatibility
          '1A': stageUrlsRaw?.['1A'] ?? stageUrlsRaw?.['1'] ?? null,
          '1B': stageUrlsRaw?.['1B'] ?? stageUrlsRaw?.['1b'] ?? null,
          '2': stageUrlsRaw?.['2'] ?? stageUrlsRaw?.['stage2'] ?? null,
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
        const sceneLabel = String(
          local?.meta?.scene?.label ||
          local?.meta?.sceneType ||
          local?.sceneType ||
          (payload as any)?.options?.sceneType ||
          ""
        ).toLowerCase();
        const isExteriorScene = sceneLabel === "exterior" || sceneLabel.startsWith("exterior_");
        const stage2SkipReason = String(local?.meta?.stage2SkipReason || "").toLowerCase();
        const stage2SkippedByDesign = local?.meta?.stage2Skipped === true
          || stage2SkipReason === "exterior_scene"
          || stage2SkipReason === "outdoor_staging_disabled";
        const stagingAllowed = local?.meta?.allowStaging !== false;
        const stage2Expected = requestedStage2 === true && !isExteriorScene && stagingAllowed && !stage2SkippedByDesign;
        const bestAvailableStage: { stage: string | null; url: string | null } = (() => {
          // For scenarios where Stage 2 is not expected (exterior or staging disabled), use best available
          if (!stage2Expected) {
            if (stageUrls.stage1B || stageUrls['1B']) return { stage: '1B', url: stageUrls.stage1B || stageUrls['1B'] || null };
            if (stageUrls.stage1A || stageUrls['1A']) return { stage: '1A', url: stageUrls.stage1A || stageUrls['1A'] || null };
          }
          return { stage: null, url: null };
        })();
        
        // ✅ FIX 1: Stage-based completion detection
        const stage1BPresent = !!(stageUrls.stage1B || stageUrls['1B']);
        const stage1APresent = !!(stageUrls.stage1A || stageUrls['1A']);
        const declutterRequested = requestedStages?.stage1b || (payload as any)?.options?.declutter;
        
        // Determine if all requested stages are present (defensive completion detection)
        const allRequestedStagesPresent = (() => {
          if (requestedStage2 && stage2Expected) {
            return stage2Present; // Need Stage 2
          }
          if (declutterRequested) {
            return stage1BPresent; // Need Stage 1B
          }
          return stage1APresent; // Just need Stage 1A
        })();

        const { state: pipelineStatus, source: statusSource } = pickAuthoritativeState(localStatusRaw, state);

        const originalUrl: string | null =
          (rv && rv.originalUrl) || local.originalUrl || null;

        const maskUrl: string | null =
          (rv && rv.maskUrl) || local.maskUrl || null;

        // Log status details for debugging stuck jobs (using stageUrls declared above)
        const stageKeys = stageUrls && Object.values(stageUrls).some(Boolean)
          ? Object.keys(stageUrls).filter(k => stageUrls[k])
          : [];
        if (stageKeys.length) {
          console.log('[status/batch] Job with stages:', {
            id,
            pipelineStatus,
            stateFromLocal: normalizePipelineState(localStatusRaw),
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
            stateFromLocal: normalizePipelineState(localStatusRaw),
            localStatusRaw,
            bullMQState: state,
            rvStatus: rv?.status,
            hasResultUrl: true,
            stageKeys,
            localStatus: local.status
          });
        }

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
        const stage2Exhausted = hasStage2ExhaustedSignal([
          validationNote,
          local.errorMessage,
          failedReason,
          local?.meta?.stage2BlockedReason,
          local?.meta?.fallbackReason,
        ]);

        const warningSet = new Set<string>(Array.isArray(validationRaw?.warnings)
          ? validationRaw!.warnings as string[]
          : []);
        if (validationNote) warningSet.add(validationNote);
        if (pipelineStatus === "completed" && !resultUrl && !bestAvailableStage.url) {
          warningSet.add("Image Enhancement didn’t finalise. Please retry image.");
        }
        if (requestedStage2 === false && (stage2Present || String(finalStageRaw || "").toLowerCase() === "2")) {
          warningSet.add("Stage 2 output present but not requested.");
        }
        // Stage presence already calculated above in Fix 1
        const hasOutputs = !!(stage2Present || stage1BPresent || stage1APresent || resultUrl);
        const updatedAtRaw = local.updatedAt || local.updated_at || null;
        const updatedAtMs = updatedAtRaw ? Date.parse(updatedAtRaw) : null;
        const isProcessingLike = pipelineStatus === "processing" || pipelineStatus === "queued" || pipelineStatus === "awaiting_payment";
        const hasFallbackOutput = !!(stage1BPresent || stage1APresent || resultUrl || bestAvailableStage.url);
        if (requestedStage2 === true && !stage2Present && pipelineStatus === "completed" && !blockedStage && stage2Expected) {
          warningSet.add("We couldn’t safely finish staging for this image. The best enhanced version is shown.");
        }
        if (requestedStage2 === true && !stage2Present && stage2Expected && stage2Exhausted) {
          warningSet.add("Stage 2 retries were exhausted. The best enhanced version is shown.");
        }
        const isInformationalExteriorNote = requestedStage2 === true && isExteriorScene && !stage2Present;
        const isStuck = isProcessingLike && updatedAtMs && (Date.now() - updatedAtMs > STUCK_PROCESSING_MS);
        if (isStuck) {
          warningSet.add("Processing took longer than expected. The best available result is shown.");
        }
        if (pipelineStatus === "failed" && hasOutputs) {
          if ((blockedStage === "2" || requestedStage2 === true) && !stage2Present) {
            warningSet.add("We couldn’t safely finish staging for this image. The best enhanced version is shown.");
          } else if (stage1BPresent) {
            warningSet.add("We couldn't complete the full enhancement for this image. The best available version is shown.");
          } else if (stage1APresent) {
            warningSet.add("Enhanced copy of the original is available.");
          } else {
            warningSet.add("The best available result is shown.");
          }
        }
        // Only surface exterior staging note when the job has reached a terminal state
        const warnings = Array.from(warningSet).filter(msg => {
          if (isInformationalExteriorNote) {
            return pipelineStatus === "completed" || pipelineStatus === "failed";
          }
          return true;
        });

        const hardFailRaw = validationRaw?.hardFail === true;
        const hardFail = hardFailRaw;

        let uiStatus: UiStatus = "ok";

        if (blockedStage && hasOutputs) uiStatus = "warning";
        else if (hardFail && !hasOutputs) uiStatus = "error";
        else if (hardFail && hasOutputs) uiStatus = "warning";
        else if (warnings.length) uiStatus = "warning";
        // Do not elevate to warning solely for exterior staging unavailability while processing
        if (isInformationalExteriorNote && isProcessingLike) {
          uiStatus = hardFail ? uiStatus : "ok";
        }

        // If Stage 2 is not expected (exterior or staging disabled), allow best-available (1B/1A) to define resultUrl/finalStage
        const resolvedResultUrl = resultUrl || (!stage2Expected ? (bestAvailableStage.url || null) : null);
        const resolvedFinalStage = finalStageRaw || (!stage2Expected ? (bestAvailableStage.stage || null) : null);

        const success =
          pipelineStatus === "completed" && typeof resolvedResultUrl === "string";

        if (pipelineStatus === "completed") completed++;

        const currentStage: string | null = local.currentStage || null;
        const finalStage: string | null = resolvedFinalStage;
        const attempts = local.attempts || (rv && rv.attempts) || null;
        const fallbackUsed = local.fallbackUsed || (rv && rv.fallbackUsed) || null;
        const retryReason = local.retryReason || (rv && rv.retryReason) || null;
        const payloadRetryInfo = (() => {
          const p: any = payload || {};
          const retryType = p.retryType;
          const sourceStage = p.retrySourceStage;
          const sourceUrl = p.retrySourceUrl;
          const sourceKey = p.retrySourceKey;
          const parentImageId = p.retryParentImageId;
          const parentJobId = p.retryParentJobId;
          const clientBatchId = p.retryClientBatchId;
          if (!retryType && !sourceStage && !sourceUrl && !sourceKey && !parentImageId && !parentJobId && !clientBatchId) {
            return null;
          }
          return {
            ...(retryType ? { retryType } : {}),
            ...(sourceStage ? { sourceStage } : {}),
            ...(sourceUrl ? { sourceUrl } : {}),
            ...(sourceKey ? { sourceKey } : {}),
            ...(parentImageId ? { parentImageId } : {}),
            ...(parentJobId ? { parentJobId } : {}),
            ...(clientBatchId ? { clientBatchId } : {}),
          };
        })();
        const parentJobId = local.parentJobId || (rv && rv.parentJobId) || payloadRetryInfo?.parentJobId || null;
        const retryInfo = local.retryInfo || (rv && rv.retryInfo) || payloadRetryInfo || null;

        const terminalMeta = resolveTerminalMetadata(local, pipelineStatus, failedReason);
        const item: StatusItem = {
          id,
          state: pipelineStatus,
          status: pipelineStatus,
          isTerminal: terminalMeta.isTerminal,
          terminalAt: terminalMeta.terminalAt,
          terminalReason: terminalMeta.terminalReason,
          statusSource,
          uiStatus,
          queueStatus,
          success,
          imageId,
          finalOutputUrl: resolvedResultUrl,
          stage2Url: stageUrls.stage2 || stageUrls['2'] || null,
          imageUrl: resolvedResultUrl,
          originalUrl,
          maskUrl,
          publishedUrl: resolvedResultUrl,
          warnings,
          hardFail,
          validation: validationRaw,
          attempts,
          currentStage: currentStage || undefined,
          finalStage: resolvedFinalStage || undefined,
          resultStage: resolvedFinalStage ?? null,
          stageCompleted: local.stageCompleted || resolvedFinalStage || null,
          stage2Skipped: local.stage2Skipped === true || local?.meta?.stage2Skipped === true,
          stage2SkipReason: local.stage2SkipReason || local?.meta?.stage2SkipReason || null,
          resultUrl: resolvedResultUrl ?? null,
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
        item.state === 'completed' || item.state === 'failed' || item.state === 'cancelled'
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
        base.finalOutputUrl = j.finalOutputUrl;
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
      const payloadRetryInfo = (() => {
        const p: any = payload || {};
        const retryType = p.retryType;
        const sourceStage = p.retrySourceStage;
        const sourceUrl = p.retrySourceUrl;
        const sourceKey = p.retrySourceKey;
        const parentImageId = p.retryParentImageId;
        const parentJobId = p.retryParentJobId;
        const clientBatchId = p.retryClientBatchId;
        if (!retryType && !sourceStage && !sourceUrl && !sourceKey && !parentImageId && !parentJobId && !clientBatchId) {
          return null;
        }
        return {
          ...(retryType ? { retryType } : {}),
          ...(sourceStage ? { sourceStage } : {}),
          ...(sourceUrl ? { sourceUrl } : {}),
          ...(sourceKey ? { sourceKey } : {}),
          ...(parentImageId ? { parentImageId } : {}),
          ...(parentJobId ? { parentJobId } : {}),
          ...(clientBatchId ? { clientBatchId } : {}),
        };
      })();
      const localCompleted = local.completed === true || local.success === true || !!local.finalStage;
      const allowLocalImageUrl = localCompleted || stateNormalized === "completed" || stateNormalized === "failed";
      const finalOutputUrl: string | null =
        (rv && rv.finalOutputUrl) ||
        local.finalOutputUrl ||
        (rv && rv.resultUrl) ||
        local.resultUrl ||
        (allowLocalImageUrl ? local.imageUrl : null) ||
        null;
      const resultUrl: string | null = finalOutputUrl;
      const originalUrl: string | null =
        (rv && rv.originalUrl) || local.originalUrl || null;
      const maskUrl: string | null =
        (rv && rv.maskUrl) || local.maskUrl || null;
      const stageUrlsRaw: Record<string, string> | null =
        ((local.stageUrls || rv?.stageUrls)
          ? {
              ...((local.stageUrls || {}) as Record<string, string>),
              ...((rv?.stageUrls || {}) as Record<string, string>),
            }
          : null);

      const stageUrls: Record<string, string | null> = {
        stage1A: stageUrlsRaw?.['stage1A'] ?? stageUrlsRaw?.['1A'] ?? stageUrlsRaw?.['1'] ?? null,
        stage1B: stageUrlsRaw?.['stage1B'] ?? stageUrlsRaw?.['1B'] ?? stageUrlsRaw?.['1b'] ?? null,
        stage2: stageUrlsRaw?.['stage2'] ?? stageUrlsRaw?.['2'] ?? null,
        '1A': stageUrlsRaw?.['1A'] ?? stageUrlsRaw?.['1'] ?? null,
        '1B': stageUrlsRaw?.['1B'] ?? stageUrlsRaw?.['1b'] ?? null,
        '2': stageUrlsRaw?.['2'] ?? stageUrlsRaw?.['stage2'] ?? null,
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
      const stage2Exhausted = hasStage2ExhaustedSignal([
        validationNote,
        local.errorMessage,
        failedReason,
        local?.meta?.stage2BlockedReason,
        local?.meta?.fallbackReason,
      ]);

      const warningSet = new Set<string>(Array.isArray(unified?.warnings) ? unified.warnings : (Array.isArray(validationRaw?.warnings) ? validationRaw.warnings : []));
      if (validationNote) warningSet.add(validationNote);
      const hardFail = !!validationRaw?.hardFail || !!unified?.hardFail || !!local?.hardFail;
      const stage2Present = !!(stageUrls.stage2 || stageUrls['2']);
      const stage1BPresent = !!(stageUrls.stage1B || stageUrls['1B']);
      const stage1APresent = !!(stageUrls.stage1A || stageUrls['1A']);
      const hasOutputs = !!(stage2Present || stage1BPresent || stage1APresent || resultUrl);
      const updatedAtRaw = local.updatedAt || local.updated_at || null;
      const updatedAtMs = updatedAtRaw ? Date.parse(updatedAtRaw) : null;
      
      const requestedStages =
        local?.metadata?.requestedStages ||
        local?.requestedStages ||
        (payload as any)?.requestedStages ||
        (payload as any)?.metadata?.requestedStages ||
        null;
      const requestedStage2 = typeof requestedStages?.stage2 === "boolean"
        ? requestedStages.stage2
        : (requestedStages?.stage2 === "true");
      const declutterRequested = requestedStages?.stage1b || (payload as any)?.options?.declutter;
      const sceneLabel = String(
        local?.meta?.scene?.label ||
        local?.meta?.sceneType ||
        local?.sceneType ||
        (payload as any)?.options?.sceneType ||
        ""
      ).toLowerCase();
      const isExteriorScene = sceneLabel === "exterior" || sceneLabel.startsWith("exterior_");
      const stage2SkipReason = String(local?.meta?.stage2SkipReason || "").toLowerCase();
      const stage2SkippedByDesign = local?.meta?.stage2Skipped === true
        || stage2SkipReason === "exterior_scene"
        || stage2SkipReason === "outdoor_staging_disabled";
      const stagingAllowed = local?.meta?.allowStaging !== false;
      const stage2Expected = requestedStage2 === true && !isExteriorScene && stagingAllowed && !stage2SkippedByDesign;
      
      // ✅ FIX 1: Stage-based completion detection (single-job endpoint)
      const allRequestedStagesPresent = (() => {
        if (requestedStage2 && stage2Expected) {
          return stage2Present;
        }
        if (declutterRequested) {
          return stage1BPresent;
        }
        return stage1APresent;
      })();
      
      const { state: stateOut, source: statusSource } = pickAuthoritativeState(local?.status || null, state);

      const hasFallbackOutput = !!(stage1BPresent || stage1APresent || resultUrl);
      if (requestedStage2 === true && !stage2Present && stateOut === "completed" && !blockedStage && stage2Expected) {
        warningSet.add("We couldn’t safely finish staging for this image. The best enhanced version is shown.");
      }
      if (requestedStage2 === true && !stage2Present && stage2Expected && stage2Exhausted) {
        warningSet.add("Stage 2 retries were exhausted. The best enhanced version is shown.");
      }
      if (requestedStage2 === true && isExteriorScene && !stage2Present) {
        warningSet.add("Staging isn't available for exterior images. The best enhanced version is shown.");
      }

      const isProcessingLike = stateOut === "processing" || stateOut === "queued" || stateOut === "awaiting_payment";
      const isStuck = isProcessingLike && updatedAtMs && (Date.now() - updatedAtMs > STUCK_PROCESSING_MS);
      if (isStuck) {
        warningSet.add("Processing took longer than expected. The best available result is shown.");
      }
      if (stateOut === "failed" && hasOutputs) {
        if (blockedStage === "2" && !stage2Present) {
          warningSet.add("We couldn’t safely finish staging for this image. The best enhanced version is shown.");
        } else if (stage1BPresent) {
          warningSet.add("We couldn't complete the full enhancement for this image. The best available version is shown.");
        } else if (stage1APresent) {
          warningSet.add("Enhanced copy of the original is available.");
        } else {
          warningSet.add("The best available result is shown.");
        }
      }
      const warnings: string[] = Array.from(warningSet);

      let uiStatus: UiStatus = "ok";
      if (blockedStage && hasOutputs) uiStatus = "warning";
      else if (hardFail && !hasOutputs) uiStatus = "error";
      else if (hardFail && hasOutputs) uiStatus = "warning";
      else if (warnings.length) uiStatus = "warning";

      const success =
        stateOut === "completed" && typeof resultUrl === "string";
      const terminalMeta = resolveTerminalMetadata(local, stateOut, failedReason);
      const item: StatusItem = {
        id: jobId,
        state: stateOut,
        status: stateOut,
        isTerminal: terminalMeta.isTerminal,
        terminalAt: terminalMeta.terminalAt,
        terminalReason: terminalMeta.terminalReason,
        statusSource,
        uiStatus,
        queueStatus,
        success,
        imageId,
        finalOutputUrl,
        stage2Url: stageUrls.stage2 || stageUrls['2'] || null,
        imageUrl: resultUrl,
        originalUrl,
        maskUrl,
        publishedUrl: resultUrl,
        warnings,
        hardFail,
        blockedStage: blockedStage || null,
        fallbackStage: fallbackStageMeta || null,
        validationNote: validationNote || null,
        parentJobId: local.parentJobId || payloadRetryInfo?.parentJobId || null,
        retryInfo: local.retryInfo || payloadRetryInfo || undefined,
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
        finalOutputUrl: item.finalOutputUrl,
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
              finalOutputUrl: rv.finalOutputUrl || rv.resultUrl || null,
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
