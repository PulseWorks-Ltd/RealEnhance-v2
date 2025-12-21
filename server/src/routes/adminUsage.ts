// server/src/routes/adminUsage.ts
// Admin endpoints for usage tracking and agency management

import { Router, type Request, type Response } from "express";
// Import from shared package with .js extension for NodeNext module resolution
import { listAgencies, getAgency, saveAgency } from "@realenhance/shared/agencyStore.js";
import { getAgencyRollup, getUserRollup, getWarnings, getRecentEvents } from "@realenhance/shared/usage/usageStore.js";
import type { UserRecord } from "@realenhance/shared/types.js";

const router = Router();

/**
 * Simple admin authentication middleware
 * Checks if user's email is in REALENHANCE_ADMIN_EMAILS env var
 */
function requireAdmin(req: Request, res: Response, next: Function) {
  const user = (req as any).user as UserRecord | undefined;

  if (!user || !user.email) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const adminEmails = (process.env.REALENHANCE_ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (!adminEmails.includes(user.email.toLowerCase())) {
    return res.status(403).json({ error: "Admin access required" });
  }

  next();
}

/**
 * GET /api/admin/usage/agencies?month=YYYY-MM
 * List all agencies with their usage for the specified month (or current month)
 */
router.get("/agencies", requireAdmin, async (req: Request, res: Response) => {
  try {
    const month = (req.query.month as string) || getCurrentMonth();

    const agencies = await listAgencies();
    const result: any[] = [];

    for (const agency of agencies) {
      const rollup = await getAgencyRollup(agency.agencyId, month);
      const warnings = await getWarnings(agency.agencyId, month);

      result.push({
        agency,
        usage: rollup || {
          images: 0,
          listings: 0,
          stage_1A: 0,
          stage_1B: 0,
          stage_2: 0,
          stage_edit: 0,
          stage_region_edit: 0,
        },
        warnings,
      });
    }

    res.json({
      month,
      agencies: result,
    });
  } catch (err) {
    console.error("[ADMIN USAGE] Failed to list agencies:", err);
    res.status(500).json({ error: "Failed to fetch agency usage data" });
  }
});

/**
 * GET /api/admin/usage/agencies/:agencyId?month=YYYY-MM
 * Get detailed usage for a specific agency
 */
router.get("/agencies/:agencyId", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { agencyId } = req.params;
    const month = (req.query.month as string) || getCurrentMonth();

    const agency = await getAgency(agencyId);
    if (!agency) {
      return res.status(404).json({ error: "Agency not found" });
    }

    const rollup = await getAgencyRollup(agencyId, month);
    const warnings = await getWarnings(agencyId, month);
    const recentEvents = await getRecentEvents(agencyId, month, 100);

    // TODO: Get users in this agency
    // For now, return empty array - would need to query user service
    const users: any[] = [];

    res.json({
      month,
      agency,
      usage: rollup || {
        images: 0,
        listings: 0,
        stage_1A: 0,
        stage_1B: 0,
        stage_2: 0,
        stage_edit: 0,
        stage_region_edit: 0,
      },
      warnings,
      recentEvents,
      users,
    });
  } catch (err) {
    console.error("[ADMIN USAGE] Failed to get agency detail:", err);
    res.status(500).json({ error: "Failed to fetch agency details" });
  }
});

/**
 * GET /api/admin/usage/export?month=YYYY-MM
 * Export usage data as CSV
 */
router.get("/export", requireAdmin, async (req: Request, res: Response) => {
  try {
    const month = (req.query.month as string) || getCurrentMonth();

    const agencies = await listAgencies();
    const rows: string[] = [];

    // CSV Header
    rows.push(
      "AgencyID,AgencyName,PlanName,Month,Images,Listings,Stage1A,Stage1B,Stage2,Edit,RegionEdit,MonthlyImageLimit,MonthlyListingLimit,Warnings"
    );

    for (const agency of agencies) {
      const rollup = await getAgencyRollup(agency.agencyId, month);
      const warnings = await getWarnings(agency.agencyId, month);

      const usage = rollup || {
        images: 0,
        listings: 0,
        stage_1A: 0,
        stage_1B: 0,
        stage_2: 0,
        stage_edit: 0,
        stage_region_edit: 0,
      };

      const warningCount = warnings.length;

      rows.push(
        [
          agency.agencyId,
          agency.name,
          agency.planName,
          month,
          usage.images,
          usage.listings,
          usage.stage_1A,
          usage.stage_1B,
          usage.stage_2,
          usage.stage_edit,
          usage.stage_region_edit,
          agency.monthlyImageLimit || "",
          agency.monthlyListingLimit || "",
          warningCount,
        ].join(",")
      );
    }

    const csv = rows.join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="usage-${month}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error("[ADMIN USAGE] Failed to export usage:", err);
    res.status(500).json({ error: "Failed to export usage data" });
  }
});

/**
 * Helper: Get current month in YYYY-MM format
 */
function getCurrentMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export default router;
