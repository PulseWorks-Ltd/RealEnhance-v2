// server/src/routes/usage.ts
// Usage summary API for displaying monthly usage to users

import { Router, type Request, type Response } from "express";
import { getUserById } from "../services/users.js";
import { getAgency } from "@realenhance/shared/agencies.js";
import { getRemainingUsage, getCurrentMonthKey } from "@realenhance/shared/usage/monthlyUsage.js";
import { planTierToPlanCode, PLAN_LIMITS } from "@realenhance/shared/plans.js";
import type { PlanTier } from "@realenhance/shared/auth/types.js";

export function usageRouter() {
  const r = Router();

  /**
   * GET /api/usage/summary
   * Returns current month's usage summary for the authenticated user's agency
   */
  r.get("/summary", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    try {
      // Get user's agency
      const user = await getUserById(sessUser.id);
      if (!user || !user.agencyId) {
        return res.json({
          hasAgency: false,
          monthKey: getCurrentMonthKey(),
        });
      }

      const agency = await getAgency(user.agencyId);
      if (!agency) {
        return res.status(404).json({ error: "agency_not_found" });
      }

      const monthKey = getCurrentMonthKey();
      const remaining = await getRemainingUsage(user.agencyId, monthKey);
      const planCode = planTierToPlanCode(agency.planTier as PlanTier);
      const planLimits = PLAN_LIMITS[agency.planTier as PlanTier];

      // Calculate usage percentages for warnings
      const mainUsagePercent = (remaining.mainUsed / remaining.mainAllowance) * 100;
      const stagingUsagePercent = remaining.stagingAllowance > 0
        ? (remaining.stagingUsed / remaining.stagingAllowance) * 100
        : 0;

      // Determine warning levels
      let mainWarning: "none" | "approaching" | "critical" | "exhausted" = "none";
      if (remaining.mainRemaining === 0) {
        mainWarning = "exhausted";
      } else if (mainUsagePercent >= 95) {
        mainWarning = "critical";
      } else if (mainUsagePercent >= 80) {
        mainWarning = "approaching";
      }

      let stagingWarning: "none" | "approaching" | "critical" | "exhausted" = "none";
      if (remaining.stagingAllowance > 0) {
        if (remaining.stagingRemaining === 0) {
          stagingWarning = "exhausted";
        } else if (stagingUsagePercent >= 95) {
          stagingWarning = "critical";
        } else if (stagingUsagePercent >= 80) {
          stagingWarning = "approaching";
        }
      }

      return res.json({
        hasAgency: true,
        monthKey,
        planCode,
        planName: planCode.charAt(0) + planCode.slice(1).toLowerCase(), // "STARTER" -> "Starter"
        price: planLimits.price,
        mainAllowance: remaining.mainAllowance,
        mainUsed: remaining.mainUsed,
        mainRemaining: remaining.mainRemaining,
        mainUsagePercent: Math.round(mainUsagePercent),
        mainWarning,
        stagingAllowance: remaining.stagingAllowance,
        stagingUsed: remaining.stagingUsed,
        stagingRemaining: remaining.stagingRemaining,
        stagingUsagePercent: Math.round(stagingUsagePercent),
        stagingWarning,
        agencyName: agency.name,
        userRole: user.role || "member",
      });
    } catch (err) {
      console.error("[USAGE API] Error fetching usage summary:", err);
      return res.status(500).json({
        error: "internal_error",
        message: "Failed to fetch usage summary"
      });
    }
  });

  return r;
}
