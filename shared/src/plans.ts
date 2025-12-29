// shared/src/plans.ts
// Plan tier limits and configurations

import type { PlanTier } from "./auth/types.js";

/**
 * New image-based usage model
 * - mainAllowance: Monthly enhanced images (Stage 1 outputs)
 * - stagingAllowance: Monthly virtual staging images (Stage 2 outputs)
 * - price: Monthly cost in dollars
 */
export interface PlanLimits {
  maxSeats: number;
  mainAllowance: number;      // Monthly enhanced images
  stagingAllowance: number;   // Monthly virtual staging images (bundled)
  price: number;              // Monthly price in dollars
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  starter: {
    maxSeats: 2,
    mainAllowance: 100,
    stagingAllowance: 0,
    price: 129
  },
  pro: {
    maxSeats: 5,
    mainAllowance: 250,
    stagingAllowance: 25,
    price: 249
  },
  agency: {
    maxSeats: 10,
    mainAllowance: 500,
    stagingAllowance: 75,
    price: 399
  },
};

// Legacy name mapping: "agency" tier is now called "studio" in UI
export type PlanCode = "STARTER" | "PRO" | "STUDIO";

export function planTierToPlanCode(tier: PlanTier): PlanCode {
  if (tier === "starter") return "STARTER";
  if (tier === "pro") return "PRO";
  return "STUDIO"; // "agency" tier = "studio" in UI
}

export function planCodeToPlanTier(code: PlanCode): PlanTier {
  if (code === "STARTER") return "starter";
  if (code === "PRO") return "pro";
  return "agency"; // "STUDIO" code = "agency" tier internally
}

export function getMaxSeatsForPlan(planTier: PlanTier): number {
  return PLAN_LIMITS[planTier].maxSeats;
}

export function getMainAllowance(planTier: PlanTier): number {
  return PLAN_LIMITS[planTier].mainAllowance;
}

export function getStagingAllowance(planTier: PlanTier): number {
  return PLAN_LIMITS[planTier].stagingAllowance;
}
