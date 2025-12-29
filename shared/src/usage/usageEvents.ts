// shared/src/usage/usageEvents.ts
// Usage event tracking with fingerprinting for deduplication

import crypto from "crypto";
import { getRedis } from "../redisClient.js";
import { getCurrentMonthKey } from "./monthlyUsage.js";

export type StageType = "STAGE1" | "STAGE2";

export interface BillableUsageEvent {
  id: string;
  agencyId: string;
  userId: string;
  monthKey: string;
  stageType: StageType;
  units: number;
  fingerprint: string;
  jobId?: string;
  imageId?: string;
  createdAt: string;
}

export interface UsageFingerprintParams {
  agencyId: string;
  userId?: string;
  baseImageId?: string;
  originalUrl?: string;
  stageType: StageType;
  declutter?: boolean;
  virtualStage?: boolean;
  roomType?: string;
  stagingStyle?: string;
  sceneType?: string;
  replaceSky?: boolean;
  prompt?: string;
  maskHash?: string;
  declutterMode?: string;
  declutterStrength?: number;
  // Add any other settings that affect output
  [key: string]: any;
}

/**
 * Compute stable fingerprint for usage deduplication
 * Same parameters = same fingerprint = no double charge
 */
export function computeUsageFingerprint(params: UsageFingerprintParams): string {
  // Normalize and sort parameters for stable hashing
  const normalized: Record<string, any> = {
    agencyId: params.agencyId,
    baseImageId: params.baseImageId || params.originalUrl || "",
    stageType: params.stageType,
  };

  // Only include parameters that affect output
  if (params.declutter !== undefined) normalized.declutter = params.declutter;
  if (params.virtualStage !== undefined) normalized.virtualStage = params.virtualStage;
  if (params.roomType) normalized.roomType = params.roomType;
  if (params.stagingStyle) normalized.stagingStyle = params.stagingStyle;
  if (params.sceneType) normalized.sceneType = params.sceneType;
  if (params.replaceSky !== undefined) normalized.replaceSky = params.replaceSky;
  if (params.prompt) normalized.prompt = params.prompt.trim();
  if (params.maskHash) normalized.maskHash = params.maskHash;
  if (params.declutterMode) normalized.declutterMode = params.declutterMode;
  if (params.declutterStrength !== undefined) normalized.declutterStrength = params.declutterStrength;

  // Sort keys for stable ordering
  const sortedKeys = Object.keys(normalized).sort();
  const sortedParams: Record<string, any> = {};
  sortedKeys.forEach((key) => {
    sortedParams[key] = normalized[key];
  });

  // Create stable JSON representation
  const stableJson = JSON.stringify(sortedParams);

  // Hash to create fingerprint
  const hash = crypto.createHash("sha256").update(stableJson).digest("hex");

  return `${params.stageType}_${hash.substring(0, 16)}`;
}

/**
 * Check if usage event with this fingerprint already exists
 */
export async function usageEventExists(fingerprint: string): Promise<boolean> {
  const redis = getRedis();
  const key = `usage:event:${fingerprint}`;

  try {
    const exists = await redis.get(key);
    return exists !== null;
  } catch (err) {
    console.error("[USAGE] Error checking fingerprint existence:", err);
    // Fail-open: assume doesn't exist to avoid blocking
    return false;
  }
}

/**
 * Record a usage event
 * Returns { charged: boolean, event?: BillableUsageEvent, reason?: string }
 */
export async function recordBillableUsageEvent(
  params: {
    agencyId: string;
    userId: string;
    stageType: StageType;
    fingerprintParams: UsageFingerprintParams;
    jobId?: string;
    imageId?: string;
    units?: number;
  },
  monthKey: string = getCurrentMonthKey()
): Promise<{ charged: boolean; event?: BillableUsageEvent; reason?: string }> {
  const redis = getRedis();

  try {
    // Compute fingerprint
    const fingerprint = computeUsageFingerprint(params.fingerprintParams);

    // Check if already charged
    const exists = await usageEventExists(fingerprint);
    if (exists) {
      console.log(`[USAGE] Duplicate fingerprint ${fingerprint} - skipping charge`);
      return {
        charged: false,
        reason: "duplicate",
      };
    }

    // Create event
    const event: BillableUsageEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      agencyId: params.agencyId,
      userId: params.userId,
      monthKey,
      stageType: params.stageType,
      units: params.units || 1,
      fingerprint,
      jobId: params.jobId,
      imageId: params.imageId,
      createdAt: new Date().toISOString(),
    };

    // Store event with fingerprint as key for deduplication
    const fingerprintKey = `usage:event:${fingerprint}`;
    await redis.set(fingerprintKey, JSON.stringify(event));
    // Expire after 90 days (same as monthly usage records)
    await redis.expire(fingerprintKey, 90 * 24 * 60 * 60);

    // Also store in event list for audit trail
    const eventsKey = `agency:${params.agencyId}:events:${monthKey}`;
    await redis.lPush(eventsKey, JSON.stringify(event));
    await redis.expire(eventsKey, 90 * 24 * 60 * 60);

    console.log(`[USAGE] Recorded event ${event.id}: ${params.stageType} for ${params.agencyId}`);

    return {
      charged: true,
      event,
    };
  } catch (err) {
    console.error("[USAGE] Error recording usage event:", err);
    return {
      charged: false,
      reason: "error",
    };
  }
}

/**
 * Get usage events for an agency in a given month
 * Returns up to 1000 most recent events
 */
export async function getUsageEvents(
  agencyId: string,
  monthKey: string = getCurrentMonthKey(),
  limit: number = 1000
): Promise<BillableUsageEvent[]> {
  const redis = getRedis();
  const key = `agency:${agencyId}:events:${monthKey}`;

  try {
    const rawEvents = await redis.lRange(key, 0, limit - 1);
    if (!rawEvents || rawEvents.length === 0) {
      return [];
    }

    return rawEvents.map((raw) => JSON.parse(raw));
  } catch (err) {
    console.error("[USAGE] Error getting usage events:", err);
    return [];
  }
}
