import { PoolClient } from "pg";
import { pool, withTransaction } from "../db/index.js";
import { getCurrentMonthKey } from "@realenhance/shared/usage/monthlyUsage.js";
import { getTotalBundleRemaining, consumeBundleImages } from "@realenhance/shared/usage/imageBundles.js";
import { PLAN_LIMITS } from "@realenhance/shared/plans.js";
import { getAgency } from "@realenhance/shared/agencies.js";
import { getRedis } from "@realenhance/shared/redisClient.js";
import type { PlanTier } from "@realenhance/shared/auth/types.js";

export type ReservationStatus = "reserved" | "committed" | "consumed" | "released" | "partially_released";

export interface UsageSnapshot {
  includedLimit: number;
  includedUsed: number;
  includedRemaining: number; // remaining from monthly allowance only
  addonBalance: number; // legacy name for compatibility
  addonRemaining: number; // canonical add-on remaining (non-negative)
  addonUsed: number;
  remaining: number; // total remaining (includedRemaining + addonRemaining)
  monthKey: string;
}

export interface ReservationResult extends UsageSnapshot {
  jobId: string;
  status: ReservationStatus;
  reservedImages: number;
}

const FREE_RETRY_LIMIT = Math.max(0, Number(process.env.FREE_RETRY_LIMIT || 1));
const FREE_EDIT_LIMIT = Math.max(0, Number(process.env.FREE_EDIT_LIMIT || 3));
const FREE_COUNTER_TTL_SECONDS = Math.max(24 * 60 * 60, Number(process.env.FREE_COUNTER_TTL_SECONDS || 180 * 24 * 60 * 60));

type FreeCounterConsumeResult = {
  allowed: boolean;
  count: number;
  limit: number;
};

async function atomicConsumeCounter(key: string, limit: number): Promise<FreeCounterConsumeResult> {
  const redis = getRedis();
  const redisAny = redis as any;

  if (typeof redisAny.eval !== "function") {
    // Fallback for in-memory test/mock clients that don't implement Lua.
    const current = Number((await redis.get(key)) || 0);
    if (current >= limit) {
      return { allowed: false, count: current, limit };
    }
    const next = current + 1;
    await redis.set(key, String(next));
    if (next === 1 && typeof redisAny.expire === "function") {
      await redisAny.expire(key, FREE_COUNTER_TTL_SECONDS);
    }
    return { allowed: true, count: next, limit };
  }

  const script = `
    local key = KEYS[1]
    local limit = tonumber(ARGV[1])
    local ttl = tonumber(ARGV[2])
    local value = redis.call('INCR', key)
    if ttl > 0 and value == 1 then
      redis.call('EXPIRE', key, ttl)
    end
    if value > limit then
      redis.call('DECR', key)
      return {0, value - 1}
    end
    return {1, value}
  `;

  const evalRes = await redisAny.eval(script, {
    keys: [key],
    arguments: [String(limit), String(FREE_COUNTER_TTL_SECONDS)],
  });

  const arr = Array.isArray(evalRes) ? evalRes : [0, 0];
  const allowed = Number(arr[0] || 0) === 1;
  const count = Math.max(0, Number(arr[1] || 0));

  return { allowed, count, limit };
}

export async function consumeFreeRetryCount(params: {
  parentJobId: string;
  userId?: string;
}): Promise<FreeCounterConsumeResult> {
  const parentJobId = String(params.parentJobId || "").trim();
  const userId = String(params.userId || "").trim();
  if (!parentJobId) return { allowed: false, count: 0, limit: FREE_RETRY_LIMIT };
  const key = `usage:free-retry:${userId || "anon"}:${parentJobId}`;
  return atomicConsumeCounter(key, FREE_RETRY_LIMIT);
}

export async function getFreeRetryCount(params: {
  parentJobId: string;
  userId?: string;
}): Promise<FreeCounterConsumeResult> {
  const parentJobId = String(params.parentJobId || "").trim();
  const userId = String(params.userId || "").trim();
  if (!parentJobId) return { allowed: false, count: 0, limit: FREE_RETRY_LIMIT };
  const key = `usage:free-retry:${userId || "anon"}:${parentJobId}`;
  const redis = getRedis();
  const rawCount = Number((await redis.get(key)) || 0);
  const count = Number.isFinite(rawCount) ? Math.max(0, rawCount) : 0;
  return {
    allowed: count < FREE_RETRY_LIMIT,
    count,
    limit: FREE_RETRY_LIMIT,
  };
}

