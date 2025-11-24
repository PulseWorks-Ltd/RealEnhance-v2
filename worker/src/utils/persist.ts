import { createClient } from 'redis';
import crypto from "crypto";
import {
  JobRecord,
  JobId,
  ImageRecord,
  ImageVersion,
  ImageId,
  UserId
} from "@realenhance/shared/dist/types";

const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || "redis://localhost:6379";
const redisClient = createClient({ url: REDIS_URL });
redisClient.connect().catch(() => {});

// Update job record in Redis
export async function updateJob(jobId: JobId, patch: Partial<JobRecord> & Record<string, any>) {
  const key = `jobs:${jobId}`;
  // Read current job record
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

// Get job record from Redis
export async function getJob(jobId: JobId): Promise<JobRecord | undefined> {
  const key = `jobs:${jobId}`;
  try {
    const val = await redisClient.get(key);
    if (val) return JSON.parse(val);
  } catch {}
  return undefined;
}

// Append new image version
export function pushImageVersion(params: {
  imageId: ImageId;
  userId: UserId;
  stageLabel: string;
  filePath: string;
  note?: string;
}): { versionId: string } {
  const allImages = readJSON<Record<ImageId, ImageRecord>>("images.json", {});
  const rec = allImages[params.imageId];
  if (!rec) throw new Error("image not found");

  const versionId = "v_" + crypto.randomUUID();
  const now = new Date().toISOString();

  const v: ImageVersion = {
    versionId,
    stageLabel: params.stageLabel,
    filePath: params.filePath,
    createdAt: now,
    note: params.note
  };

  rec.history.push(v);
  rec.currentVersionId = versionId;
  rec.updatedAt = now;

  allImages[params.imageId] = rec;
  writeJSON("images.json", allImages);

  return { versionId };
}

export function readImageRecord(imageId: ImageId): ImageRecord | undefined {
  const allImages = readJSON<Record<ImageId, ImageRecord>>("images.json", {});
  return allImages[imageId];
}

// convenience helper
export function getVersionPath(
  imageRecord: ImageRecord,
  versionId: string
): string | undefined {
  const v = imageRecord.history.find(vv => vv.versionId === versionId);
  return v?.filePath;
}

export function getOriginalPath(imageRecord: ImageRecord): string {
  return imageRecord.originalPath;
}

// Set a public URL for a specific version (best-effort)
export function setVersionPublicUrl(imageId: ImageId, versionId: string, publicUrl: string) {
  const allImages = readJSON<Record<ImageId, ImageRecord>>("images.json", {});
  const rec = allImages[imageId];
  if (!rec) return;
  const idx = rec.history.findIndex(v => v.versionId === versionId);
  if (idx === -1) return;
  // attach publicUrl to that version
  (rec.history[idx] as any).publicUrl = publicUrl;
  rec.updatedAt = new Date().toISOString();
  allImages[imageId] = rec;
  writeJSON("images.json", allImages);
}
