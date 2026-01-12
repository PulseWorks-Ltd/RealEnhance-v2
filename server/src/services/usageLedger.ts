import { PoolClient } from "pg";
import { pool, withTransaction } from "../db/index.js";
import { getCurrentMonthKey } from "@realenhance/shared/usage/monthlyUsage.js";
import { PLAN_LIMITS } from "@realenhance/shared/plans.js";
import { getAgency } from "@realenhance/shared/agencies.js";
import type { PlanTier } from "@realenhance/shared/auth/types.js";

export type ReservationStatus = "reserved" | "consumed" | "released" | "partially_released";

export interface UsageSnapshot {
  includedLimit: number;
  includedUsed: number;
  addonBalance: number;
  addonUsed: number;
  remaining: number;
  monthKey: string;
}

export interface ReservationResult extends UsageSnapshot {
  jobId: string;
  status: ReservationStatus;
  reservedImages: number;
}

async function getPlanLimitForAgency(agencyId: string): Promise<number> {
  const agency = await getAgency(agencyId);
  const tier = (agency?.planTier as PlanTier) || "starter";
  const limits = PLAN_LIMITS[tier];
  return limits.mainAllowance;
}

async function upsertAgencyAccount(client: PoolClient, agencyId: string, includedLimit: number, planTier?: string) {
  await client.query(
    `INSERT INTO agency_accounts (agency_id, monthly_included_images, plan_tier)
     VALUES ($1, $2, COALESCE($3,'starter'))
     ON CONFLICT (agency_id) DO UPDATE
       SET monthly_included_images = EXCLUDED.monthly_included_images,
           plan_tier = EXCLUDED.plan_tier,
           updated_at = NOW();`,
    [agencyId, includedLimit, planTier || "starter"]
  );
}

async function lockAgencyAccount(client: PoolClient, agencyId: string) {
  const res = await client.query("SELECT * FROM agency_accounts WHERE agency_id = $1 FOR UPDATE", [agencyId]);
  return res.rows[0];
}

async function ensureMonthUsage(client: PoolClient, agencyId: string, monthKey: string, includedLimit: number) {
  await client.query(
    `INSERT INTO agency_month_usage (agency_id, yyyymm, included_limit)
     VALUES ($1, $2, $3)
     ON CONFLICT (agency_id, yyyymm) DO NOTHING;`,
    [agencyId, monthKey, includedLimit]
  );
  const res = await client.query(
    `SELECT * FROM agency_month_usage WHERE agency_id = $1 AND yyyymm = $2 FOR UPDATE`,
    [agencyId, monthKey]
  );
  return res.rows[0];
}

function buildSnapshot(row: any, addonBalance: number, monthKey: string): UsageSnapshot {
  const includedRemaining = Math.max(0, row.included_limit - row.included_used);
  return {
    includedLimit: row.included_limit,
    includedUsed: row.included_used,
    addonBalance,
    addonUsed: row.addon_used,
    remaining: includedRemaining + addonBalance,
    monthKey,
  };
}

