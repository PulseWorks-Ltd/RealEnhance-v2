import * as crypto from "node:crypto";
import { Queue } from "bullmq";
import { createClient } from "redis";
import type {
  AnyJobPayload,
  JobRecord,
  JobId,
  UserId,
  ImageId,
} from "../shared/types.js";
import { JOB_QUEUE_NAME } from "../shared/constants.js";
import { saveJobMetadata } from "@realenhance/shared/imageStore";
import { normalizeStageLabel, resolveStageUrl } from "@realenhance/shared/stageUrlResolver";
import type { JobOwnershipMetadata, RequestedStages } from "@realenhance/shared/types/jobMetadata";

const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || "redis://localhost:6379";
const redisClient = createClient({ url: REDIS_URL });
redisClient.connect().catch(() => {});

const DEFAULT_JOB_ATTEMPTS = Math.max(1, Number(process.env.JOB_ATTEMPTS || 3));
const DEFAULT_JOB_BACKOFF_DELAY_MS = Math.max(100, Number(process.env.JOB_BACKOFF_DELAY_MS || 1000));
const STUCK_PROCESSING_RECOVERY_MS = Math.max(60_000, Number(process.env.STUCK_PROCESSING_RECOVERY_MS || 20 * 60 * 1000));
const AWAITING_PAYMENT_TTL_MS = 10 * 60 * 1000;

function buildAwaitingPaymentExpiryIso(createdAtIso?: string): string {
  const createdTs = Date.parse(String(createdAtIso || ""));
  const baseTs = Number.isFinite(createdTs) ? createdTs : Date.now();
  return new Date(baseTs + AWAITING_PAYMENT_TTL_MS).toISOString();
}

function isAwaitingPaymentExpired(rec: any): boolean {
  const expiresAt = String(rec?.expiresAt || "").trim();
  if (!expiresAt) return false;
  const expiresTs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresTs)) return false;
  return Date.now() > expiresTs;
}

function buildQueueJobOptions(jobId: string) {
  return {
    jobId,
    attempts: DEFAULT_JOB_ATTEMPTS,
    backoff: {
      type: "exponential" as const,
      delay: DEFAULT_JOB_BACKOFF_DELAY_MS,
    },
  };
}

function awaitingUserKey(userId: string) {
  return `user:${userId}:jobs:awaiting_payment`;
}

async function addAwaitingPaymentIndex(userId: string, jobId: string, createdAt?: string) {
  const score = Date.parse(createdAt || "") || Date.now();
  await redisClient.zAdd(awaitingUserKey(userId), [{ score, value: jobId }]);
}

async function removeAwaitingPaymentIndex(userId: string, jobId: string) {
  await redisClient.zRem(awaitingUserKey(userId), jobId);
}

function queue() {
  return new Queue(JOB_QUEUE_NAME, {
    connection: { url: REDIS_URL },
  });
}

function batchJobsKey(batchId: string) {
  return `batch:${batchId}:jobs`;
}

export async function addJobToBatchIndex(batchId: string, jobId: string) {
  const normalizedBatchId = String(batchId || "").trim();
  const normalizedJobId = String(jobId || "").trim();
  if (!normalizedBatchId || !normalizedJobId) return;
  await redisClient.sAdd(batchJobsKey(normalizedBatchId), normalizedJobId);
  // Keep batch index bounded in case a client never explicitly clears it.
  await redisClient.expire(batchJobsKey(normalizedBatchId), 60 * 60 * 24 * 7);
}

