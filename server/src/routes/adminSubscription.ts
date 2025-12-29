// server/src/routes/adminSubscription.ts
// Admin-only subscription management (protected by API key)

import { Router, type Request, type Response } from "express";
import { getAgency, updateAgency } from "@realenhance/shared/agencies.js";
import type { SubscriptionStatus, PlanTier } from "@realenhance/shared/auth/types.js";

const router = Router();

/**
 * Middleware to require admin API key
 */
function requireAdminApiKey(req: Request, res: Response, next: Function) {
  const apiKey = req.headers["x-admin-api-key"];
  const expectedKey = process.env.ADMIN_API_KEY;

  if (!expectedKey) {
    return res.status(503).json({ error: "Admin API not configured" });
  }

  if (!apiKey || apiKey !== expectedKey) {
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
  } catch (error) {
    console.error("[ADMIN API] Error getting agency:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /internal/admin/agencies/:agencyId/subscription
 * Update subscription details
 */
router.post("/agencies/:agencyId/subscription", requireAdminApiKey, async (req: Request, res: Response) => {
  try {
    const { agencyId } = req.params;
    const { subscriptionStatus, planTier, currentPeriodStart, currentPeriodEnd } = req.body;

    const agency = await getAgency(agencyId);
    if (!agency) {
      return res.status(404).json({ error: "Agency not found" });
    }

    // Validate subscriptionStatus if provided
    if (subscriptionStatus) {
      const validStatuses: SubscriptionStatus[] = ["ACTIVE", "PAST_DUE", "CANCELLED", "TRIAL"];
      if (!validStatuses.includes(subscriptionStatus)) {
        return res.status(400).json({
          error: "Invalid subscription status",
          validStatuses
        });
      }
      agency.subscriptionStatus = subscriptionStatus;
    }

    // Validate planTier if provided
    if (planTier) {
      const validTiers: PlanTier[] = ["starter", "pro", "agency"];
      if (!validTiers.includes(planTier)) {
        return res.status(400).json({
          error: "Invalid plan tier",
          validTiers
        });
      }
      agency.planTier = planTier;
    }

    // Update period dates if provided
    if (currentPeriodStart) {
      agency.currentPeriodStart = currentPeriodStart;
    }
    if (currentPeriodEnd) {
      agency.currentPeriodEnd = currentPeriodEnd;
    }

    agency.updatedAt = new Date().toISOString();
    await updateAgency(agency);

    // Audit log
    console.log(`[ADMIN] Updated subscription for agency ${agencyId}:`, {
      subscriptionStatus: agency.subscriptionStatus,
      planTier: agency.planTier,
      currentPeriodStart: agency.currentPeriodStart,
      currentPeriodEnd: agency.currentPeriodEnd,
      timestamp: agency.updatedAt,
    });

    res.json({ success: true, agency });
  } catch (error) {
    console.error("[ADMIN API] Error updating subscription:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /internal/admin/agencies/:agencyId/activate
 * Quick activate subscription (sets to ACTIVE)
 */
router.post("/agencies/:agencyId/activate", requireAdminApiKey, async (req: Request, res: Response) => {
  try {
    const { agencyId } = req.params;
    const agency = await getAgency(agencyId);

    if (!agency) {
      return res.status(404).json({ error: "Agency not found" });
    }

    agency.subscriptionStatus = "ACTIVE";
    agency.updatedAt = new Date().toISOString();
    await updateAgency(agency);

    console.log(`[ADMIN] Activated subscription for agency ${agencyId}`);

    res.json({ success: true, agency });
  } catch (error) {
    console.error("[ADMIN API] Error activating subscription:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /internal/admin/agencies/:agencyId/cancel
 * Quick cancel subscription (sets to CANCELLED)
 */
router.post("/agencies/:agencyId/cancel", requireAdminApiKey, async (req: Request, res: Response) => {
  try {
    const { agencyId } = req.params;
    const agency = await getAgency(agencyId);

    if (!agency) {
      return res.status(404).json({ error: "Agency not found" });
    }

    agency.subscriptionStatus = "CANCELLED";
    agency.updatedAt = new Date().toISOString();
    await updateAgency(agency);

    console.log(`[ADMIN] Cancelled subscription for agency ${agencyId}`);

    res.json({ success: true, agency });
  } catch (error) {
    console.error("[ADMIN API] Error cancelling subscription:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
