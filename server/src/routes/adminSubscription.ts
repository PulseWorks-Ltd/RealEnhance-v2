// server/src/routes/adminSubscription.ts
// Admin-only subscription management (protected by API key)

import { Router, type Request, type Response } from "express";
import { getAgency, updateAgency, updateAgencySubscriptionStatus } from "@realenhance/shared/agencies.js";
import type { SubscriptionStatus, PlanTier } from "@realenhance/shared/auth/types.js";

const router = Router();

/**
 * Middleware to require admin API key
 */
function requireAdminApiKey(req: Request, res: Response, next: Function) {
  const apiKey = req.headers["x-admin-api-key"];
  const expectedKey = process.env.ADMIN_API_KEY;

  if (!expectedKey) {
    console.error("[ADMIN] ADMIN_API_KEY not configured");
    return res.status(503).json({ error: "Admin API not configured" });
  }

  if (!apiKey || apiKey !== expectedKey) {
    console.warn("[ADMIN] Unauthorized admin API access attempt");
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

/**
 * GET /internal/admin/agencies/:agencyId
 * Get agency details including subscription status
 */
router.get("/agencies/:agencyId", requireAdminApiKey, async (req: Request, res: Response) => {
  try {
    const { agencyId } = req.params;

    const agency = await getAgency(agencyId);
    if (!agency) {
      return res.status(404).json({ error: "Agency not found" });
    }

    res.json({ agency });
  } catch (err) {
    console.error("[ADMIN] Get agency error:", err);
    res.status(500).json({ error: "Failed to get agency" });
  }
});

/**
 * POST /internal/admin/agencies/:agencyId/subscription
 * Update agency subscription status and plan
 */
router.post("/agencies/:agencyId/subscription", requireAdminApiKey, async (req: Request, res: Response) => {
  try {
    const { agencyId } = req.params;
    const { subscriptionStatus, planTier, currentPeriodStart, currentPeriodEnd } = req.body;

    const agency = await getAgency(agencyId);
    if (!agency) {
      return res.status(404).json({ error: "Agency not found" });
    }

    // Validate subscription status
    const validStatuses: SubscriptionStatus[] = ["ACTIVE", "PAST_DUE", "CANCELLED", "TRIAL"];
    if (subscriptionStatus && !validStatuses.includes(subscriptionStatus)) {
      return res.status(400).json({
        error: "Invalid subscription status",
        validStatuses,
      });
    }

    // Validate plan tier
    const validTiers: PlanTier[] = ["starter", "pro", "agency"];
    if (planTier && !validTiers.includes(planTier)) {
      return res.status(400).json({
        error: "Invalid plan tier",
        validTiers,
      });
    }

    // Update fields
    if (subscriptionStatus) {
      agency.subscriptionStatus = subscriptionStatus;
    }
    if (planTier) {
      agency.planTier = planTier;
    }
    if (currentPeriodStart) {
      agency.currentPeriodStart = currentPeriodStart;
    }
    if (currentPeriodEnd) {
      agency.currentPeriodEnd = currentPeriodEnd;
    }

    await updateAgency(agency);

    // Audit log
    console.log(`[ADMIN] Updated subscription for agency ${agencyId}:`, {
      subscriptionStatus: agency.subscriptionStatus,
      planTier: agency.planTier,
      currentPeriodStart: agency.currentPeriodStart,
      currentPeriodEnd: agency.currentPeriodEnd,
      updatedAt: agency.updatedAt,
    });

    res.json({
      success: true,
      agency,
    });
  } catch (err) {
    console.error("[ADMIN] Update subscription error:", err);
    res.status(500).json({ error: "Failed to update subscription" });
  }
});

/**
 * POST /internal/admin/agencies/:agencyId/activate
 * Quick helper to activate a subscription
 */
router.post("/agencies/:agencyId/activate", requireAdminApiKey, async (req: Request, res: Response) => {
  try {
    const { agencyId } = req.params;

    await updateAgencySubscriptionStatus(agencyId, "ACTIVE");

    const agency = await getAgency(agencyId);

    console.log(`[ADMIN] Activated subscription for agency ${agencyId}`);

    res.json({
      success: true,
      agency,
    });
  } catch (err) {
    console.error("[ADMIN] Activate error:", err);
    res.status(500).json({ error: "Failed to activate subscription" });
  }
});

/**
 * POST /internal/admin/agencies/:agencyId/cancel
 * Quick helper to cancel a subscription
 */
router.post("/agencies/:agencyId/cancel", requireAdminApiKey, async (req: Request, res: Response) => {
  try {
    const { agencyId } = req.params;

    await updateAgencySubscriptionStatus(agencyId, "CANCELLED");

    const agency = await getAgency(agencyId);

    console.log(`[ADMIN] Cancelled subscription for agency ${agencyId}`);

    res.json({
      success: true,
      agency,
    });
  } catch (err) {
    console.error("[ADMIN] Cancel error:", err);
    res.status(500).json({ error: "Failed to cancel subscription" });
  }
});

export default router;
