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
 * Get billing-cycle key (aligned to Stripe period) when available; otherwise fall back to calendar month key.
 * Uses agency.currentPeriodStart if present; formats as YYYY-MM-DD for uniqueness across mid-month renewals.
 */
export async function getCurrentBillingCycleKey(agencyId: string): Promise<string> {
  try {
    const agency = await getAgency(agencyId);
    if (agency?.currentPeriodStart) {
      return agency.currentPeriodStart.slice(0, 10);
    }
  } catch (err) {
    console.warn(`[USAGE] Billing cycle key fallback for ${agencyId}:`, err);
  }
  return getCurrentMonthKey();
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
      // Extras-first: consume bundles before touching monthly allowance
      let remainingToCharge = amount;

      const bundleRemaining = await getTotalBundleRemaining(agencyId, monthKey);
      if (bundleRemaining > 0) {
        const consumeFromBundles = Math.min(bundleRemaining, remainingToCharge);
        const consumed = await consumeBundleImages(agencyId, consumeFromBundles, monthKey);
        remainingToCharge -= consumed;
        console.log(
          `[USAGE] ${agencyId} ${monthKey}: Consumed ${consumed} from bundles (remainingToCharge=${remainingToCharge})`
        );
      }

      if (remainingToCharge > 0) {
        const baseRemaining = Math.max(0, usage.mainAllowance - usage.mainUsed);
        const consumeFromBase = Math.min(baseRemaining, remainingToCharge);
        usage.mainUsed += consumeFromBase;
        remainingToCharge -= consumeFromBase;
        if (consumeFromBase > 0) {
          console.log(
            `[USAGE] ${agencyId} ${monthKey}: mainUsed +${consumeFromBase} => ${usage.mainUsed} (from monthly allowance)`
          );
        }
      }

      // If still remaining, allow soft overage to avoid job failure; log for audit
      if (remainingToCharge > 0) {
        usage.mainUsed += remainingToCharge;
        console.warn(
          `[USAGE] ${agencyId} ${monthKey}: allowance exhausted; overage recorded +${remainingToCharge}`
        );
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
