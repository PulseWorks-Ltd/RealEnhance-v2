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
  } as any;

  return { jobId, now, jobMeta, payload };
}

// enhance job
export async function enqueueEnhanceJob(params: {
  userId: UserId;
  imageId: ImageId;
  agencyId?: string | null;
  propertyId?: string | null;
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
}, jobIdOverride?: JobId) {
  const { jobId, jobMeta, payload } = buildEnhanceArtifacts(params, jobIdOverride);

  await Promise.all([
    queue().add(JOB_QUEUE_NAME, payload, { jobId }),
    saveJobMetadata(jobMeta),
    updateJob(jobId, {
      id: jobId,
      jobId,
      type: "enhance",
      userId: params.userId,
      imageId: params.imageId,
      status: "queued",
      payload,
      metadata: jobMeta,
      createdAt: payload.createdAt,
    }),
  ]);
  return { jobId };
}

export async function createAwaitingPaymentEnhanceJob(params: {
  userId: UserId;
  imageId: ImageId;
  agencyId?: string | null;
  propertyId?: string | null;
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
}, jobIdOverride?: JobId) {
  const { jobId, jobMeta, payload } = buildEnhanceArtifacts(params, jobIdOverride);

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
      metadata: jobMeta,
      createdAt: payload.createdAt,
    }),
  ]);

  return { jobId };
}

export async function enqueueStoredEnhanceJob(jobId: string): Promise<{ enqueued: boolean }> {
  const rec = await getJob(jobId);
  const payload = (rec as any)?.payload;
  if (!payload || payload.type !== "enhance") {
    return { enqueued: false };
  }

  const q = queue();
  const existing = await q.getJob(jobId);
  if (!existing) {
    await q.add(JOB_QUEUE_NAME, payload, { jobId });
  }

  await updateJob(jobId, { status: "queued" });
  return { enqueued: true };
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

  await queue().add(JOB_QUEUE_NAME, payload, { jobId });
  return { jobId };
}

// region edit job
export async function enqueueRegionEditJob(params: {
  userId: UserId;
  agencyId?: string;
  propertyId?: string;
  sourceImageId?: string;
  imageId?: ImageId;
  mode: "add" | "remove" | "restore" | "replace";
  prompt?: string;
  currentImageUrl: string;
  baseImageUrl?: string;
  mask: string;
  imageIndex?: number;
  restoreFromUrl?: string;
}) {
  const jobId: JobId = "job_" + crypto.randomUUID();
  const now = new Date().toISOString();

  const payload: AnyJobPayload = {
    jobId,
    userId: params.userId,
    agencyId: params.agencyId,
    imageId: params.imageId,
    sourceImageId: params.sourceImageId,
    propertyId: params.propertyId,
    type: "region-edit",
    mode: params.mode,
    prompt: params.prompt,
    currentImageUrl: params.currentImageUrl,
    baseImageUrl: params.baseImageUrl,
    mask: params.mask,
    imageIndex: params.imageIndex,
    restoreFromUrl: params.restoreFromUrl,
    createdAt: now,
  } as any;

  await queue().add(JOB_QUEUE_NAME, payload, { jobId });
  return { jobId };
}
