// server/src/routes/usage.ts
// Usage summary API for displaying monthly usage to users

import { Router, type Request, type Response } from "express";
import { getUserById } from "../services/users.js";
import { getAgency } from "@realenhance/shared/agencies.js";
import { planTierToPlanCode, PLAN_LIMITS } from "@realenhance/shared/plans.js";
import type { PlanTier } from "@realenhance/shared/auth/types.js";
import { getUsageSnapshot, getTopUsersByUsage } from "../services/usageLedger.js";
import { getCurrentMonthKey } from "@realenhance/shared/usage/monthlyUsage.js";

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

      const snapshot = await getUsageSnapshot(user.agencyId);
      const topUsers = await getTopUsersByUsage(user.agencyId);
      const planCode = planTierToPlanCode(agency.planTier as PlanTier);
      const planLimits = PLAN_LIMITS[agency.planTier as PlanTier];

      // Calculate usage percentages for warnings
      const mainUsagePercent = (snapshot.includedUsed / snapshot.includedLimit) * 100;
      const stagingUsagePercent = 0; // staging allowance removed in new model

      // Determine warning levels
      let mainWarning: "none" | "approaching" | "critical" | "exhausted" = "none";
      if (snapshot.remaining === 0) {
        mainWarning = "exhausted";
      } else if (mainUsagePercent >= 95) {
        mainWarning = "critical";
      } else if (mainUsagePercent >= 80) {
        mainWarning = "approaching";
      }

      const stagingWarning: "none" | "approaching" | "critical" | "exhausted" = "none";

      const resolvedTopUsers = await Promise.all(
        topUsers.map(async (u) => {
          const urec = await getUserById(u.userId);
          return {
            userId: u.userId,
            name: urec?.name || urec?.email || u.userId,
            used: u.used,
          };
        })
      );

      return res.json({
        hasAgency: true,
        monthKey: snapshot.monthKey,
        planCode,
        planName: planCode.charAt(0) + planCode.slice(1).toLowerCase(), // "STARTER" -> "Starter"
        price: planLimits.price,
        mainAllowance: snapshot.includedLimit,
        mainUsed: snapshot.includedUsed,
        mainRemaining: snapshot.remaining,
        addonRemaining: snapshot.addonRemaining,
        mainUsagePercent: Math.round(mainUsagePercent),
        mainWarning,
        stagingAllowance: 0,
        stagingUsed: 0,
        stagingRemaining: 0,
        stagingUsagePercent: Math.round(stagingUsagePercent),
        stagingWarning,
        agencyName: agency.name,
        userRole: user.role || "member",
        topUsers: resolvedTopUsers,
        stagingNote: "Virtual staging uses an additional image from your allowance.",
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
