// region edit job
export async function enqueueRegionEditJob(params: {
  userId: UserId;
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
    imageId: params.imageId,
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
import * as crypto from "node:crypto";
import { Queue } from "bullmq";
import type {
  AnyJobPayload,
  JobRecord,
  JobId,
  UserId,
  ImageId,
  JobKind,            // ⬅️ import JobKind from shared types
} from "../shared/types.js";
import { JOB_QUEUE_NAME } from "../shared/constants.js";
import { createClient } from 'redis';
import { saveJobMetadata } from "@realenhance/shared/imageStore";
import { normalizeStageLabel, resolveStageUrl } from "@realenhance/shared/stageUrlResolver";
import type { JobOwnershipMetadata, RequestedStages } from "@realenhance/shared/types/jobMetadata";

const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || "redis://localhost:6379";
const redisClient = createClient({ url: REDIS_URL });
redisClient.connect().catch(() => {});

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
}

export async function getJob(jobId: string): Promise<JobRecord | undefined> {
  const key = `jobs:${jobId}`;
  try {
    const val = await redisClient.get(key);
    if (val) return JSON.parse(val);
  } catch {}
  return undefined;
}

function queue() {
  return new Queue(JOB_QUEUE_NAME, {
    connection: { url: REDIS_URL },
  });
}

// enhance job
export async function enqueueEnhanceJob(params: {
  userId: UserId;
  imageId: ImageId;
  agencyId?: string | null; // Optional: agency ID for usage billing
  remoteOriginalUrl?: string; // S3 URL of original if uploaded
  remoteOriginalKey?: string; // S3 key of original if uploaded
  retryInfo?: {
    retryType?: "manual_retry";
    sourceStage?: string | null;
    sourceUrl?: string | null;
    sourceKey?: string | null;
    stage1BWasRequested?: boolean;
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
    replaceSky?: boolean;  // Sky replacement toggle
    manualSceneOverride?: boolean; // Manual scene override flag (client -> server -> worker)
    scenePrediction?: {  // Client-side scene prediction for SKY_SAFE forcing
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
  // ✅ Smart Stage-2-only retry mode
  stage2OnlyMode?: {
    enabled: boolean;
    base1BUrl: string;
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
    agencyId: params.agencyId, // Pass agencyId to worker for billing
    options: params.options,
    createdAt: now,
    // add non-typed extension field for worker consumption
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
    retryParentImageId: params.retryInfo?.parentImageId,
    retryParentJobId: params.retryInfo?.parentJobId,
    retryClientBatchId: params.retryInfo?.clientBatchId,
    // ✅ Pass stage2OnlyMode to worker
    stage2OnlyMode: params.stage2OnlyMode as any,
  } as any;

  await Promise.all([
    queue().add(JOB_QUEUE_NAME, payload, { jobId }),
    saveJobMetadata(jobMeta),
    updateJob(jobId, { status: "queued", metadata: jobMeta }),
  ]);
  return { jobId };
}


// edit job
export async function enqueueEditJob(params: {
  userId: UserId;
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
    imageId: params.imageId,
    type: "edit",
    baseVersionId: params.baseVersionId,
    mode: params.mode,
    instruction: params.instruction,
    mask: params.mask,
    createdAt: now,
    ...(params.remoteBaseUrl ? { remoteBaseUrl: params.remoteBaseUrl } : {}),
    ...(params.remoteRestoreUrl ? { remoteRestoreUrl: params.remoteRestoreUrl } : {}),
    ...(params.allowStaging !== undefined ? { allowStaging: params.allowStaging } : {}),
    ...(params.stagingStyle ? { stagingStyle: params.stagingStyle } : {}),
  } as any;



  await queue().add(JOB_QUEUE_NAME, payload, { jobId });
  return { jobId };
}

// (Legacy getJob removed; now async and Redis-based)
