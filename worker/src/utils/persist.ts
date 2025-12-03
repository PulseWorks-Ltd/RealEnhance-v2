import { createClient } from 'redis';
import crypto from "crypto";
import {
  JobRecord,
  JobId,
  ImageRecord,
  ImageVersion,
  ImageId,
  UserId
} from "@realenhance/shared/types";

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
  // If caller is updating stageUrls, merge with existing stageUrls instead of overwriting
  if (patch && typeof patch === 'object' && patch.stageUrls) {
    try {
      const existing = rec && rec.stageUrls ? rec.stageUrls : {};
      patch = {
        ...patch,
        stageUrls: {
          ...existing,
          ...patch.stageUrls,
        },
      };
    } catch {}
  }

  rec = {
    ...rec,
    ...patch,
    updatedAt: new Date().toISOString(),
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

// Append new image version (no-op or implement Redis version if needed)
export function pushImageVersion(params: {
  imageId: ImageId;
  userId: UserId;
  stageLabel: string;
  filePath: string;
  note?: string;
}): { versionId: string } {
  // TODO: Implement Redis-based image versioning if needed
  // For now, just return a random versionId
  return { versionId: "v_" + crypto.randomUUID() };
}

export function readImageRecord(imageId: ImageId): ImageRecord | undefined {
  // TODO: Implement Redis-based image record retrieval if needed
  return undefined;
}

// convenience helper
export function getVersionPath(
  imageRecord: ImageRecord,
  versionId: string
): string | undefined {
  // TODO: Implement Redis-based version path lookup if needed
  return undefined;
}

export function getOriginalPath(imageRecord: ImageRecord): string {
  // TODO: Implement Redis-based original path lookup if needed
  return "";
}

// Set a public URL for a specific version (best-effort)
export function setVersionPublicUrl(imageId: ImageId, versionId: string, publicUrl: string) {
  // TODO: Implement Redis-based version public URL setter if needed
}