export async function consumeFreeEditCount(params: {
  imageId: string;
  userId?: string;
}): Promise<FreeCounterConsumeResult> {
  const imageId = String(params.imageId || "").trim();
  const userId = String(params.userId || "").trim();
  if (!imageId) return { allowed: false, count: 0, limit: FREE_EDIT_LIMIT };
  const key = `usage:free-edit:${userId || "anon"}:${imageId}`;
  return atomicConsumeCounter(key, FREE_EDIT_LIMIT);
}

async function getPlanLimitForAgency(agencyId: string): Promise<number> {
  const agency = await getAgency(agencyId);
  const hasActiveStripeSubscription =
    !!agency?.stripeSubscriptionId &&
    (agency?.subscriptionStatus === "ACTIVE" || agency?.subscriptionStatus === "TRIAL");

  if (!hasActiveStripeSubscription) {
    return 0;
  }

  const tier = (agency?.planTier as PlanTier) || "starter";
  const limits = PLAN_LIMITS[tier];
  return limits.mainAllowance;
}

async function getBillingCycleKey(agencyId: string): Promise<string> {
  try {
    const agency = await getAgency(agencyId);
    if (agency?.currentPeriodStart) {
      return agency.currentPeriodStart.slice(0, 10);
    }
  } catch (err) {
    console.warn(`[USAGE] Billing cycle key fallback for ${agencyId}:`, err);
  }
  return getCurrentMonthKey();
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
     ON CONFLICT (agency_id, yyyymm) DO UPDATE
       SET included_limit = EXCLUDED.included_limit,
           updated_at = NOW();`,
    [agencyId, monthKey, includedLimit]
  );
  const res = await client.query(
    `SELECT * FROM agency_month_usage WHERE agency_id = $1 AND yyyymm = $2 FOR UPDATE`,
    [agencyId, monthKey]
  );
  return res.rows[0];
}

function buildSnapshot(row: any, addonRemaining: number, monthKey: string): UsageSnapshot {
  const safeAddon = Math.max(0, addonRemaining);
  const includedRemaining = Math.max(0, row.included_limit - row.included_used);
  return {
    includedLimit: row.included_limit,
    includedUsed: row.included_used,
    includedRemaining,
    addonBalance: safeAddon,
    addonRemaining: safeAddon,
    addonUsed: row.addon_used,
    remaining: includedRemaining + safeAddon,
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
  const monthKey = await getBillingCycleKey(params.agencyId);
  return withTransaction(async (client) => {
    const includedLimit = await getPlanLimitForAgency(params.agencyId);
    const agency = await getAgency(params.agencyId);
    await upsertAgencyAccount(client, params.agencyId, includedLimit, agency?.planTier ?? undefined);
    const acct = await lockAgencyAccount(client, params.agencyId);
    const usage = await ensureMonthUsage(client, params.agencyId, monthKey, includedLimit);

    const includedRemaining = Math.max(0, usage.included_limit - usage.included_used);
    const addonRemaining = await getTotalBundleRemaining(params.agencyId, monthKey);
    const listingPackCredits = Math.max(0, Number(acct.listing_pack_credits || 0));
    const totalRemaining = includedRemaining + addonRemaining + listingPackCredits;
    if (params.requiredImages > totalRemaining) {
      const snap = buildSnapshot(usage, addonRemaining, monthKey);
      const err: any = new Error("QUOTA_EXCEEDED");
      err.code = "QUOTA_EXCEEDED";
      err.snapshot = snap;
      throw err;
    }

    // Allocate sequentially: Stage12 first (if requested), then Stage2.
    // Priority: included → add-on → listing pack (cheapest first, listing pack last).
    const allocations: { stage: "1" | "2"; fromIncluded: number; fromAddon: number; fromListingPack: number }[] = [];
    let remainingNeed = params.requiredImages;
    let remainingIncluded = includedRemaining;
    let remainingAddon = addonRemaining;
    let remainingListingPack = listingPackCredits;

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
      const takeListingPack = Math.min(remainingNeed, remainingListingPack);
      remainingListingPack -= takeListingPack;
      remainingNeed -= takeListingPack;
      allocations.push({ stage: s.key, fromIncluded: takeIncluded, fromAddon: takeAddon, fromListingPack: takeListingPack });
    }

    const reservedFromIncluded = allocations.reduce((sum, a) => sum + a.fromIncluded, 0);
    const reservedFromAddon = allocations.reduce((sum, a) => sum + a.fromAddon, 0);
    const reservedFromListingPack = allocations.reduce((sum, a) => sum + a.fromListingPack, 0);

    const stage1Alloc = allocations.find((a) => a.stage === "1") || { fromIncluded: 0, fromAddon: 0, fromListingPack: 0 };
    const stage2Alloc = allocations.find((a) => a.stage === "2") || { fromIncluded: 0, fromAddon: 0, fromListingPack: 0 };

    if (reservedFromListingPack > 0) {
      console.log(
        `[USAGE] Listing pack credits used: ${reservedFromListingPack} for job ${params.jobId} (agency ${params.agencyId})`
      );
    }

    await client.query(
      `INSERT INTO job_reservations (
         job_id, agency_id, user_id, yyyymm,
         requested_stage12, requested_stage2,
         reserved_images, reservation_status,
         reserved_stage12, reserved_stage2,
         reserved_from_included, reserved_from_addon, reserved_from_listing_pack,
         stage12_from_included, stage12_from_addon, stage12_from_listing_pack,
         stage2_from_included, stage2_from_addon, stage2_from_listing_pack,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),NOW())
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
        reservedFromListingPack,
        stage1Alloc.fromIncluded,
        stage1Alloc.fromAddon,
        stage1Alloc.fromListingPack,
        stage2Alloc.fromIncluded,
        stage2Alloc.fromAddon,
        stage2Alloc.fromListingPack,
      ]
    );

    const snapshot = buildSnapshot(usage, addonRemaining, monthKey);

    return {
      ...snapshot,
      jobId: params.jobId,
      status: "reserved",
      reservedImages: params.requiredImages,
    };
  });
}