export async function reserveAllowance(params: {
  jobId: string;
  agencyId: string;
  userId: string;
  requiredImages: number; // 1 or 2
  requestedStage12: boolean;
  requestedStage2: boolean;
}): Promise<ReservationResult> {
  const monthKey = getCurrentMonthKey();
  return withTransaction(async (client) => {
    const includedLimit = await getPlanLimitForAgency(params.agencyId);
    const agency = await getAgency(params.agencyId);
    await upsertAgencyAccount(client, params.agencyId, includedLimit, agency?.planTier);
    const acct = await lockAgencyAccount(client, params.agencyId);
    const usage = await ensureMonthUsage(client, params.agencyId, monthKey, includedLimit);

    const includedRemaining = Math.max(0, usage.included_limit - usage.included_used);
    const addonBalance = acct.addon_images_balance ?? 0;
    const totalRemaining = includedRemaining + addonBalance;
    if (params.requiredImages > totalRemaining) {
      const snap = buildSnapshot(usage, addonBalance, monthKey);
      const err: any = new Error("QUOTA_EXCEEDED");
      err.code = "QUOTA_EXCEEDED";
      err.snapshot = snap;
      throw err;
    }

    // Allocate sequentially: Stage12 first (if requested), then Stage2
    const allocations: { stage: "1" | "2"; fromIncluded: number; fromAddon: number }[] = [];
    let remainingNeed = params.requiredImages;
    let remainingIncluded = includedRemaining;
    let remainingAddon = addonBalance;

    const stages: Array<{ key: "1" | "2"; requested: boolean }> = [
      { key: "1", requested: params.requestedStage12 },
      { key: "2", requested: params.requestedStage2 },
    ];

    for (const s of stages) {
      if (!s.requested || remainingNeed <= 0) continue;
      const takeIncluded = Math.min(remainingNeed, remainingIncluded);
      remainingIncluded -= takeIncluded;
      remainingNeed -= takeIncluded;
      const takeAddon = Math.min(remainingNeed, remainingAddon);
      remainingAddon -= takeAddon;
      remainingNeed -= takeAddon;
      allocations.push({ stage: s.key, fromIncluded: takeIncluded, fromAddon: takeAddon });
    }

    const reservedFromIncluded = allocations.reduce((sum, a) => sum + a.fromIncluded, 0);
    const reservedFromAddon = allocations.reduce((sum, a) => sum + a.fromAddon, 0);

    // Apply deductions
    await client.query(
      `UPDATE agency_month_usage
       SET included_used = included_used + $1,
           addon_used = addon_used + $2,
           updated_at = NOW()
       WHERE agency_id = $3 AND yyyymm = $4`,
      [reservedFromIncluded, reservedFromAddon, params.agencyId, monthKey]
    );

    await client.query(
      `UPDATE agency_accounts
         SET addon_images_balance = addon_images_balance - $1,
             updated_at = NOW()
       WHERE agency_id = $2`,
      [reservedFromAddon, params.agencyId]
    );

    const stage1Alloc = allocations.find((a) => a.stage === "1") || { fromIncluded: 0, fromAddon: 0 };
    const stage2Alloc = allocations.find((a) => a.stage === "2") || { fromIncluded: 0, fromAddon: 0 };

    await client.query(
      `INSERT INTO job_reservations (
         job_id, agency_id, user_id, yyyymm,
         requested_stage12, requested_stage2,
         reserved_images, reservation_status,
         reserved_stage12, reserved_stage2,
         reserved_from_included, reserved_from_addon,
         stage12_from_included, stage12_from_addon,
         stage2_from_included, stage2_from_addon,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())
       ON CONFLICT (job_id) DO NOTHING;`,
      [
        params.jobId,
        params.agencyId,
        params.userId,
        monthKey,
        params.requestedStage12,
        params.requestedStage2,
        params.requiredImages,
        params.requestedStage12,
        params.requestedStage2,
        reservedFromIncluded,
        reservedFromAddon,
        stage1Alloc.fromIncluded,
        stage1Alloc.fromAddon,
        stage2Alloc.fromIncluded,
        stage2Alloc.fromAddon,
      ]
    );

    const snapshot = buildSnapshot(
      { ...usage, included_used: usage.included_used + reservedFromIncluded, addon_used: usage.addon_used + reservedFromAddon, included_limit: usage.included_limit },
      addonBalance - reservedFromAddon,
      monthKey
    );

    return {
      ...snapshot,
      jobId: params.jobId,
      status: "reserved",
      reservedImages: params.requiredImages,
    };
  });
}

