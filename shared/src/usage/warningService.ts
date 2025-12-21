// shared/src/usage/warningService.ts
// Soft warning service for agency plan limits (never blocks execution)

import { getAgency } from "../agencyStore.js";
import { getAgencyRollup, storeWarning } from "./usageStore.js";
import { UsageWarning } from "./types.js";

/**
 * Check if an agency should receive warnings based on their usage
 * This is called after recording events, but never blocks jobs
 */
export async function checkAndWarnAgency(agencyId: string, month?: string): Promise<UsageWarning[]> {
  try {
    const agency = await getAgency(agencyId);
    if (!agency) {
      return [];
    }

    const rollup = await getAgencyRollup(agencyId, month);
    if (!rollup) {
      return [];
    }

    const warnings: UsageWarning[] = [];
    const targetMonth = month || getCurrentMonth();
    const thresholdPct = agency.warningThresholdPct ?? 0.9;

    // Check listing limit
    if (agency.monthlyListingLimit && agency.monthlyListingLimit > 0) {
      const used = rollup.listings;
      const limit = agency.monthlyListingLimit;

      if (used >= limit) {
        // Over limit
        const warning: UsageWarning = {
          agencyId,
          month: targetMonth,
          kind: "over_limit",
          metric: "listings",
          used,
          limit,
          thresholdPct,
          createdAt: new Date().toISOString(),
        };
        warnings.push(warning);
        await storeWarning(warning);
      } else if (used >= limit * thresholdPct) {
        // Approaching limit
        const warning: UsageWarning = {
          agencyId,
          month: targetMonth,
          kind: "approaching_limit",
          metric: "listings",
          used,
          limit,
          thresholdPct,
          createdAt: new Date().toISOString(),
        };
        warnings.push(warning);
        await storeWarning(warning);
      }
    }

    // Check image limit
    if (agency.monthlyImageLimit && agency.monthlyImageLimit > 0) {
      const used = rollup.images;
      const limit = agency.monthlyImageLimit;

      if (used >= limit) {
        // Over limit
        const warning: UsageWarning = {
          agencyId,
          month: targetMonth,
          kind: "over_limit",
          metric: "images",
          used,
          limit,
          thresholdPct,
          createdAt: new Date().toISOString(),
        };
        warnings.push(warning);
        await storeWarning(warning);
      } else if (used >= limit * thresholdPct) {
        // Approaching limit
        const warning: UsageWarning = {
          agencyId,
          month: targetMonth,
          kind: "approaching_limit",
          metric: "images",
          used,
          limit,
          thresholdPct,
          createdAt: new Date().toISOString(),
        };
        warnings.push(warning);
        await storeWarning(warning);
      }
    }

    if (warnings.length > 0) {
      console.log(`[USAGE WARNING] Agency ${agencyId} has ${warnings.length} warning(s)`);
    }

    return warnings;
  } catch (err) {
    console.error("[USAGE WARNING] Failed to check warnings (non-blocking):", err);
    return [];
  }
}

/**
 * Get current month in YYYY-MM format
 */
function getCurrentMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}
