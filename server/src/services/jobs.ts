// region edit job
export async function enqueueRegionEditJob(params: {
  userId: UserId;
  mode: "add" | "remove" | "restore";
  prompt?: string;
  currentImageUrl: string;
  baseImageUrl?: string;
  maskPath: string;
  imageIndex?: number;
}) {
  const jobId: JobId = "job_" + crypto.randomUUID();
  const now = new Date().toISOString();

  const payload: AnyJobPayload = {
    jobId,
    userId: params.userId,
    type: "region-edit",
    mode: params.mode,
    prompt: params.prompt,
    currentImageUrl: params.currentImageUrl,
    baseImageUrl: params.baseImageUrl,
    maskPath: params.maskPath,
    imageIndex: params.imageIndex,
    createdAt: now,
  } as any;

  const state = loadAll();
  state[jobId] = {
    id: jobId,
    jobId,
    userId: params.userId,
    type: "region-edit",
    status: "queued",
    payload,
    createdAt: now,
    updatedAt: now,
  };
  saveAll(state);

  await queue().add(JOB_QUEUE_NAME, payload, { jobId });
  // Simulate immediate result for now
  return { jobId, imageUrl: `/api/images/${jobId}.webp` };
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
import { REDIS_URL } from "../config.js";
import { readJsonFile, writeJsonFile } from "./jsonStore.js";

type JobsState = Record<JobId, JobRecord>;

function loadAll(): JobsState {
  return readJsonFile<JobsState>("jobs.json", {});
}
function saveAll(state: JobsState) {
  writeJsonFile("jobs.json", state);
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
  remoteOriginalUrl?: string; // S3 URL of original if uploaded
  options: {
    declutter: boolean;
    virtualStage: boolean;
    roomType: string;
    sceneType: string;
    replaceSky?: boolean;  // Sky replacement toggle
    sampling?: {
      temperature?: number;
      topP?: number;
      topK?: number;
    };
    declutterIntensity?: "light" | "standard" | "heavy";
  };
}) {
  const jobId: JobId = "job_" + crypto.randomUUID();
  const now = new Date().toISOString();

  const payload: AnyJobPayload = {
    jobId,
    userId: params.userId,
    imageId: params.imageId,
    type: "enhance",
    options: params.options,
    createdAt: now,
    // add non-typed extension field for worker consumption
    remoteOriginalUrl: params.remoteOriginalUrl as any,
  } as any;

  const state = loadAll();
  state[jobId] = {
    id: jobId,                // ⬅️ ensure `id` is present
    jobId,                    // optional duplicate for compatibility
    userId: params.userId,
    imageId: params.imageId,
    type: "enhance",
    status: "queued",
  payload,                  // ⬅️ persist payload for visibility (includes remoteOriginalUrl optional)
    createdAt: now,
    updatedAt: now,
  };
  saveAll(state);

  await queue().add(JOB_QUEUE_NAME, payload, { jobId });
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

  const state = loadAll();
  state[jobId] = {
    id: jobId,                // ⬅️ ensure `id`
    jobId,
    userId: params.userId,
    imageId: params.imageId,
    type: "edit",
    status: "queued",
    payload,                  // ⬅️ persist payload
    createdAt: now,
    updatedAt: now,
  };
  saveAll(state);

  await queue().add(JOB_QUEUE_NAME, payload, { jobId });
  return { jobId };
}

export function getJob(jobId: string): JobRecord | undefined {
  const state = loadAll();
  return state[jobId];
}
