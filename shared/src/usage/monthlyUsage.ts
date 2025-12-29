// shared/src/usage/monthlyUsage.ts
// Monthly usage tracking per agency with image-based allowances

import { getRedis } from "../redisClient.js";
import { getAgency } from "../agencies.js";
import { PLAN_LIMITS } from "../plans.js";
import type { PlanTier } from "../auth/types.js";
import { getTotalBundleRemaining, consumeBundleImages } from "./imageBundles.js";

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
 * Includes purchased bundle images in total remaining
 */
export async function getRemainingUsage(
  agencyId: string,
  monthKey: string = getCurrentMonthKey()
): Promise<UsageRemaining> {
  const usage = await getOrCreateMonthlyUsage(agencyId, monthKey);

  // Get bundle images remaining
  const bundleRemaining = await getTotalBundleRemaining(agencyId, monthKey);

  return {
    mainRemaining: Math.max(0, usage.mainAllowance - usage.mainUsed) + bundleRemaining,
    stagingRemaining: Math.max(0, usage.stagingAllowance - usage.stagingUsed),
    mainAllowance: usage.mainAllowance,
    stagingAllowance: usage.stagingAllowance,
    mainUsed: usage.mainUsed,
    stagingUsed: usage.stagingUsed,
  };
}

/**
 * Increment usage counters
 * Implements consumption order:
 * 1) Base monthly allowance
 * 2) Staging bundle (Stage 2 only)
 * 3) Purchased bundle images
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

    // Update counters based on consumption order
    if (type === "main") {
      // For main pool: Try base allowance first, then bundles
      const baseRemaining = Math.max(0, usage.mainAllowance - usage.mainUsed);

      if (baseRemaining >= amount) {
        // Consume from base allowance
        usage.mainUsed += amount;
        console.log(
          `[USAGE] ${agencyId} ${monthKey}: mainUsed +${amount} => ${usage.mainUsed} (from base allowance)`
        );
      } else {
        // Base allowance exhausted, consume from bundles
        const bundleRemaining = await getTotalBundleRemaining(agencyId, monthKey);

        if (bundleRemaining >= amount) {
          const consumed = await consumeBundleImages(agencyId, amount, monthKey);
          console.log(
            `[USAGE] ${agencyId} ${monthKey}: Consumed ${consumed} images from bundles (base exhausted)`
          );
        } else {
          // Both exhausted - this shouldn't happen if gating works correctly
          console.warn(
            `[USAGE] ${agencyId} ${monthKey}: Both base and bundles exhausted, incrementing mainUsed anyway`
          );
          usage.mainUsed += amount;
        }
      }
    } else {
      // For staging: Always increment staging counter
      usage.stagingUsed += amount;
      console.log(
        `[USAGE] ${agencyId} ${monthKey}: stagingUsed +${amount} => ${usage.stagingUsed}`
      );
    }

    usage.updatedAt = new Date().toISOString();

    // Save back to Redis
    await redis.hSet(key, "data", JSON.stringify(usage));

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
