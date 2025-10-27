import crypto from "node:crypto";
import { Queue } from "bullmq";
import {
  AnyJobPayload,
  JobRecord,
  JobId,
  UserId,
  ImageId
} from "@realenhance/shared/dist/types.js";
import { JOB_QUEUE_NAME } from "@realenhance/shared/dist/constants.js";
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
    connection: { url: REDIS_URL }
  });
}

// enhance job
export async function enqueueEnhanceJob(params: {
  userId: UserId;
  imageId: ImageId;
  options: {
    declutter: boolean;
    virtualStage: boolean;
    roomType: string;
    sceneType: string;
  };
}) {
  const jobId = "job_" + crypto.randomUUID();
  const now = new Date().toISOString();

  const payload: AnyJobPayload = {
    jobId,
    userId: params.userId,
    imageId: params.imageId,
    type: "enhance",
    options: params.options,
    createdAt: now
  } as any;

  const state = loadAll();
  state[jobId] = {
    jobId,
    userId: params.userId,
    imageId: params.imageId,
    type: "enhance",
    status: "queued",
    createdAt: now,
    updatedAt: now
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
}) {
  const jobId = "job_" + crypto.randomUUID();
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
    createdAt: now
  } as any;

  const state = loadAll();
  state[jobId] = {
    jobId,
    userId: params.userId,
    imageId: params.imageId,
    type: "edit",
    status: "queued",
    createdAt: now,
    updatedAt: now
  };
  saveAll(state);

  await queue().add(JOB_QUEUE_NAME, payload, { jobId });

  return { jobId };
}

export function getJob(jobId: string): JobRecord | undefined {
  const state = loadAll();
  return state[jobId];
}