export async function commitReservation(params: { jobId: string }): Promise<void> {
  await withTransaction(async (client) => {
    const res = await client.query(
      `SELECT * FROM job_reservations WHERE job_id = $1 FOR UPDATE`,
      [params.jobId]
    );
    if (res.rowCount === 0) return;

    const jr = res.rows[0];
    const status = String(jr.reservation_status || "");

    // Idempotency: commit can be safely retried.
    if (status === "committed" || status === "consumed" || status === "released" || status === "partially_released") {
      return;
    }

    if (status !== "reserved") {
      return;
    }

    const reserveIncluded = Math.max(0, Number(jr.reserved_from_included || 0));
    const reserveAddon = Math.max(0, Number(jr.reserved_from_addon || 0));
    const reserveListingPack = Math.max(0, Number(jr.reserved_from_listing_pack || 0));

    if (reserveIncluded > 0 || reserveAddon > 0) {
      await client.query(
        `UPDATE agency_month_usage
           SET included_used = included_used + $1,
               addon_used = addon_used + $2,
               updated_at = NOW()
         WHERE agency_id = $3 AND yyyymm = $4`,
        [reserveIncluded, reserveAddon, jr.agency_id, jr.yyyymm]
      );

      // addon_images_balance is legacy; bundles are tracked in Redis. Keep update for backward compatibility.
      await client.query(
        `UPDATE agency_accounts
           SET addon_images_balance = addon_images_balance - $1,
               updated_at = NOW()
         WHERE agency_id = $2`,
        [reserveAddon, jr.agency_id]
      );
    }

    // Deduct listing pack credits from agency_accounts
    if (reserveListingPack > 0) {
      await client.query(
        `UPDATE agency_accounts
           SET listing_pack_credits = GREATEST(0, listing_pack_credits - $1),
               updated_at = NOW()
         WHERE agency_id = $2`,
        [reserveListingPack, jr.agency_id]
      );
      console.log(
        `[USAGE] Committed listing pack credits: -${reserveListingPack} for job ${params.jobId} (agency ${jr.agency_id})`
      );
    }

    await client.query(
      `UPDATE job_reservations
         SET reservation_status = 'committed',
             updated_at = NOW()
       WHERE job_id = $1`,
      [params.jobId]
    );
  });
}

export async function releaseReservation(params: { jobId: string }): Promise<void> {
  await withTransaction(async (client) => {
    const res = await client.query(
      `SELECT reservation_status FROM job_reservations WHERE job_id = $1 FOR UPDATE`,
      [params.jobId]
    );
    if (res.rowCount === 0) return;

    const status = String(res.rows[0].reservation_status || "");
    if (status === "reserved") {
      await client.query(
        `UPDATE job_reservations
           SET reservation_status = 'released',
               updated_at = NOW()
         WHERE job_id = $1`,
        [params.jobId]
      );
    }
  });
}

