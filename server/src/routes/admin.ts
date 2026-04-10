// server/src/routes/admin.ts
// Internal admin dashboard routes — agency overview, detail, and summary

import { Router, type Request, type Response } from "express";
import { getRedis } from "@realenhance/shared/redisClient.js";
import { pool } from "../db/index.js";
import { getUserById } from "../services/users.js";
import { PLAN_LIMITS } from "@realenhance/shared/plans.js";
import type { PlanTier } from "@realenhance/shared/auth/types.js";
import type { UserRecord } from "@realenhance/shared/types.js";

const router = Router();

/* ── Middleware ─────────────────────────────────────────── */

async function requireAuth(req: Request, res: Response, next: Function) {
  const sessUser = (req.session as any)?.user;
  if (!sessUser) return res.status(401).json({ error: "Authentication required" });
  const fullUser = await getUserById(sessUser.id);
  if (!fullUser) return res.status(401).json({ error: "Authentication required" });
  (req as any).user = fullUser;
  next();
}

function requireSiteAdmin(req: Request, res: Response, next: Function) {
  const user = (req as any).user as UserRecord | undefined;
  if (!user?.email) return res.status(401).json({ error: "Authentication required" });

  const adminEmails = (process.env.REALENHANCE_ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (!adminEmails.includes(user.email.toLowerCase())) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

/* ── Helpers ───────────────────────────────────────────── */

function getCurrentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function getMonthlyIncluded(planTier: string | null | undefined): number {
  if (!planTier) return 0;
  const limits = PLAN_LIMITS[planTier as PlanTier];
  return limits?.mainAllowance ?? 0;
}

interface RedisAgency {
  agencyId: string;
  name: string;
  planTier: string | null;
  subscriptionStatus: string;
  stripeCustomerId?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  createdAt: string;
}

async function getAllAgenciesFromRedis(): Promise<RedisAgency[]> {
  const client = getRedis();
  const keys = await client.keys("agency:*");
  const agencies: RedisAgency[] = [];
  for (const key of keys) {
    try {
      const data = await client.hGetAll(key);
      if (!data || !data.agencyId) continue;
      agencies.push({
        agencyId: data.agencyId,
        name: data.name || "",
        planTier: data.planTier || null,
        subscriptionStatus: data.subscriptionStatus || "ACTIVE",
        stripeCustomerId: data.stripeCustomerId || undefined,
        currentPeriodStart: data.currentPeriodStart || undefined,
        currentPeriodEnd: data.currentPeriodEnd || undefined,
        createdAt: data.createdAt || "",
      });
    } catch {
      // skip malformed keys
    }
  }
  return agencies;
}

interface RedisUser {
  id: string;
  email: string;
  role: string;
  agencyId: string;
  createdAt: string;
}

interface PromoCodeAdminRow {
  id: number;
  code: string;
  code_normalized: string;
  is_active: boolean;
  expires_at: string | null;
  max_redemptions: number | null;
  redemptions_count: number;
  trial_days: number;
  credits_granted: number;
  created_at: string;
  updated_at: string;
}

function parseOptionalPositiveInteger(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizePromoCode(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

async function getAllUsersGroupedByAgency(): Promise<Map<string, RedisUser[]>> {
  const client = getRedis();
  const keys = await client.keys("user:*");
  const map = new Map<string, RedisUser[]>();
  for (const key of keys) {
    try {
      const keyType = await client.type(key);
      if (keyType !== "hash") continue;
      const data = await client.hGetAll(key);
      if (!data?.agencyId) continue;
      const user: RedisUser = {
        id: data.id,
        email: data.email || "",
        role: data.role || "member",
        agencyId: data.agencyId,
        createdAt: data.createdAt || "",
      };
      const list = map.get(data.agencyId) || [];
      list.push(user);
      map.set(data.agencyId, list);
    } catch {
      // skip
    }
  }
  return map;
}

/* ── GET /summary ──────────────────────────────────────── */

router.get("/summary", requireAuth, requireSiteAdmin, async (_req: Request, res: Response) => {
  try {
    const agencies = await getAllAgenciesFromRedis();
    const monthKey = getCurrentMonthKey();

    const [usageRes, trialRes, jobsRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(included_used + addon_used), 0) AS total FROM agency_month_usage WHERE yyyymm = $1`,
        [monthKey]
      ),
      pool.query(`SELECT COUNT(*) AS count FROM organisations WHERE trial_status = 'active'`),
      pool.query(
        `SELECT COALESCE(SUM(reserved_images), 0) AS total FROM job_reservations WHERE created_at >= NOW() - INTERVAL '30 days' AND reservation_status IN ('consumed', 'committed')`
      ),
    ]);

    res.json({
      totalAgencies: agencies.length,
      activeSubscriptions: agencies.filter((a) => a.subscriptionStatus === "ACTIVE").length,
      trialUsers: Number(trialRes.rows[0]?.count || 0),
      imagesLast30Days: Number(jobsRes.rows[0]?.total || 0),
    });
  } catch (err) {
    console.error("[ADMIN DASHBOARD] summary error:", err);
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});

/* ── GET /agencies ─────────────────────────────────────── */

router.get("/agencies", requireAuth, requireSiteAdmin, async (_req: Request, res: Response) => {
  try {
    const agencies = await getAllAgenciesFromRedis();
    const userMap = await getAllUsersGroupedByAgency();
    const monthKey = getCurrentMonthKey();

    const [usageRows, accountRows, trialRows, lastActiveRows] = await Promise.all([
      pool.query<{ agency_id: string; included_used: number; addon_used: number; included_limit: number }>(
        `SELECT agency_id, included_used, addon_used, included_limit FROM agency_month_usage WHERE yyyymm = $1`,
        [monthKey]
      ),
      pool.query<{ agency_id: string; addon_images_balance: number }>(
        `SELECT agency_id, addon_images_balance FROM agency_accounts`
      ),
      pool.query<{
        agency_id: string;
        trial_status: string;
        trial_credits_total: number;
        trial_credits_used: number;
      }>(`SELECT agency_id, trial_status, trial_credits_total, trial_credits_used FROM organisations`),
      pool.query<{ agency_id: string; last_active: string }>(
        `SELECT agency_id, MAX(created_at) AS last_active FROM job_reservations GROUP BY agency_id`
      ),
    ]);

    // Build lookup maps
    const usageMap = new Map<string, { includedUsed: number; addonUsed: number }>();
    for (const r of usageRows.rows) {
      usageMap.set(r.agency_id, {
        includedUsed: Number(r.included_used || 0),
        addonUsed: Number(r.addon_used || 0),
      });
    }

    const accountMap = new Map<string, number>();
    for (const r of accountRows.rows) {
      accountMap.set(r.agency_id, Number(r.addon_images_balance || 0));
    }

    const trialMap = new Map<string, { status: string; remaining: number }>();
    for (const r of trialRows.rows) {
      const remaining = Math.max(0, Number(r.trial_credits_total || 0) - Number(r.trial_credits_used || 0));
      trialMap.set(r.agency_id, { status: r.trial_status, remaining });
    }

    const lastActiveMap = new Map<string, string>();
    for (const r of lastActiveRows.rows) {
      lastActiveMap.set(r.agency_id, r.last_active);
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const result = agencies.map((agency) => {
      const monthlyIncluded = getMonthlyIncluded(agency.planTier);
      const usage = usageMap.get(agency.agencyId);
      const usedThisMonth = usage ? usage.includedUsed + usage.addonUsed : 0;
      const remainingThisMonth = Math.max(0, monthlyIncluded - (usage?.includedUsed || 0));
      const trial = trialMap.get(agency.agencyId);
      const addonBalance = accountMap.get(agency.agencyId) ?? 0;
      const lastActiveAt = lastActiveMap.get(agency.agencyId) ?? null;
      const users = userMap.get(agency.agencyId) ?? [];
      const usagePercent = monthlyIncluded > 0 ? usedThisMonth / monthlyIncluded : 0;

      return {
        agencyId: agency.agencyId,
        agencyName: agency.name,
        planTier: agency.planTier,
        subscriptionStatus: agency.subscriptionStatus,
        stripeCustomerId: agency.stripeCustomerId ?? null,
        seats: users.length,
        monthlyIncluded,
        usedThisMonth,
        remainingThisMonth,
        trialRemaining: trial?.status === "active" ? trial.remaining : 0,
        addonBalance,
        createdAt: agency.createdAt,
        lastActiveAt,
        usagePercent: Math.round(usagePercent * 100) / 100,
        isNearLimit: usagePercent >= 0.8,
        isInactive: lastActiveAt ? new Date(lastActiveAt) < sevenDaysAgo : true,
      };
    });

    // Sort by createdAt DESC (most recent first)
    result.sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });

    res.json({ agencies: result });
  } catch (err) {
    console.error("[ADMIN DASHBOARD] agencies list error:", err);
    res.status(500).json({ error: "Failed to fetch agencies" });
  }
});

/* ── GET /agencies/:agencyId ───────────────────────────── */

router.get("/agencies/:agencyId", requireAuth, requireSiteAdmin, async (req: Request, res: Response) => {
  try {
    const { agencyId } = req.params;

    // Get agency from Redis
    const client = getRedis();
    const data = await client.hGetAll(`agency:${agencyId}`);
    if (!data || !data.agencyId) {
      return res.status(404).json({ error: "Agency not found" });
    }

    const agency: RedisAgency = {
      agencyId: data.agencyId,
      name: data.name || "",
      planTier: data.planTier || null,
      subscriptionStatus: data.subscriptionStatus || "ACTIVE",
      stripeCustomerId: data.stripeCustomerId || undefined,
      currentPeriodStart: data.currentPeriodStart || undefined,
      currentPeriodEnd: data.currentPeriodEnd || undefined,
      createdAt: data.createdAt || "",
    };

    const monthKey = getCurrentMonthKey();
    const monthlyIncluded = getMonthlyIncluded(agency.planTier);

    // Parallel queries
    const [usageRes, lifetimeRes, trialRes, accountRes, jobStatsRes, usersFromRedis] = await Promise.all([
      pool.query(
        `SELECT included_used, addon_used FROM agency_month_usage WHERE agency_id = $1 AND yyyymm = $2`,
        [agencyId, monthKey]
      ),
      pool.query(
        `SELECT COALESCE(SUM(included_used + addon_used), 0) AS total FROM agency_month_usage WHERE agency_id = $1`,
        [agencyId]
      ),
      pool.query(
        `SELECT trial_status, trial_credits_total, trial_credits_used, trial_expires_at FROM organisations WHERE agency_id = $1`,
        [agencyId]
      ),
      pool.query(`SELECT addon_images_balance FROM agency_accounts WHERE agency_id = $1`, [agencyId]),
      pool.query(
        `SELECT COALESCE(SUM(retry_count), 0) AS retries, COALESCE(SUM(edit_count), 0) AS edits, MAX(created_at) AS last_active FROM job_reservations WHERE agency_id = $1`,
        [agencyId]
      ),
      // Users from Redis for this agency
      (async () => {
        const redis = getRedis();
        const keys = await redis.keys("user:*");
        const users: RedisUser[] = [];
        for (const key of keys) {
          try {
            const keyType = await redis.type(key);
            if (keyType !== "hash") continue;
            const u = await redis.hGetAll(key);
            if (u?.agencyId === agencyId) {
              users.push({
                id: u.id,
                email: u.email || "",
                role: u.role || "member",
                agencyId: u.agencyId,
                createdAt: u.createdAt || "",
              });
            }
          } catch {
            /* skip */
          }
        }
        return users;
      })(),
    ]);

    const usageRow = usageRes.rows[0];
    const imagesThisMonth = usageRow
      ? Number(usageRow.included_used || 0) + Number(usageRow.addon_used || 0)
      : 0;
    const totalImagesProcessed = Number(lifetimeRes.rows[0]?.total || 0);
    const trialRow = trialRes.rows[0];
    const trialRemaining = trialRow
      ? Math.max(0, Number(trialRow.trial_credits_total || 0) - Number(trialRow.trial_credits_used || 0))
      : 0;
    const addonBalance = Number(accountRes.rows[0]?.addon_images_balance || 0);
    const retryCount = Number(jobStatsRes.rows[0]?.retries || 0);
    const editCount = Number(jobStatsRes.rows[0]?.edits || 0);
    const lastActiveAt = jobStatsRes.rows[0]?.last_active ?? null;

    res.json({
      agencyId: agency.agencyId,
      agencyName: agency.name,
      planTier: agency.planTier,
      subscriptionStatus: agency.subscriptionStatus,
      stripeCustomerId: agency.stripeCustomerId ?? null,
      currentPeriodStart: agency.currentPeriodStart ?? null,
      currentPeriodEnd: agency.currentPeriodEnd ?? null,
      createdAt: agency.createdAt,
      seats: usersFromRedis.length,
      monthlyIncluded,
      usedThisMonth: imagesThisMonth,
      remainingThisMonth: Math.max(0, monthlyIncluded - (Number(usageRow?.included_used) || 0)),
      trialRemaining,
      addonBalance,
      lastActiveAt,
      usage: {
        totalImagesProcessed,
        imagesThisMonth,
        retryCount,
        editCount,
      },
      users: usersFromRedis.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        createdAt: u.createdAt,
      })),
    });
  } catch (err) {
    console.error("[ADMIN DASHBOARD] agency detail error:", err);
    res.status(500).json({ error: "Failed to fetch agency details" });
  }
});

/* ── GET /promo-codes ─────────────────────────────────── */

router.get("/promo-codes", requireAuth, requireSiteAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await pool.query<PromoCodeAdminRow>(
      `SELECT id, code, code_normalized, is_active, expires_at, max_redemptions, redemptions_count,
              trial_days, credits_granted, created_at, updated_at
         FROM promo_codes
        ORDER BY created_at DESC, id DESC`
    );

    res.json({
      promoCodes: result.rows.map((row) => ({
        id: row.id,
        code: row.code,
        normalizedCode: row.code_normalized,
        isActive: row.is_active,
        expiresAt: row.expires_at,
        maxRedemptions: row.max_redemptions,
        redemptionsCount: row.redemptions_count,
        trialDays: row.trial_days,
        creditsGranted: row.credits_granted,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  } catch (err) {
    console.error("[ADMIN DASHBOARD] promo codes list error:", err);
    res.status(500).json({ error: "Failed to fetch promo codes" });
  }
});

/* ── POST /promo-codes ────────────────────────────────── */

router.post("/promo-codes", requireAuth, requireSiteAdmin, async (req: Request, res: Response) => {
  try {
    const code = normalizePromoCode(req.body?.code);
    const trialDays = parseOptionalPositiveInteger(req.body?.trialDays);
    const creditsGranted = parseOptionalPositiveInteger(req.body?.creditsGranted);
    const maxRedemptions = parseOptionalPositiveInteger(req.body?.maxRedemptions);
    const expiresAtRaw = typeof req.body?.expiresAt === "string" ? req.body.expiresAt.trim() : "";
    const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;

    if (!code || code.length < 3 || code.length > 64) {
      return res.status(400).json({ error: "Code must be 3-64 characters" });
    }
    if (trialDays === null || creditsGranted === null || maxRedemptions === null) {
      return res.status(400).json({ error: "trialDays, creditsGranted, and maxRedemptions must be positive integers when provided" });
    }
    if (expiresAtRaw && Number.isNaN(expiresAt?.getTime())) {
      return res.status(400).json({ error: "expiresAt must be a valid ISO date" });
    }

    const normalizedCode = code.toLowerCase();
    const result = await pool.query<PromoCodeAdminRow>(
      `INSERT INTO promo_codes (
          code, code_normalized, is_active, expires_at, max_redemptions, redemptions_count, trial_days, credits_granted
        ) VALUES ($1, $2, TRUE, $3, $4, 0, $5, $6)
        RETURNING id, code, code_normalized, is_active, expires_at, max_redemptions, redemptions_count,
                  trial_days, credits_granted, created_at, updated_at`,
      [code, normalizedCode, expiresAt ? expiresAt.toISOString() : null, maxRedemptions ?? null, trialDays ?? 30, creditsGranted ?? 75]
    );

    const row = result.rows[0];
    res.status(201).json({
      promoCode: {
        id: row.id,
        code: row.code,
        normalizedCode: row.code_normalized,
        isActive: row.is_active,
        expiresAt: row.expires_at,
        maxRedemptions: row.max_redemptions,
        redemptionsCount: row.redemptions_count,
        trialDays: row.trial_days,
        creditsGranted: row.credits_granted,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  } catch (err: any) {
    if (err?.code === "23505") {
      return res.status(409).json({ error: "A promo code with that value already exists" });
    }
    console.error("[ADMIN DASHBOARD] promo code create error:", err);
    res.status(500).json({ error: "Failed to create promo code" });
  }
});

/* ── PATCH /promo-codes/:id ───────────────────────────── */

router.patch("/promo-codes/:promoCodeId", requireAuth, requireSiteAdmin, async (req: Request, res: Response) => {
  try {
    const promoCodeId = Number(req.params.promoCodeId);
    if (!Number.isInteger(promoCodeId) || promoCodeId <= 0) {
      return res.status(400).json({ error: "Invalid promo code id" });
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (typeof req.body?.isActive === "boolean") {
      params.push(req.body.isActive);
      updates.push(`is_active = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    updates.push(`updated_at = NOW()`);
    params.push(promoCodeId);

    const result = await pool.query<PromoCodeAdminRow>(
      `UPDATE promo_codes
          SET ${updates.join(", ")}
        WHERE id = $${params.length}
        RETURNING id, code, code_normalized, is_active, expires_at, max_redemptions, redemptions_count,
                  trial_days, credits_granted, created_at, updated_at`,
      params
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Promo code not found" });
    }

    const row = result.rows[0];
    res.json({
      promoCode: {
        id: row.id,
        code: row.code,
        normalizedCode: row.code_normalized,
        isActive: row.is_active,
        expiresAt: row.expires_at,
        maxRedemptions: row.max_redemptions,
        redemptionsCount: row.redemptions_count,
        trialDays: row.trial_days,
        creditsGranted: row.credits_granted,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  } catch (err) {
    console.error("[ADMIN DASHBOARD] promo code update error:", err);
    res.status(500).json({ error: "Failed to update promo code" });
  }
});

export default router;
