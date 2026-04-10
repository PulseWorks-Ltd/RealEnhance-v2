// server/src/routes/adminSubscription.ts
// Admin-only subscription management (protected by API key)

import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { getAgency, updateAgency } from "@realenhance/shared/agencies.js";
import { createAdminImageGrant } from "@realenhance/shared/usage/imageBundles.js";
import type { SubscriptionStatus, PlanTier } from "@realenhance/shared/auth/types.js";
import { withTransaction } from "../db/index.js";
import { getUsageSnapshot } from "../services/usageLedger.js";

const router = Router();
const ADMIN_DEMO_GRANT_SOURCE = "admin_demo_credit_grant";
const ADMIN_DEMO_GRANT_MAX_IMAGES = Math.max(1, Number(process.env.ADMIN_DEMO_GRANT_MAX_IMAGES || 1000));
const ADMIN_DEMO_GRANT_MAX_EXPIRES_DAYS = Math.max(1, Number(process.env.ADMIN_DEMO_GRANT_MAX_EXPIRES_DAYS || 90));

/**
 * Timing-safe string comparison to prevent timing attacks
 */
function timingSafeEqual(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    // If lengths differ, timingSafeEqual throws - return false
    return false;
  }
}

/**
 * Middleware to require admin API key (timing-safe comparison)
 */
function requireAdminApiKey(req: Request, res: Response, next: Function) {
  const apiKey = req.headers["x-admin-api-key"];
  const expectedKey = process.env.ADMIN_API_KEY;

  if (!expectedKey) {
    return res.status(503).json({ error: "Admin API not configured" });
  }

  if (!apiKey || typeof apiKey !== "string" || !timingSafeEqual(apiKey, expectedKey)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

function parsePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
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

/**
 * POST /internal/admin/agencies/:agencyId/demo-credits
 * Grant expiring demo/test add-on credits to an agency (idempotent by requestId)
 */
router.post("/agencies/:agencyId/demo-credits", requireAdminApiKey, async (req: Request, res: Response) => {
  try {
    const { agencyId } = req.params;
    const quantity = parsePositiveInteger(req.body?.quantity);
    const expiresInDaysRaw = req.body?.expiresInDays;
    const expiresInDays = expiresInDaysRaw == null ? 30 : parsePositiveInteger(expiresInDaysRaw);
    const requestId = typeof req.body?.requestId === "string" ? req.body.requestId.trim() : "";
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const actor = typeof req.headers["x-admin-actor"] === "string"
      ? req.headers["x-admin-actor"].trim()
      : "api_key";

    if (!quantity || quantity > ADMIN_DEMO_GRANT_MAX_IMAGES) {
      return res.status(400).json({
        error: "Invalid quantity",
        message: `quantity must be an integer between 1 and ${ADMIN_DEMO_GRANT_MAX_IMAGES}`,
      });
    }

    if (!expiresInDays || expiresInDays > ADMIN_DEMO_GRANT_MAX_EXPIRES_DAYS) {
      return res.status(400).json({
        error: "Invalid expiresInDays",
        message: `expiresInDays must be an integer between 1 and ${ADMIN_DEMO_GRANT_MAX_EXPIRES_DAYS}`,
      });
    }

    if (!requestId || requestId.length < 8 || requestId.length > 120) {
      return res.status(400).json({
        error: "Invalid requestId",
        message: "requestId must be 8-120 characters for idempotency",
      });
    }

    if (!reason || reason.length < 5 || reason.length > 240) {
      return res.status(400).json({
        error: "Invalid reason",
        message: "reason must be 5-240 characters",
      });
    }

    const agency = await getAgency(agencyId);
    if (!agency) {
      return res.status(404).json({ error: "Agency not found" });
    }

    const grantResult = await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${ADMIN_DEMO_GRANT_SOURCE}:${agencyId}`]);

      const existing = await client.query<{
        quantity: number;
        purchased_at: string;
        metadata: Record<string, any> | null;
      }>(
        `SELECT quantity, purchased_at, metadata
           FROM addon_purchases
          WHERE agency_id = $1
            AND source = $2
            AND metadata ->> 'requestId' = $3
          LIMIT 1`,
        [agencyId, ADMIN_DEMO_GRANT_SOURCE, requestId]
      );

      if (existing.rowCount && existing.rows[0]) {
        return {
          duplicated: true,
          quantity: Number(existing.rows[0].quantity || 0),
          purchasedAt: existing.rows[0].purchased_at,
          bundleId: existing.rows[0].metadata?.bundleId || null,
          expiresAt: existing.rows[0].metadata?.expiresAt || null,
        };
      }

      const grant = await createAdminImageGrant({
        agencyId,
        imagesPurchased: quantity,
        requestId,
        expiresInDays,
      });

      if (!grant.created && grant.reason !== "duplicate") {
        throw new Error(`Failed to create admin image grant: ${grant.reason || "unknown"}`);
      }

      await client.query(
        `INSERT INTO agency_accounts (agency_id, monthly_included_images, plan_tier, addon_images_balance)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (agency_id) DO UPDATE
           SET addon_images_balance = agency_accounts.addon_images_balance + EXCLUDED.addon_images_balance,
               updated_at = NOW()`,
        [agencyId, 0, agency.planTier || "starter", quantity]
      );

      await client.query(
        `INSERT INTO addon_purchases (agency_id, quantity, source, metadata)
         VALUES ($1, $2, $3, $4)`,
        [
          agencyId,
          quantity,
          ADMIN_DEMO_GRANT_SOURCE,
          JSON.stringify({
            type: "admin_demo_credit_grant",
            requestId,
            reason,
            actor,
            bundleId: grant.bundle?.id || null,
            bundleType: grant.bundle?.bundleType || "admin",
            bundleCode: grant.bundle?.bundleCode || "ADMIN_GRANT",
            expiresAt: grant.bundle?.expiresAt || null,
            grantedAt: new Date().toISOString(),
          }),
        ]
      );

      return {
        duplicated: false,
        quantity,
        purchasedAt: new Date().toISOString(),
        bundleId: grant.bundle?.id || null,
        expiresAt: grant.bundle?.expiresAt || null,
      };
    });

    const usage = await getUsageSnapshot(agencyId);

    console.log(`[ADMIN] Demo credits ${grantResult.duplicated ? "replayed" : "granted"} for agency ${agencyId}`, {
      quantity: grantResult.quantity,
      requestId,
      actor,
      reason,
      expiresAt: grantResult.expiresAt,
    });

    return res.json({
      success: true,
      duplicated: grantResult.duplicated,
      agencyId,
      quantity: grantResult.quantity,
      reason,
      requestId,
      expiresAt: grantResult.expiresAt,
      bundleId: grantResult.bundleId,
      purchasedAt: grantResult.purchasedAt,
      allowance: {
        monthlyIncluded: usage.includedLimit,
        monthlyRemaining: usage.includedRemaining,
        addonBalance: usage.addonBalance,
        addonRemaining: usage.addonRemaining,
        totalRemaining: usage.remaining,
        monthKey: usage.monthKey,
      },
    });
  } catch (error) {
    console.error("[ADMIN API] Error granting demo credits:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
