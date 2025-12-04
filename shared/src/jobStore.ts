import { getRedis } from "./redisClient";
import { AnyJobPayload } from "./types";

const KEY_PREFIX = "jobmeta:";

function key(jobId: string): string {
  return KEY_PREFIX + jobId;
}

export async function saveJobMetadata(payload: AnyJobPayload): Promise<void> {
  const redis = getRedis() as any;
  const k = key(payload.jobId);
  const json = JSON.stringify(payload);
  await redis.set(k, json);
}

export async function getJobMetadata(jobId: string): Promise<AnyJobPayload | null> {
  const redis = getRedis() as any;
  const k = key(jobId);
  const val = await redis.get(k);
  if (!val) return null;
  try {
    return JSON.parse(val) as AnyJobPayload;
  } catch {
    return null;
  }
}
