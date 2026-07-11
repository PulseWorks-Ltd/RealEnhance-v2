import { createClient } from 'redis';
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  JobRecord,
  JobId,
  ImageRecord,
  ImageVersion,
  ImageId,
  UserId
} from "@realenhance/shared/types";
import { mergeStageUrls, resolveStageUrl } from "@realenhance/shared/stageUrlResolver";

const STAGE1B_TRACE = process.env.STAGE1B_TRACE === "1";

function resolveStage1BValue(stageUrls: any): string | null {
  if (!stageUrls || typeof stageUrls !== "object") return null;
  return (
    resolveStageUrl(stageUrls as any, "1B") ||
    (typeof stageUrls["1B"] === "string" && stageUrls["1B"].trim() ? String(stageUrls["1B"]).trim() : null) ||
    (typeof stageUrls.stage1B === "string" && stageUrls.stage1B.trim() ? String(stageUrls.stage1B).trim() : null) ||
    (typeof stageUrls["1b"] === "string" && stageUrls["1b"].trim() ? String(stageUrls["1b"]).trim() : null)
  );
}

function inferCaller(): string {
  try {
    const stack = String(new Error().stack || "").split("\n");
    const line = stack.find((entry) =>
      entry.includes("/worker/src/") &&
      !entry.includes("persist.ts")
    );
    return line ? line.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

function logStage1BWrite(params: {
  op: "updateJob" | "updateJobIf";
  jobId: JobId;
  previousValue: string | null;
  nextValue: string | null;
  reason: string;
  caller: string;
  patchKeys: string[];
}) {
  if (!STAGE1B_TRACE) return;
  console.log("[STAGE1B_WRITE_TRACE]", {
    ts: new Date().toISOString(),
    op: params.op,
    jobId: params.jobId,
    previousValue: params.previousValue,
    nextValue: params.nextValue,
    reason: params.reason,
    caller: params.caller,
    patchKeys: params.patchKeys,
  });
}

function logMergedStageUrls(jobId: JobId, stageUrls: Record<string, string | null | undefined>) {
  console.log("[STAGE_URLS_WRITE]", { jobId, stageUrls });
  const stage1AUrl = resolveStageUrl(stageUrls as any, "1A");
  const stage2Url = resolveStageUrl(stageUrls as any, "2");
  if (stage1AUrl && stage2Url && stage1AUrl === stage2Url) {
    console.error("🚨 STAGE COLLAPSE DETECTED", { jobId, stageUrls });
  }
}

const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || "redis://localhost:6379";
const redisClient = createClient({
  url: REDIS_URL,
  socket: {
    reconnectStrategy: false,
  },
});
const LOCAL_CACHE_DIR = process.env.REALENHANCE_CACHE_DIR || path.join(os.tmpdir(), "realenhance-worker-cache");

// CRITICAL: Handle Redis connection errors properly
redisClient.on('error', (err) => {
  console.error('[Redis] Connection error:', err);
});

redisClient.on('reconnecting', () => {
  console.log('[Redis] Reconnecting...');
});

redisClient.on('ready', () => {
  console.log('[Redis] Connection ready');
});

redisClient.connect().catch((err) => {
  console.error('[Redis] Failed to connect:', err);
  // Don't exit - allow retry
});

// Update job record in Redis
export async function updateJob(jobId: JobId, patch: Partial<JobRecord> & Record<string, any>) {
  const key = `jobs:${jobId}`;
  // Read current job record
  let rec: any = {};
  try {
    const val = await redisClient.get(key);
    if (val) rec = JSON.parse(val);
  } catch (readErr) {
    console.error(`[updateJob] Failed to read job ${jobId}:`, readErr);
    // Continue with empty record
  }
  
  const stageUrlReason = String((patch as any)?.__stageUrlReason || "unspecified");
  const stageUrlCaller = String((patch as any)?.__stageUrlCaller || inferCaller());
  const previousStage1B = resolveStage1BValue(rec?.stageUrls || null);

  // If caller is updating stageUrls, merge with existing stageUrls instead of overwriting
  if (patch && typeof patch === 'object' && patch.stageUrls) {
    try {
      const existing = rec && rec.stageUrls ? rec.stageUrls : {};
      patch = {
        ...patch,
        stageUrls: mergeStageUrls(existing, patch.stageUrls),
      };
      logMergedStageUrls(jobId, patch.stageUrls as Record<string, string | null | undefined>);
    } catch (mergeErr) {
      console.error(`[updateJob] Failed to merge stageUrls for job ${jobId}:`, mergeErr);
    }
  }

  const nextStage1B = resolveStage1BValue((patch as any)?.stageUrls || rec?.stageUrls || null);
  if (patch && typeof patch === "object" && Object.prototype.hasOwnProperty.call(patch, "stageUrls")) {
    logStage1BWrite({
      op: "updateJob",
      jobId,
      previousValue: previousStage1B,
      nextValue: nextStage1B,
      reason: stageUrlReason,
      caller: stageUrlCaller,
      patchKeys: Object.keys(patch),
    });
  }

  if (patch && typeof patch === "object") {
    delete (patch as any).__stageUrlReason;
    delete (patch as any).__stageUrlCaller;
  }

  rec = {
    ...rec,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  
  // CRITICAL: Don't silently fail - throw if Redis write fails
  try {
    await redisClient.set(key, JSON.stringify(rec));
  } catch (writeErr) {
    console.error(`[updateJob] Failed to write job ${jobId} to Redis:`, writeErr);
    throw new Error(`Redis write failed for job ${jobId}: ${writeErr}`);
  }
}

export async function updateJobIf(
  jobId: JobId,
  patch: Partial<JobRecord> & Record<string, any>,
  predicate: (current: any) => boolean,
  maxRetries: number = 5
): Promise<{ updated: boolean; current: any }> {
  const key = `jobs:${jobId}`;
  let attempts = 0;

  const isWatchError = (err: any): boolean => {
    const name = String(err?.name || "").toLowerCase();
    const message = String(err?.message || "").toLowerCase();
    return name === "watcherror" || message.includes("watched keys has been changed");
  };

  const waitForRetryJitter = async () => {
    const delayMs = 10 + Math.floor(Math.random() * 41); // 10-50ms jitter
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  };

  while (attempts < maxRetries) {
    attempts += 1;
    try {
      await redisClient.watch(key);

      const raw = await redisClient.get(key);
      let current: any = {};
      if (raw) {
        try {
          current = JSON.parse(raw);
        } catch (parseErr) {
          console.error(`[updateJobIf] Failed to parse existing job ${jobId}:`, parseErr);
          current = {};
        }
      }

      if (!predicate(current)) {
        await redisClient.unwatch();
        return { updated: false, current };
      }

      let mergedPatch: any = patch;
      const stageUrlReason = String((mergedPatch as any)?.__stageUrlReason || "unspecified");
      const stageUrlCaller = String((mergedPatch as any)?.__stageUrlCaller || inferCaller());
      const previousStage1B = resolveStage1BValue(current?.stageUrls || null);
      if (mergedPatch && typeof mergedPatch === "object" && mergedPatch.stageUrls) {
        try {
          const existing = current && current.stageUrls ? current.stageUrls : {};
          mergedPatch = {
            ...mergedPatch,
            stageUrls: mergeStageUrls(existing, mergedPatch.stageUrls),
          };
          logMergedStageUrls(jobId, mergedPatch.stageUrls as Record<string, string | null | undefined>);
        } catch (mergeErr) {
          console.error(`[updateJobIf] Failed to merge stageUrls for job ${jobId}:`, mergeErr);
        }
      }

      const nextStage1B = resolveStage1BValue(mergedPatch?.stageUrls || current?.stageUrls || null);
      if (mergedPatch && typeof mergedPatch === "object" && Object.prototype.hasOwnProperty.call(mergedPatch, "stageUrls")) {
        logStage1BWrite({
          op: "updateJobIf",
          jobId,
          previousValue: previousStage1B,
          nextValue: nextStage1B,
          reason: stageUrlReason,
          caller: stageUrlCaller,
          patchKeys: Object.keys(mergedPatch),
        });
      }

      if (mergedPatch && typeof mergedPatch === "object") {
        delete mergedPatch.__stageUrlReason;
        delete mergedPatch.__stageUrlCaller;
      }

      if (mergedPatch && typeof mergedPatch === "object" && mergedPatch.validatorMeta) {
        try {
          const existingValidatorMeta = current && current.validatorMeta ? current.validatorMeta : {};
          mergedPatch = {
            ...mergedPatch,
            validatorMeta: {
              ...existingValidatorMeta,
              ...mergedPatch.validatorMeta,
            },
          };
        } catch (validatorMergeErr) {
          console.error(`[updateJobIf] Failed to merge validatorMeta for job ${jobId}:`, validatorMergeErr);
        }
      }

      const next = {
        ...current,
        ...mergedPatch,
        updatedAt: new Date().toISOString(),
      };

      const tx = redisClient.multi();
      tx.set(key, JSON.stringify(next));
      const execResult = await tx.exec();

      if (execResult === null) {
        // Key changed after WATCH; retry.
        continue;
      }

      return { updated: true, current: next };
    } catch (err) {
      console.error(`[updateJobIf] Failed guarded update for job ${jobId}:`, err);
      try {
        await redisClient.unwatch();
      } catch {}

      // WatchError means optimistic-lock contention, not processing failure.
      // Retry until retry budget is exhausted.
      if (isWatchError(err) && attempts < maxRetries) {
        await waitForRetryJitter();
        continue;
      }

      throw err;
    }
  }

  throw new Error(`updateJobIf failed for job ${jobId}: exceeded retry budget`);
}

export async function getRedisJson<T = unknown>(key: string): Promise<T | undefined> {
  if (!redisClient.isOpen || !redisClient.isReady) {
    return readLocalCacheJson<T>(key);
  }
  try {
    const val = await redisClient.get(key);
    if (!val) return undefined;
    return JSON.parse(val) as T;
  } catch (err) {
    console.error(`[getRedisJson] Failed to read ${key}:`, err);
    return readLocalCacheJson<T>(key);
  }
}

export async function setRedisJson(key: string, value: unknown): Promise<void> {
  if (!redisClient.isOpen || !redisClient.isReady) {
    await writeLocalCacheJson(key, value);
    return;
  }
  try {
    await redisClient.set(key, JSON.stringify(value));
  } catch (err) {
    console.error(`[setRedisJson] Failed to write ${key}:`, err);
    await writeLocalCacheJson(key, value);
  }
}

function localCachePath(key: string): string {
  const safeKey = key.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(LOCAL_CACHE_DIR, `${safeKey}.json`);
}

async function readLocalCacheJson<T = unknown>(key: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(localCachePath(key), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function writeLocalCacheJson(key: string, value: unknown): Promise<void> {
  try {
    await fs.mkdir(LOCAL_CACHE_DIR, { recursive: true });
    await fs.writeFile(localCachePath(key), JSON.stringify(value), "utf8");
  } catch (err) {
    console.error(`[writeLocalCacheJson] Failed to write ${key}:`, err);
  }
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