export async function finalizeReservation(params: {
  jobId: string;
  stage12Success: boolean;
  stage2Success: boolean;
}): Promise<void> {
  // ✅ PATCH 4: Edit jobs safety guard
  // Region edit jobs (jobType="region_edit") never create reservations via reserveAllowance
  // so they will naturally have rowCount=0 below and exit early (no billing).
  // This is the primary safety mechanism ensuring edits consume 0 credits.
  
  await withTransaction(async (client) => {
    const res = await client.query(
      `SELECT * FROM job_reservations WHERE job_id = $1 FOR UPDATE`,
      [params.jobId]
    );
    
    // ✅ No reservation = no billing. This catches all non-billable jobs including edits.
    if (res.rowCount === 0) return;
    const jr = res.rows[0];

    const rs = String(jr.reservation_status || "");
    if (rs === "consumed" || rs === "released") {
      return;
    }

    // If a job never reached commit, there was never a deduction to refund.
    if (rs === "reserved") {
      await client.query(
        `UPDATE job_reservations
           SET reservation_status = 'released',
               stage12_consumed = FALSE,
               stage2_consumed = FALSE,
               updated_at = NOW()
         WHERE job_id = $1`,
        [params.jobId]
      );
      return;
    }

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
    let refundListingPack = 0;
    let consumeStage12 = false;
    let consumeStage2 = false;

    if (jr.requested_stage12) {
      if (params.stage12Success) {
        consumeStage12 = true;
      } else {
        refundIncluded += jr.stage12_from_included;
        refundAddon += jr.stage12_from_addon;
        refundListingPack += Math.max(0, Number(jr.stage12_from_listing_pack || 0));
      }
    }

    if (jr.requested_stage2) {
      if (params.stage2Success) {
        consumeStage2 = true;
      } else {
        refundIncluded += jr.stage2_from_included;
        refundAddon += jr.stage2_from_addon;
        refundListingPack += Math.max(0, Number(jr.stage2_from_listing_pack || 0));
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

    // Refund listing pack credits on failed stages
    if (refundListingPack > 0) {
      await client.query(
        `UPDATE agency_accounts
           SET listing_pack_credits = listing_pack_credits + $1,
               updated_at = NOW()
         WHERE agency_id = $2`,
        [refundListingPack, jr.agency_id]
      );
      console.log(
        `[USAGE] Refunded listing pack credits: +${refundListingPack} for job ${params.jobId} (agency ${jr.agency_id})`
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

    // Consume bundle allowance on success (after monthly allowance allocation)
    const addonToConsume = (consumeStage12 ? jr.stage12_from_addon : 0) + (consumeStage2 ? jr.stage2_from_addon : 0);
    if (addonToConsume > 0) {
      await consumeBundleImages(jr.agency_id, addonToConsume, jr.yyyymm);
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

/**
 * ✅ CHECK 4: Increment retry count for MANUAL retries only
 * 
 * Scope: Per parent jobId (not per user, not per imageId)
 * 
 * This function is ONLY called by:
 * - /api/batch/retry-single (manual retry route)
 *
 * Legacy /api/retry is deprecated and disabled.
 * 
 * NOT called by:
 * - validator_retry (auto-retry after false positive) - FREE
 * - system_retry (auto-retry after worker crash) - FREE
 * 
 * Enforces: Max 2 manual retries per parent job
 * 
 * @param jobId - The parent job ID to track retries against
 * @returns locked: true if retry limit exceeded, retryCount: current count
 */
export async function incrementRetry(jobId: string): Promise<{ locked: boolean; retryCount: number }> {
  const res = await pool.query(
    `UPDATE job_reservations
       SET retry_count = retry_count + 1,
           amendments_locked = CASE WHEN retry_count + 1 > 2 THEN TRUE ELSE amendments_locked END,
           updated_at = NOW()
     WHERE job_id = $1
     RETURNING retry_count, amendments_locked`,
    [jobId]
  );
  if (res.rowCount === 0) return { locked: false, retryCount: 0 };
  const row = res.rows[0];
  
  // ✅ RETRY CAP: Log when cap is reached
  if (row.amendments_locked && row.retry_count > 2) {
    console.log(`[RETRY_CAP_REACHED] jobId=${jobId} retryCount=${row.retry_count}`);
  }
  
  return { locked: row.amendments_locked, retryCount: row.retry_count };
}

export async function incrementEdit(jobId: string): Promise<{ locked: boolean; editCount: number }> {
  const res = await pool.query(
    `UPDATE job_reservations
       SET edit_count = edit_count + 1,
           amendments_locked = CASE WHEN edit_count + 1 > 2 THEN TRUE ELSE amendments_locked END,
           updated_at = NOW()
     WHERE job_id = $1
     RETURNING edit_count, amendments_locked`,
    [jobId]
  );
  if (res.rowCount === 0) return { locked: false, editCount: 0 };
  const row = res.rows[0];
  
  // ✅ EDIT CAP: Log when cap is reached
  if (row.amendments_locked && row.edit_count > 2) {
    console.log(`[EDIT_CAP_REACHED] jobId=${jobId} editCount=${row.edit_count}`);
  }
  
  return { locked: row.amendments_locked, editCount: row.edit_count };
}

export async function getUsageSnapshot(agencyId: string): Promise<UsageSnapshot> {
  const monthKey = await getBillingCycleKey(agencyId);
  return withTransaction(async (client) => {
    const includedLimit = await getPlanLimitForAgency(agencyId);
    const agency = await getAgency(agencyId);
    await upsertAgencyAccount(client, agencyId, includedLimit, agency?.planTier ?? undefined);
    const usage = await ensureMonthUsage(client, agencyId, monthKey, includedLimit);
    const addonRemaining = await getTotalBundleRemaining(agencyId, monthKey);
    return buildSnapshot(usage, addonRemaining, monthKey);
  });
}

export async function getTopUsersByUsage(agencyId: string): Promise<Array<{ userId: string; used: number }>> {
  const monthKey = await getBillingCycleKey(agencyId);
  const res = await pool.query(
    `SELECT user_id, SUM(charge_amount) AS used
     FROM job_reservations
     WHERE agency_id = $1 AND yyyymm = $2 AND user_id IS NOT NULL
       AND charge_finalized = TRUE
     GROUP BY user_id
     ORDER BY used DESC
     LIMIT 10`,
    [agencyId, monthKey]
  );
  return res.rows.map((r) => ({ userId: r.user_id as string, used: Number(r.used) || 0 }));
}

export async function detachTrialUsageFromIncludedAllowance(params: {
  agencyId: string;
  trialCreditsUsed: number;
}): Promise<{ adjusted: boolean; monthKey?: string; includedUsed?: number; detachedAmount?: number }> {
  return withTransaction(async (client) => {
    return detachTrialUsageFromIncludedAllowanceInTransaction(client, params);
  });
}

export async function detachTrialUsageFromIncludedAllowanceInTransaction(
  client: PoolClient,
  params: {
    agencyId: string;
    trialCreditsUsed: number;
  }
): Promise<{ adjusted: boolean; monthKey?: string; includedUsed?: number; detachedAmount?: number }> {
  const trialCreditsUsed = Math.max(0, Number(params.trialCreditsUsed || 0));
  if (!params.agencyId || trialCreditsUsed <= 0) {
    return { adjusted: false };
  }

  const currentMonthKey = getCurrentMonthKey();

  const targetRes = await client.query<{ yyyymm: string; included_used: number }>(
      `SELECT yyyymm
             , included_used
         FROM agency_month_usage
        WHERE agency_id = $1
        ORDER BY CASE WHEN yyyymm = $2 THEN 0 ELSE 1 END, updated_at DESC
        LIMIT 1
        FOR UPDATE`,
      [params.agencyId, currentMonthKey]
  );

  if (!targetRes.rowCount) {
    return { adjusted: false };
  }

  const monthKey = String(targetRes.rows[0].yyyymm);
  const includedUsedBefore = Math.max(0, Number(targetRes.rows[0].included_used || 0));
  const detachedAmount = Math.max(0, Math.min(includedUsedBefore, trialCreditsUsed));

  const updateRes = await client.query<{ included_used: number }>(
      `UPDATE agency_month_usage
          SET included_used = GREATEST(0, included_used - $3),
              updated_at = NOW()
        WHERE agency_id = $1
          AND yyyymm = $2
      RETURNING included_used`,
      [params.agencyId, monthKey, trialCreditsUsed]
  );

  return {
    adjusted: (updateRes.rowCount ?? 0) > 0,
    monthKey,
    includedUsed: Number(updateRes.rows[0]?.included_used ?? 0),
    detachedAmount,
  };
}