export async function finalizeReservation(params: {
  jobId: string;
  stage12Success: boolean;
  stage2Success: boolean;
}): Promise<void> {
  const monthKey = getCurrentMonthKey();
  await withTransaction(async (client) => {
    const res = await client.query(
      `SELECT * FROM job_reservations WHERE job_id = $1 FOR UPDATE`,
      [params.jobId]
    );
    if (res.rowCount === 0) return;
    const jr = res.rows[0];

    // Lock usage & account
    const usageRes = await client.query(
      `SELECT * FROM agency_month_usage WHERE agency_id = $1 AND yyyymm = $2 FOR UPDATE`,
      [jr.agency_id, jr.yyyymm]
    );
    const usage = usageRes.rows[0];
    const acctRes = await client.query(
      `SELECT * FROM agency_accounts WHERE agency_id = $1 FOR UPDATE`,
      [jr.agency_id]
    );
    const acct = acctRes.rows[0];

    let refundIncluded = 0;
    let refundAddon = 0;
    let consumeStage12 = false;
    let consumeStage2 = false;

    if (jr.requested_stage12) {
      if (params.stage12Success) {
        consumeStage12 = true;
      } else {
        refundIncluded += jr.stage12_from_included;
        refundAddon += jr.stage12_from_addon;
      }
    }

    if (jr.requested_stage2) {
      if (params.stage2Success) {
        consumeStage2 = true;
      } else {
        refundIncluded += jr.stage2_from_included;
        refundAddon += jr.stage2_from_addon;
      }
    }

    // Apply refunds
    if (refundIncluded > 0 || refundAddon > 0) {
      await client.query(
        `UPDATE agency_month_usage
           SET included_used = included_used - $1,
               addon_used = addon_used - $2,
               updated_at = NOW()
         WHERE agency_id = $3 AND yyyymm = $4`,
        [refundIncluded, refundAddon, jr.agency_id, jr.yyyymm]
      );
      await client.query(
        `UPDATE agency_accounts
           SET addon_images_balance = addon_images_balance + $1,
               updated_at = NOW()
         WHERE agency_id = $2`,
        [refundAddon, jr.agency_id]
      );
    }

    // Track actual stage usage
    if (consumeStage12) {
      await client.query(
        `UPDATE agency_month_usage
           SET stage12_used = stage12_used + 1,
               updated_at = NOW()
         WHERE agency_id = $1 AND yyyymm = $2`,
        [jr.agency_id, jr.yyyymm]
      );
    }
    if (consumeStage2) {
      await client.query(
        `UPDATE agency_month_usage
           SET stage2_used = stage2_used + 1,
               updated_at = NOW()
         WHERE agency_id = $1 AND yyyymm = $2`,
        [jr.agency_id, jr.yyyymm]
      );
    }

    const newStatus: ReservationStatus = params.stage12Success && (!jr.requested_stage2 || params.stage2Success)
      ? "consumed"
      : (!params.stage12Success && (!jr.requested_stage2 || !params.stage2Success))
      ? "released"
      : "partially_released";

    await client.query(
      `UPDATE job_reservations
         SET reservation_status = $1,
             stage12_consumed = $2,
             stage2_consumed = $3,
             updated_at = NOW()
       WHERE job_id = $4`,
      [newStatus, consumeStage12, consumeStage2, params.jobId]
    );
  });
}

export async function incrementRetry(jobId: string): Promise<{ locked: boolean; retryCount: number }> {
  const res = await pool.query(
    `UPDATE job_reservations
       SET retry_count = retry_count + 1,
           amendments_locked = CASE WHEN retry_count + 1 >= 3 THEN TRUE ELSE amendments_locked END,
           updated_at = NOW()
     WHERE job_id = $1
     RETURNING retry_count, amendments_locked`,
    [jobId]
  );
  if (res.rowCount === 0) return { locked: false, retryCount: 0 };
  const row = res.rows[0];
  return { locked: row.amendments_locked, retryCount: row.retry_count };
}

export async function incrementEdit(jobId: string): Promise<{ locked: boolean; editCount: number }> {
  const res = await pool.query(
    `UPDATE job_reservations
       SET edit_count = edit_count + 1,
           amendments_locked = CASE WHEN edit_count + 1 >= 3 THEN TRUE ELSE amendments_locked END,
           updated_at = NOW()
     WHERE job_id = $1
     RETURNING edit_count, amendments_locked`,
    [jobId]
  );
  if (res.rowCount === 0) return { locked: false, editCount: 0 };
  const row = res.rows[0];
  return { locked: row.amendments_locked, editCount: row.edit_count };
}

export async function getUsageSnapshot(agencyId: string): Promise<UsageSnapshot> {
  const monthKey = getCurrentMonthKey();
  return withTransaction(async (client) => {
    const includedLimit = await getPlanLimitForAgency(agencyId);
    const agency = await getAgency(agencyId);
    await upsertAgencyAccount(client, agencyId, includedLimit, agency?.planTier);
    const acct = await lockAgencyAccount(client, agencyId);
    const usage = await ensureMonthUsage(client, agencyId, monthKey, includedLimit);
    return buildSnapshot(usage, acct.addon_images_balance ?? 0, monthKey);
  });
}

export async function getTopUsersByUsage(agencyId: string): Promise<Array<{ userId: string; used: number }>> {
  const monthKey = getCurrentMonthKey();
  const res = await pool.query(
    `SELECT user_id, SUM(CASE WHEN stage12_consumed THEN 1 ELSE 0 END + CASE WHEN stage2_consumed THEN 1 ELSE 0 END) AS used
     FROM job_reservations
     WHERE agency_id = $1 AND yyyymm = $2 AND user_id IS NOT NULL
       AND (stage12_consumed = TRUE OR stage2_consumed = TRUE)
     GROUP BY user_id
     ORDER BY used DESC
     LIMIT 10`,
    [agencyId, monthKey]
  );
  return res.rows.map((r) => ({ userId: r.user_id as string, used: Number(r.used) || 0 }));
}
