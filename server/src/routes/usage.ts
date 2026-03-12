// server/src/routes/usage.ts
// Usage summary API for displaying monthly usage to users

import { Router, type Request, type Response } from "express";
import { getUserById } from "../services/users.js";
import { getAgency } from "@realenhance/shared/agencies.js";
import { planTierToPlanCode, PLAN_LIMITS } from "@realenhance/shared/plans.js";
import type { PlanTier } from "@realenhance/shared/auth/types.js";
import { getUsageSnapshot, getTopUsersByUsage } from "../services/usageLedger.js";
import { getCurrentMonthKey } from "@realenhance/shared/usage/monthlyUsage.js";
import { getTrialSummary } from "../services/trials.js";

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
      const trial = await getTrialSummary(user.agencyId);
      const topUsers = await getTopUsersByUsage(user.agencyId);
      const planTier = agency.planTier as PlanTier | null | undefined;
      const planCode = planTier ? planTierToPlanCode(planTier) : "TRIAL";
      const planLimits = planTier ? PLAN_LIMITS[planTier] : { price: 0 };

      const now = Date.now();
      const trialActive =
        trial.status === "active" &&
        (!trial.expiresAt || Number.isNaN(Date.parse(trial.expiresAt)) || Date.parse(trial.expiresAt) > now);
      const trialRemaining = trialActive ? Math.max(0, Number(trial.remaining || 0)) : 0;
      const trialIncluded = trialActive ? Math.max(0, Number(trial.creditsTotal || 0)) : 0;
      const trialUsed = trialActive ? Math.max(0, Number(trial.creditsUsed || 0)) : 0;

      const effectiveIncludedLimit = trialActive ? Math.max(snapshot.includedLimit, trialIncluded) : snapshot.includedLimit;
      const effectiveIncludedUsed = trialActive ? Math.max(snapshot.includedUsed, trialUsed) : snapshot.includedUsed;
      const effectiveRemaining = Math.max(0, Number(snapshot.remaining || 0)) + trialRemaining;

      const planName = planTier
        ? (planCode.charAt(0) + planCode.slice(1).toLowerCase())
        : trialActive
        ? "Starter (Trial)"
        : "No Plan";

      // Calculate usage percentages for warnings
      const mainUsagePercent = effectiveIncludedLimit > 0
        ? (effectiveIncludedUsed / effectiveIncludedLimit) * 100
        : 0;
      const stagingUsagePercent = 0; // staging allowance removed in new model

      // Determine warning levels
      let mainWarning: "none" | "approaching" | "critical" | "exhausted" = "none";
      if (effectiveRemaining === 0) {
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
        planName,
        price: planLimits.price,
        mainAllowance: effectiveIncludedLimit,
        mainUsed: effectiveIncludedUsed,
        mainRemaining: effectiveRemaining,
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