export async function listBatchJobIds(batchId: string): Promise<string[]> {
  const normalizedBatchId = String(batchId || "").trim();
  if (!normalizedBatchId) return [];

  const indexedIds = await redisClient.sMembers(batchJobsKey(normalizedBatchId));
  if (indexedIds.length) {
    return Array.from(new Set(indexedIds.map((id) => String(id).trim()).filter(Boolean)));
  }

  // Backfill fallback for batches created before index support.
  const found = new Set<string>();
  let cursor = "0";
  do {
    const scanRes: any = await (redisClient as any).scan(cursor, {
      MATCH: "jobs:*",
      COUNT: 200,
    });
    cursor = String(scanRes?.cursor || "0");
    const keys: string[] = Array.isArray(scanRes?.keys) ? scanRes.keys : [];
    if (!keys.length) continue;

    const values = await redisClient.mGet(keys);
    for (let i = 0; i < keys.length; i++) {
      const raw = values[i];
      if (!raw) continue;
      try {
        const rec: any = JSON.parse(raw);
        const recBatchId = String(
          rec?.clientBatchId ||
          rec?.payload?.clientBatchId ||
          rec?.metadata?.clientBatchId ||
          rec?.payload?.metadata?.clientBatchId ||
          ""
        ).trim();
        if (recBatchId !== normalizedBatchId) continue;

        const jobId = String(rec?.jobId || rec?.id || keys[i].replace(/^jobs:/, "")).trim();
        if (!jobId) continue;
        found.add(jobId);
      } catch {
        // Ignore malformed records.
      }
    }
  } while (cursor !== "0");

  if (found.size) {
    await redisClient.sAdd(batchJobsKey(normalizedBatchId), [...found]);
    await redisClient.expire(batchJobsKey(normalizedBatchId), 60 * 60 * 24 * 7);
  }

  return [...found];
}

export async function listBatchJobIdsForUser(batchId: string, userId: string): Promise<string[]> {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return [];

  const ids = await listBatchJobIds(batchId);
  if (!ids.length) return [];

  const keys = ids.map((id) => `jobs:${id}`);
  const values = await redisClient.mGet(keys);

  const ownedIds: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const raw = values[i];
    if (!raw) continue;
    try {
      const rec: any = JSON.parse(raw);
      if (String(rec?.userId || "").trim() === normalizedUserId) {
        ownedIds.push(ids[i]);
      }
    } catch {
      // Ignore malformed records.
    }
  }

  return ownedIds;
}

export async function deleteBatchState(batchId: string) {
  const normalizedBatchId = String(batchId || "").trim();
  if (!normalizedBatchId) return;
  await redisClient.del(batchJobsKey(normalizedBatchId));
}

