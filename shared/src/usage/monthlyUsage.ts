// shared/src/usage/monthlyUsage.ts
// Monthly usage tracking per agency with image-based allowances

import { getRedis } from "../redisClient.js";
import { getAgency } from "../agencies.js";
import { PLAN_LIMITS } from "../plans.js";
import type { PlanTier } from "../auth/types.js";

export interface AgencyUsageMonthly {
  agencyId: string;
  monthKey: string; // Format: YYYY-MM
  mainAllowance: number;
  stagingAllowance: number;
  mainUsed: number;
  stagingUsed: number;
  createdAt: string;
  updatedAt: string;
}

export interface UsageRemaining {
  mainRemaining: number;
  stagingRemaining: number;
  mainAllowance: number;
  stagingAllowance: number;
  mainUsed: number;
  stagingUsed: number;
}

/**
 * Get current month key in NZ timezone (Pacific/Auckland)
 */
export function getCurrentMonthKey(): string {
  const now = new Date();
  // Convert to NZ timezone
  const nzTime = new Date(now.toLocaleString("en-US", { timeZone: "Pacific/Auckland" }));
  const year = nzTime.getFullYear();
  const month = String(nzTime.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Get month key for a specific date in NZ timezone
 */
export function getMonthKeyForDate(date: Date): string {
  const nzTime = new Date(date.toLocaleString("en-US", { timeZone: "Pacific/Auckland" }));
  const year = nzTime.getFullYear();
  const month = String(nzTime.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Get or create monthly usage record for an agency
 */
export async function getOrCreateMonthlyUsage(
  agencyId: string,
  monthKey: string = getCurrentMonthKey()
): Promise<AgencyUsageMonthly> {
  const redis = getRedis();
  const key = `agency:${agencyId}:usage:${monthKey}`;

  try {
    // Try to get existing record
    const existing = await redis.hGet(key, "data");
    if (existing) {
      return JSON.parse(existing);
    }

    // Create new record with agency's current plan allowances
    const agency = await getAgency(agencyId);
    if (!agency) {
      throw new Error(`Agency ${agencyId} not found`);
    }

    const planLimits = PLAN_LIMITS[agency.planTier as PlanTier];
    const now = new Date().toISOString();

    const newRecord: AgencyUsageMonthly = {
      agencyId,
      monthKey,
      mainAllowance: planLimits.mainAllowance,
      stagingAllowance: planLimits.stagingAllowance,
      mainUsed: 0,
      stagingUsed: 0,
      createdAt: now,
      updatedAt: now,
    };

    await redis.hSet(key, "data", JSON.stringify(newRecord));
    // Set expiry to 90 days (keep 3 months of history)
    await redis.expire(key, 90 * 24 * 60 * 60);

    console.log(`[USAGE] Created new monthly usage record for ${agencyId} ${monthKey}`);
    return newRecord;
  } catch (err) {
    console.error("[USAGE] Error getting/creating monthly usage:", err);
    // Fail-open: return default record
    const planLimits = PLAN_LIMITS.starter; // Default to starter if error
    return {
      agencyId,
      monthKey,
      mainAllowance: planLimits.mainAllowance,
      stagingAllowance: planLimits.stagingAllowance,
      mainUsed: 0,
      stagingUsed: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Get remaining usage for an agency
 */
export async function getRemainingUsage(
  agencyId: string,
  monthKey: string = getCurrentMonthKey()
): Promise<UsageRemaining> {
  const usage = await getOrCreateMonthlyUsage(agencyId, monthKey);

  return {
    mainRemaining: Math.max(0, usage.mainAllowance - usage.mainUsed),
    stagingRemaining: Math.max(0, usage.stagingAllowance - usage.stagingUsed),
    mainAllowance: usage.mainAllowance,
    stagingAllowance: usage.stagingAllowance,
    mainUsed: usage.mainUsed,
    stagingUsed: usage.stagingUsed,
  };
}

/**
 * Increment usage counters
 * Returns new usage counts
 */
export async function incrementUsage(
  agencyId: string,
  type: "main" | "staging",
  amount: number = 1,
  monthKey: string = getCurrentMonthKey()
): Promise<AgencyUsageMonthly> {
  const redis = getRedis();
  const key = `agency:${agencyId}:usage:${monthKey}`;

  try {
    // Get current usage
    const usage = await getOrCreateMonthlyUsage(agencyId, monthKey);

    // Update counters
    if (type === "main") {
      usage.mainUsed += amount;
    } else {
      usage.stagingUsed += amount;
    }
    usage.updatedAt = new Date().toISOString();

    // Save back to Redis
    await redis.hSet(key, "data", JSON.stringify(usage));

    console.log(
      `[USAGE] ${agencyId} ${monthKey}: ${type}Used +${amount} => ${type === "main" ? usage.mainUsed : usage.stagingUsed}`
    );

    return usage;
  } catch (err) {
    console.error("[USAGE] Error incrementing usage:", err);
    // Fail-open: return current state
    return await getOrCreateMonthlyUsage(agencyId, monthKey);
  }
}

/**
 * Check if agency has exhausted usage
 */
export async function isUsageExhausted(
  agencyId: string,
  monthKey: string = getCurrentMonthKey()
): Promise<{ exhausted: boolean; mainRemaining: number; stagingRemaining: number }> {
  const remaining = await getRemainingUsage(agencyId, monthKey);

  return {
    exhausted: remaining.mainRemaining <= 0,
    mainRemaining: remaining.mainRemaining,
    stagingRemaining: remaining.stagingRemaining,
  };
}

/**
 * Check if agency can run Stage 2 (virtual staging)
 * Stage 2 can run if either staging bundle OR main pool has remaining units
 */
export async function canRunStage2(
  agencyId: string,
  monthKey: string = getCurrentMonthKey()
): Promise<{ allowed: boolean; willUseStagingBundle: boolean; mainRemaining: number; stagingRemaining: number }> {
  const remaining = await getRemainingUsage(agencyId, monthKey);

  const willUseStagingBundle = remaining.stagingRemaining > 0;
  const allowed = willUseStagingBundle || remaining.mainRemaining > 0;

  return {
    allowed,
    willUseStagingBundle,
    mainRemaining: remaining.mainRemaining,
    stagingRemaining: remaining.stagingRemaining,
  };
}
