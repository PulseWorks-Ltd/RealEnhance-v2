// shared/src/plans.ts
// Plan tier limits and configurations

import type { PlanTier } from "./auth/types.js";

/**
 * Image-based usage model (NO SEAT LIMITS - unlimited users per agency)
 * - mainAllowance: Monthly enhanced images (Stage 1 outputs)
 * - stagingAllowance: Monthly virtual staging images (Stage 2 outputs)
 * - price: Monthly cost in dollars (paid via direct debit, not Stripe)
 * - retentionLimit: Maximum number of images retained per agency (rolling deletion)
 */
export interface PlanLimits {
  mainAllowance: number;      // Monthly enhanced images
  stagingAllowance: number;   // Monthly virtual staging images (bundled)
  price: number;              // Monthly price in dollars
  retentionLimit: number;     // Maximum retained images (oldest deleted when exceeded)
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  starter: {
    mainAllowance: 100,
    stagingAllowance: 0,
    price: 129,
    retentionLimit: 300
  },
  pro: {
    mainAllowance: 250,
    stagingAllowance: 0,
    price: 249,
    retentionLimit: 800
  },
  agency: {
    mainAllowance: 600,
    stagingAllowance: 0,
    price: 499, // NZD base price
    retentionLimit: 2000
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

export function getMainAllowance(planTier: PlanTier): number {
  return PLAN_LIMITS[planTier].mainAllowance;
}

export function getStagingAllowance(planTier: PlanTier): number {
  return PLAN_LIMITS[planTier].stagingAllowance;
}

export function getRetentionLimit(planTier: PlanTier): number {
  return PLAN_LIMITS[planTier].retentionLimit;
}