// Redis-based job record helpers
export async function updateJob(jobId: JobId, patch: Partial<JobRecord> & Record<string, any>) {
  const key = `jobs:${jobId}`;
  let rec: any = {};
  try {
    const val = await redisClient.get(key);
    if (val) rec = JSON.parse(val);
  } catch {}
  rec = {
    ...rec,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await redisClient.set(key, JSON.stringify(rec));

  const userId = String(rec?.userId || "").trim();
  if (userId) {
    if (String(rec?.status || "") === "awaiting_payment") {
      await addAwaitingPaymentIndex(userId, jobId, rec?.createdAt || rec?.payload?.createdAt);
    } else {
      await removeAwaitingPaymentIndex(userId, jobId);
    }
  }
}

export async function getJob(jobId: string): Promise<JobRecord | undefined> {
  const key = `jobs:${jobId}`;
  try {
    const val = await redisClient.get(key);
    if (val) return JSON.parse(val);
  } catch {}
  return undefined;
}

function buildEnhanceArtifacts(params: {
  userId: UserId;
  imageId: ImageId;
  agencyId?: string | null;
  propertyId?: string | null;
  clientBatchId?: string | null;
  remoteOriginalUrl?: string;
  remoteOriginalKey?: string;
  retryInfo?: {
    retryType?: "manual_retry";
    sourceStage?: string | null;
    sourceUrl?: string | null;
    sourceKey?: string | null;
    stage1BWasRequested?: boolean;
    baselineStage?: string | null;
    baselineUrl?: string | null;
    requestedStages?: Array<"1A" | "1B" | "2">;
    stagesToRun?: Array<"1A" | "1B" | "2">;
    parentImageId?: string | null;
    parentJobId?: string | null;
    clientBatchId?: string | null;
  };
  options: {
    declutter: boolean;
    declutterMode?: "light" | "stage-ready";
    virtualStage: boolean;
    stage2Only?: boolean;
    roomType: string;
    sceneType: string;
    replaceSky?: boolean;
    manualSceneOverride?: boolean;
    scenePrediction?: {
      scene: string | null;
      confidence: number;
      reason?: string;
      features?: Record<string, number>;
      source?: string;
    };
    sampling?: {
      temperature?: number;
      topP?: number;
      topK?: number;
    };
    declutterIntensity?: "light" | "standard" | "heavy";
    stagingStyle?: string;
    stage2Variant?: "2A" | "2B";
    furnishedState?: "furnished" | "empty";
    stagingPreference?: "refresh" | "full";
  };
  stage2OnlyMode?: {
    enabled: boolean;
    baseStage?: "1A" | "1B";
    base1BUrl?: string;
    base1AUrl?: string;
    sourceStage?: "1A" | "1B-light" | "1B-stage-ready";
    stage1BMode?: "light" | "stage-ready";
  };
  executionPlan?: {
    runStage1A: boolean;
    runStage1B: boolean;
    runStage2: boolean;
    stage2Baseline?: "1A" | "1B" | "original_upload";
    baselineUrl?: string;
    sourceStage?: string;
  };
}, jobIdOverride?: JobId) {
  const jobId: JobId = jobIdOverride ?? ("job_" + crypto.randomUUID());
  const now = new Date().toISOString();

  const requestedStages: RequestedStages = {
    stage1a: true,
    stage1b: params.options.declutter ? (params.options.declutterMode === "light" ? "light" : "full") : undefined,
    stage2: params.options.virtualStage,
    stage2Mode: params.options.virtualStage
      ? (params.options.stagingPreference === "refresh"
        ? "refresh"
        : params.options.stagingPreference === "full"
          ? "empty"
          : "auto")
      : undefined,
  };

  const jobMeta: JobOwnershipMetadata = {
    userId: params.userId,
    imageId: params.imageId,
    jobId,
    createdAt: now,
    requestedStages,
    ...(params.remoteOriginalKey ? { s3: { key: params.remoteOriginalKey } } : {}),
  };

  const payload: AnyJobPayload = {
    jobId,
    userId: params.userId,
    imageId: params.imageId,
    type: "enhance",
    agencyId: params.agencyId,
    propertyId: params.propertyId,
    clientBatchId: params.clientBatchId || undefined,
    options: params.options,
    createdAt: now,
    remoteOriginalUrl: params.remoteOriginalUrl as any,
    remoteOriginalKey: params.remoteOriginalKey as any,
    retryType: params.retryInfo?.retryType,
    retrySourceStage: (() => {
      const rawSourceStage = String(params.retryInfo?.sourceStage || "").trim().toLowerCase();
      const direct = normalizeStageLabel(rawSourceStage);
      if (direct) return direct;
      const hints = {
        "1A": rawSourceStage.includes("1a") ? "1A" : null,
        "1B": rawSourceStage.includes("1b") ? "1B" : null,
        "2": rawSourceStage === "2" || rawSourceStage.includes("stage2") ? "2" : null,
      };
      return resolveStageUrl(hints, "1B") ? "1B"
        : resolveStageUrl(hints, "1A") ? "1A"
          : resolveStageUrl(hints, "2") ? "2"
            : (params.retryInfo?.sourceStage || undefined);
    })(),
    retrySourceUrl: params.retryInfo?.sourceUrl,
    retrySourceKey: params.retryInfo?.sourceKey,
    retryStage1BWasRequested: params.retryInfo?.stage1BWasRequested,
    retryBaselineStage: params.retryInfo?.baselineStage,
    retryBaselineUrl: params.retryInfo?.baselineUrl,
    retryRequestedStages: params.retryInfo?.requestedStages,
    retryStagesToRun: params.retryInfo?.stagesToRun,
    retryParentImageId: params.retryInfo?.parentImageId,
    retryParentJobId: params.retryInfo?.parentJobId,
    retryClientBatchId: params.retryInfo?.clientBatchId,
    stage2OnlyMode: params.stage2OnlyMode as any,
    executionPlan: params.executionPlan as any,
  } as any;

  return { jobId, now, jobMeta, payload };
}

// enhance job
export async function enqueueEnhanceJob(params: {
  userId: UserId;
  imageId: ImageId;
  agencyId?: string | null;
  propertyId?: string | null;
  clientBatchId?: string | null;
  remoteOriginalUrl?: string;
  remoteOriginalKey?: string;
  retryInfo?: {
    retryType?: "manual_retry";
    sourceStage?: string | null;
    sourceUrl?: string | null;
    sourceKey?: string | null;
    stage1BWasRequested?: boolean;
    baselineStage?: string | null;
    baselineUrl?: string | null;
    requestedStages?: Array<"1A" | "1B" | "2">;
    stagesToRun?: Array<"1A" | "1B" | "2">;
    parentImageId?: string | null;
    parentJobId?: string | null;
    clientBatchId?: string | null;
  };
  options: {
    declutter: boolean;
    declutterMode?: "light" | "stage-ready";
    virtualStage: boolean;
    stage2Only?: boolean;
    roomType: string;
    sceneType: string;
    replaceSky?: boolean;
    manualSceneOverride?: boolean;
    scenePrediction?: {
      scene: string | null;
      confidence: number;
      reason?: string;
      features?: Record<string, number>;
      source?: string;
    };
    sampling?: {
      temperature?: number;
      topP?: number;
      topK?: number;
    };
    declutterIntensity?: "light" | "standard" | "heavy";
    stagingStyle?: string;
    stage2Variant?: "2A" | "2B";
    furnishedState?: "furnished" | "empty";
    stagingPreference?: "refresh" | "full";
  };
  stage2OnlyMode?: {
    enabled: boolean;
    baseStage?: "1A" | "1B";
    base1BUrl?: string;
    base1AUrl?: string;
    sourceStage?: "1A" | "1B-light" | "1B-stage-ready";
    stage1BMode?: "light" | "stage-ready";
  };
  executionPlan?: {
    runStage1A: boolean;
    runStage1B: boolean;
    runStage2: boolean;
    stage2Baseline?: "1A" | "1B" | "original_upload";
    baselineUrl?: string;
    sourceStage?: string;
  };
}, jobIdOverride?: JobId) {
  const { jobId, jobMeta, payload } = buildEnhanceArtifacts(params, jobIdOverride);

  await Promise.all([
    queue().add(JOB_QUEUE_NAME, payload, buildQueueJobOptions(jobId)),
    saveJobMetadata(jobMeta),
    updateJob(jobId, {
      id: jobId,
      jobId,
      type: "enhance",
      userId: params.userId,
      imageId: params.imageId,
      status: "queued",
      payload,
      clientBatchId: params.clientBatchId || undefined,
      metadata: jobMeta,
      createdAt: payload.createdAt,
    }),
  ]);
  if (params.clientBatchId) {
    await addJobToBatchIndex(params.clientBatchId, jobId);
  }
  return { jobId };
}

export async function createAwaitingPaymentEnhanceJob(params: {
  userId: UserId;
  imageId: ImageId;
  agencyId?: string | null;
  propertyId?: string | null;
  clientBatchId?: string | null;
  remoteOriginalUrl?: string;
  remoteOriginalKey?: string;
  retryInfo?: {
    retryType?: "manual_retry";
    sourceStage?: string | null;
    sourceUrl?: string | null;
    sourceKey?: string | null;
    stage1BWasRequested?: boolean;
    baselineStage?: string | null;
    baselineUrl?: string | null;
    requestedStages?: Array<"1A" | "1B" | "2">;
    stagesToRun?: Array<"1A" | "1B" | "2">;
    parentImageId?: string | null;
    parentJobId?: string | null;
    clientBatchId?: string | null;
  };
  options: {
    declutter: boolean;
    declutterMode?: "light" | "stage-ready";
    virtualStage: boolean;
    stage2Only?: boolean;
    roomType: string;
    sceneType: string;
    replaceSky?: boolean;
    manualSceneOverride?: boolean;
    scenePrediction?: {
      scene: string | null;
      confidence: number;
      reason?: string;
      features?: Record<string, number>;
      source?: string;
    };
    sampling?: {
      temperature?: number;
      topP?: number;
      topK?: number;
    };
    declutterIntensity?: "light" | "standard" | "heavy";
    stagingStyle?: string;
    stage2Variant?: "2A" | "2B";
    furnishedState?: "furnished" | "empty";
    stagingPreference?: "refresh" | "full";
  };
  stage2OnlyMode?: {
    enabled: boolean;
    baseStage?: "1A" | "1B";
    base1BUrl?: string;
    base1AUrl?: string;
    sourceStage?: "1A" | "1B-light" | "1B-stage-ready";
    stage1BMode?: "light" | "stage-ready";
  };
  executionPlan?: {
    runStage1A: boolean;
    runStage1B: boolean;
    runStage2: boolean;
    stage2Baseline?: "1A" | "1B" | "original_upload";
    baselineUrl?: string;
    sourceStage?: string;
  };
}, jobIdOverride?: JobId) {
  const { jobId, jobMeta, payload } = buildEnhanceArtifacts(params, jobIdOverride);
  const expiresAt = buildAwaitingPaymentExpiryIso(payload.createdAt);

  await Promise.all([
    saveJobMetadata(jobMeta),
    updateJob(jobId, {
      id: jobId,
      jobId,
      type: "enhance",
      userId: params.userId,
      imageId: params.imageId,
      status: "awaiting_payment",
      payload,
      clientBatchId: params.clientBatchId || undefined,
      metadata: jobMeta,
      createdAt: payload.createdAt,
      expiresAt,
    }),
  ]);

  if (params.clientBatchId) {
    await addJobToBatchIndex(params.clientBatchId, jobId);
  }

  return { jobId };
}

export async function enqueueStoredEnhanceJob(jobId: string): Promise<{ enqueued: boolean }> {
  const rec = await getJob(jobId);
  const payload = (rec as any)?.payload;
  if (!payload || payload.type !== "enhance") {
    return { enqueued: false };
  }

  return enqueueStoredJob(jobId);
}

export async function enqueueStoredJob(jobId: string): Promise<{ enqueued: boolean }> {
  const rec = await getJob(jobId);
  const payload = (rec as any)?.payload;
  if (!payload || typeof payload !== "object") {
    return { enqueued: false };
  }

  if (String((rec as any)?.status || "") === "awaiting_payment" && isAwaitingPaymentExpired(rec)) {
    await updateJob(jobId as any, {
      status: "cancelled",
      cancelReason: "payment_timeout",
      cancelledAt: new Date().toISOString(),
    });
    return { enqueued: false };
  }

  const q = queue();
  const existing = await q.getJob(jobId);
  if (!existing) {
    await q.add(JOB_QUEUE_NAME, payload, buildQueueJobOptions(jobId));
  }

  await updateJob(jobId, { status: "queued" });
  return { enqueued: true };
}

export async function cancelEnqueuedJob(jobId: string, reason = "batch_enqueue_failed"): Promise<void> {
  const normalizedJobId = String(jobId || "").trim();
  if (!normalizedJobId) return;

  try {
    const q = queue();
    const qJob = await q.getJob(normalizedJobId);
    if (qJob) {
      try {
        await qJob.remove();
      } catch (removeErr) {
        console.warn(`[JOB_CANCEL] failed to remove queue job ${normalizedJobId}:`, (removeErr as any)?.message || removeErr);
      }
    }
  } catch (queueErr) {
    console.warn(`[JOB_CANCEL] queue lookup failed for ${normalizedJobId}:`, (queueErr as any)?.message || queueErr);
  }

  await updateJob(normalizedJobId as any, {
    status: "cancelled",
    cancelReason: reason,
    cancelledAt: new Date().toISOString(),
  });
}

export async function scanAndRecoverStuckJobs(): Promise<{ scanned: number; recovered: number }> {
  let scanned = 0;
  let recovered = 0;
  const now = Date.now();
  let cursor = "0";

  do {
    const scanRes: any = await (redisClient as any).scan(cursor, {
      MATCH: "jobs:*",
      COUNT: 200,
    });

    cursor = String(scanRes?.cursor || "0");
    const keys: string[] = Array.isArray(scanRes?.keys) ? scanRes.keys : [];
    if (!keys.length) continue;

    const values = await redisClient.mGet(keys);
    for (let i = 0; i < keys.length; i++) {
      const raw = values[i];
      if (!raw) continue;

      scanned += 1;
      try {
        const rec: any = JSON.parse(raw);
        const status = String(rec?.status || "").toLowerCase();
        if (status !== "processing") continue;

        const updatedAtMs = Date.parse(String(rec?.updatedAt || rec?.updated_at || rec?.createdAt || rec?.payload?.createdAt || ""));
        if (!Number.isFinite(updatedAtMs)) continue;
        if (now - updatedAtMs <= STUCK_PROCESSING_RECOVERY_MS) continue;

        const jobId = String(rec?.jobId || rec?.id || keys[i].replace(/^jobs:/, "")).trim();
        if (!jobId) continue;

        await updateJob(jobId as any, {
          status: "failed",
          retryable: true,
          errorMessage: "stuck_processing_timeout",
          stuckDetectedAt: new Date().toISOString(),
        });

        const requeue = await enqueueStoredJob(jobId);
        if (requeue.enqueued) {
          recovered += 1;
          console.warn("[STUCK_JOB_RECOVERED]", { jobId, ageMs: now - updatedAtMs });
        }
      } catch {
        // Ignore malformed records
      }
    }
  } while (cursor !== "0");

  return { scanned, recovered };
}

export async function listAwaitingPaymentEnhanceJobs(userId: string): Promise<Array<{ jobId: string; createdAt: string; payload: any }>> {
  const indexKey = awaitingUserKey(userId);

  const indexedIds = await redisClient.zRange(indexKey, 0, -1);
  if (indexedIds.length > 0) {
    const keys = indexedIds.map((jobId) => `jobs:${jobId}`);
    const values = await redisClient.mGet(keys);
    const out: Array<{ jobId: string; createdAt: string; payload: any }> = [];
    const staleIds: string[] = [];

    for (let i = 0; i < indexedIds.length; i++) {
      const jobId = indexedIds[i];
      const raw = values[i];
      if (!raw) {
        staleIds.push(jobId);
        continue;
      }
      try {
        const rec: any = JSON.parse(raw);
        const isAwaiting = String(rec?.status || "") === "awaiting_payment";
        const isEnhance = String(rec?.type || rec?.payload?.type || "") === "enhance";
        if (!isAwaiting || !isEnhance || rec?.userId !== userId) {
          staleIds.push(jobId);
          continue;
        }
        if (isAwaitingPaymentExpired(rec)) {
          await updateJob(jobId as any, {
            status: "cancelled",
            cancelReason: "payment_timeout",
            cancelledAt: new Date().toISOString(),
          });
          staleIds.push(jobId);
          continue;
        }
        out.push({
          jobId,
          createdAt: String(rec?.createdAt || rec?.payload?.createdAt || ""),
          payload: rec?.payload,
        });
      } catch {
        staleIds.push(jobId);
      }
    }

    if (staleIds.length) {
      await redisClient.zRem(indexKey, staleIds);
    }

    return out;
  }

  // Backfill fallback for older records that predate the per-user index.
  const out: Array<{ jobId: string; createdAt: string; payload: any }> = [];
  let cursor = "0";

  do {
    const scanRes: any = await (redisClient as any).scan(cursor, {
      MATCH: "jobs:*",
      COUNT: 200,
    });
    cursor = String(scanRes?.cursor || "0");
    const keys: string[] = Array.isArray(scanRes?.keys) ? scanRes.keys : [];

    if (!keys.length) continue;

    const values = await redisClient.mGet(keys);
    for (let i = 0; i < keys.length; i++) {
      const raw = values[i];
      if (!raw) continue;
      try {
        const rec: any = JSON.parse(raw);
        if (
          rec?.userId === userId &&
          String(rec?.status || "") === "awaiting_payment" &&
          String(rec?.type || rec?.payload?.type || "") === "enhance"
        ) {
          const jobId = String(rec?.jobId || rec?.id || keys[i].replace(/^jobs:/, "")).trim();
          if (!jobId) continue;
          if (isAwaitingPaymentExpired(rec)) {
            await updateJob(jobId as any, {
              status: "cancelled",
              cancelReason: "payment_timeout",
              cancelledAt: new Date().toISOString(),
            });
            continue;
          }
          out.push({
            jobId,
            createdAt: String(rec?.createdAt || rec?.payload?.createdAt || ""),
            payload: rec?.payload,
          });
          await addAwaitingPaymentIndex(userId, jobId, String(rec?.createdAt || rec?.payload?.createdAt || ""));
        }
      } catch {}
    }
  } while (cursor !== "0");

  out.sort((a, b) => {
    const ta = Date.parse(a.createdAt || "") || 0;
    const tb = Date.parse(b.createdAt || "") || 0;
    return ta - tb;
  });

  return out;
}

// edit job
export async function enqueueEditJob(params: {
  userId: UserId;
  agencyId?: string;
  propertyId?: string;
  sourceImageId?: string;
  imageId: ImageId;
  baseVersionId: string;
  mode: "Add" | "Remove" | "Replace" | "Restore";
  instruction: string;
  mask: unknown;
  remoteBaseUrl?: string;
  remoteRestoreUrl?: string;
  allowStaging?: boolean;
  stagingStyle?: string;
}) {
  const jobId: JobId = "job_" + crypto.randomUUID();
  const now = new Date().toISOString();

  const payload: AnyJobPayload = {
    jobId,
    userId: params.userId,
    agencyId: params.agencyId,
    imageId: params.imageId,
    type: "edit",
    baseVersionId: params.baseVersionId,
    mode: params.mode,
    instruction: params.instruction,
    mask: params.mask,
    createdAt: now,
    ...(params.remoteBaseUrl ? { remoteBaseUrl: params.remoteBaseUrl } : {}),
    ...(params.remoteRestoreUrl ? { remoteRestoreUrl: params.remoteRestoreUrl } : {}),
    ...(params.propertyId ? { propertyId: params.propertyId } : {}),
    ...(params.sourceImageId ? { sourceImageId: params.sourceImageId } : {}),
    ...(params.allowStaging !== undefined ? { allowStaging: params.allowStaging } : {}),
    ...(params.stagingStyle ? { stagingStyle: params.stagingStyle } : {}),
  } as any;

  await queue().add(JOB_QUEUE_NAME, payload, buildQueueJobOptions(jobId));
  return { jobId };
}

// region edit job
export async function enqueueRegionEditJob(params: {
  userId: UserId;
  agencyId?: string;
  propertyId?: string;
  sourceJobId?: string;
  parentJobId?: string;
  sourceImageId?: string;
  imageId?: ImageId;
  baselineStage?: "1A" | "1B" | "2";
  mode: "add" | "remove" | "restore" | "replace";
  editIntent?: "add" | "remove" | "replace";
  editSourceStage?: "stage1A" | "stage1B" | "stage2";
  prompt?: string;
  currentImageUrl: string;
  baseImageUrl?: string;
  mask: string;
  imageIndex?: number;
  restoreFromUrl?: string;
  stage1AReferenceUrl?: string;
}) {
  const jobId: JobId = "job_" + crypto.randomUUID();
  const now = new Date().toISOString();

  const payload: AnyJobPayload = {
    jobId,
    userId: params.userId,
    agencyId: params.agencyId,
    imageId: params.imageId,
    sourceJobId: params.sourceJobId,
    parentJobId: params.parentJobId,
    sourceImageId: params.sourceImageId,
    propertyId: params.propertyId,
    type: "region-edit",
    baselineStage: params.baselineStage,
    mode: params.mode,
    editIntent: params.editIntent,
    editSourceStage: params.editSourceStage,
    prompt: params.prompt,
    currentImageUrl: params.currentImageUrl,
    baseImageUrl: params.baseImageUrl,
    mask: params.mask,
    imageIndex: params.imageIndex,
    restoreFromUrl: params.restoreFromUrl,
    stage1AReferenceUrl: params.stage1AReferenceUrl,
    createdAt: now,
  } as any;

  await queue().add(JOB_QUEUE_NAME, payload, buildQueueJobOptions(jobId));
  return { jobId };
}
