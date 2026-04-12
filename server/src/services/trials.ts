import crypto from "node:crypto";
import { createImageBundle, type AgencyImageBundle } from "@realenhance/shared/usage/imageBundles.js";
import { pool, withTransaction } from "../db/index.js";
import { getUserByEmail } from "./users.js";
import type { PoolClient } from "pg";
import { getAgency } from "@realenhance/shared/agencies.js";
import {
  LAUNCH_TRIAL_CREDITS,
  LAUNCH_TRIAL_DAYS,
  LAUNCH_TRIAL_MAX_AGENCIES,
} from "../config.js";
import { detachTrialUsageFromIncludedAllowanceInTransaction } from "./usageLedger.js";

export type TrialStatus = "none" | "pending" | "active" | "expired" | "converted";

export interface TrialSummary {
  status: TrialStatus;
  expiresAt?: string | null;
  creditsTotal: number;
  creditsUsed: number;
  remaining: number;
  promoCodeId?: number | null;
}

export interface PromoCodeRow {
  id: number;
  code: string;
  code_normalized: string;
  is_active: boolean;
  expires_at: string | null;
  max_redemptions: number | null;
  redemptions_count: number;
  trial_days: number;
  credits_granted: number;
}

const UNRESTRICTED_CREDIT_PROMO_CODES = new Set<string>([
  "giveme100",
]);

const PROMO_CREDIT_GRANT_SOURCE = "promo_code_credit_grant";

export interface TrialOrgRow {
  agency_id: string;
  trial_status: TrialStatus;
  trial_expires_at: string | null;
  trial_credits_total: number;
  trial_credits_used: number;
  trial_promo_code_id: number | null;
}

export function normalizeEmail(raw: string): string {
  const trimmed = (raw || "").trim().toLowerCase();
  const [local = "", domain = ""] = trimmed.split("@");
  if (!domain) return trimmed;
  if (domain === "gmail.com" || domain === "googlemail.com") {
    const baseLocal = local.split("+")[0].replace(/\./g, "");
    return `${baseLocal}@gmail.com`;
  }
  return `${local}@${domain}`;
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function fetchPromoByCode(client: PoolClient, codeRaw: string): Promise<PromoCodeRow | null> {
  const codeNormalized = codeRaw.trim().toLowerCase();
  const res = await client.query<PromoCodeRow>(
    `SELECT * FROM promo_codes WHERE code_normalized = $1 FOR UPDATE`,
    [codeNormalized]
  );
  return res.rowCount ? res.rows[0] : null;
}

function isUnrestrictedCreditPromo(promo: PromoCodeRow): boolean {
  return UNRESTRICTED_CREDIT_PROMO_CODES.has(String(promo.code_normalized || "").trim().toLowerCase());
}

async function ensureTrialRow(client: PoolClient, agencyId: string): Promise<TrialOrgRow> {
  const res = await client.query<TrialOrgRow>(
    `INSERT INTO organisations (agency_id)
     VALUES ($1)
     ON CONFLICT (agency_id) DO NOTHING
     RETURNING agency_id, trial_status, trial_expires_at, trial_credits_total, trial_credits_used, trial_promo_code_id;`,
    [agencyId]
  );
  if (res.rowCount) return res.rows[0];
  const existing = await client.query<TrialOrgRow>(
    `SELECT agency_id, trial_status, trial_expires_at, trial_credits_total, trial_credits_used, trial_promo_code_id
       FROM organisations WHERE agency_id = $1 FOR UPDATE`,
    [agencyId]
  );
  return existing.rows[0];
}

async function hasAgencyHadPaidSubscription(client: PoolClient, agencyId: string): Promise<boolean> {
  const agency = await getAgency(agencyId);
  if (
    agency?.stripeSubscriptionId ||
    agency?.stripePriceId ||
    agency?.currentPeriodStart ||
    agency?.currentPeriodEnd ||
    agency?.subscriptionStatus === "ACTIVE" ||
    agency?.subscriptionStatus === "PAST_DUE" ||
    agency?.subscriptionStatus === "CANCELLED"
  ) {
    return true;
  }

  const priorInvoice = await client.query(
    `SELECT 1 FROM addon_purchases WHERE agency_id = $1 AND source = 'subscription_invoice' LIMIT 1`,
    [agencyId]
  );

  return (priorInvoice.rowCount ?? 0) > 0;
}

function hasAgencyUsedAnyTrial(trial: TrialOrgRow): boolean {
  return (
    trial.trial_status !== "none" ||
    Number(trial.trial_credits_total || 0) > 0 ||
    Number(trial.trial_credits_used || 0) > 0 ||
    trial.trial_promo_code_id !== null ||
    trial.trial_expires_at !== null
  );
}

export async function assertEligibleForTrial(email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  const existing = await getUserByEmail(normalized);
  if (existing) {
    const err: any = new Error("EMAIL_EXISTS");
    err.code = "EMAIL_EXISTS";
    throw err;
  }

  const emailHash = sha256(normalized);
  const claimed = await pool.query(`SELECT 1 FROM trial_claims WHERE email_hash = $1`, [emailHash]);
  if (claimed.rowCount) {
    const err: any = new Error("TRIAL_ALREADY_CLAIMED");
    err.code = "TRIAL_ALREADY_CLAIMED";
    throw err;
  }
}

export async function recordTrialStart(params: {
  agencyId: string;
  emailNormalized: string;
  promoCode: string;
  ipHash?: string;
  uaHash?: string;
}): Promise<{ trial: TrialOrgRow; promo: PromoCodeRow }>
{
  const emailHash = sha256(params.emailNormalized);
  const now = new Date();

  return withTransaction(async (client) => {
    const promo = await fetchPromoByCode(client, params.promoCode);
    if (!promo) {
      const err: any = new Error("INVALID_PROMO");
      err.code = "INVALID_PROMO";
      throw err;
    }
    if (!promo.is_active) {
      const err: any = new Error("PROMO_INACTIVE");
      err.code = "PROMO_INACTIVE";
      throw err;
    }
    if (promo.expires_at && new Date(promo.expires_at) < now) {
      const err: any = new Error("PROMO_EXPIRED");
      err.code = "PROMO_EXPIRED";
      throw err;
    }
    if (promo.max_redemptions !== null && promo.redemptions_count >= promo.max_redemptions) {
      const err: any = new Error("PROMO_MAXED");
      err.code = "PROMO_MAXED";
      throw err;
    }

    const existingClaim = await client.query(`SELECT 1 FROM trial_claims WHERE email_hash = $1 FOR UPDATE`, [emailHash]);
    if (existingClaim.rowCount) {
      const err: any = new Error("TRIAL_ALREADY_CLAIMED");
      err.code = "TRIAL_ALREADY_CLAIMED";
      throw err;
    }

    const expiresAt = new Date(now.getTime() + promo.trial_days * 24 * 60 * 60 * 1000);

    await ensureTrialRow(client, params.agencyId);
    const trialRes = await client.query<TrialOrgRow>(
      `UPDATE organisations
         SET trial_status = 'active',
             trial_expires_at = $2,
             trial_credits_total = $3,
             trial_credits_used = 0,
             trial_promo_code_id = $4,
             updated_at = NOW()
       WHERE agency_id = $1
       RETURNING agency_id, trial_status, trial_expires_at, trial_credits_total, trial_credits_used, trial_promo_code_id;`,
      [params.agencyId, expiresAt.toISOString(), promo.credits_granted, promo.id]
    );

    await client.query(
      `INSERT INTO trial_claims (email_hash, promo_code_id, org_id, ip_hash, ua_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email_hash) DO NOTHING;`,
      [emailHash, promo.id, params.agencyId, params.ipHash || null, params.uaHash || null]
    );

    await client.query(
      `UPDATE promo_codes
          SET redemptions_count = redemptions_count + 1,
              updated_at = NOW()
        WHERE id = $1;`,
      [promo.id]
    );

    return { trial: trialRes.rows[0], promo };
  });
}

export async function redeemPromoForExistingAgency(params: {
  agencyId: string;
  email: string;
  promoCode: string;
}): Promise<{ trial: TrialOrgRow; promo: PromoCodeRow }> {
  const emailNormalized = normalizeEmail(params.email);
  const emailHash = sha256(emailNormalized);
  const now = new Date();

  return withTransaction(async (client) => {
    const promo = await fetchPromoByCode(client, params.promoCode);
    if (!promo) {
      const err: any = new Error("INVALID_PROMO");
      err.code = "INVALID_PROMO";
      throw err;
    }
    if (!promo.is_active) {
      const err: any = new Error("PROMO_INACTIVE");
      err.code = "PROMO_INACTIVE";
      throw err;
    }
    if (promo.expires_at && new Date(promo.expires_at) < now) {
      const err: any = new Error("PROMO_EXPIRED");
      err.code = "PROMO_EXPIRED";
      throw err;
    }
    if (promo.max_redemptions !== null && promo.redemptions_count >= promo.max_redemptions) {
      const err: any = new Error("PROMO_MAXED");
      err.code = "PROMO_MAXED";
      throw err;
    }

    const existingClaim = await client.query(`SELECT 1 FROM trial_claims WHERE email_hash = $1 FOR UPDATE`, [emailHash]);
    if (existingClaim.rowCount) {
      const err: any = new Error("TRIAL_ALREADY_CLAIMED");
      err.code = "TRIAL_ALREADY_CLAIMED";
      throw err;
    }

    const trial = await ensureTrialRow(client, params.agencyId);
    if (hasAgencyUsedAnyTrial(trial)) {
      const err: any = new Error("AGENCY_ALREADY_USED_TRIAL");
      err.code = "AGENCY_ALREADY_USED_TRIAL";
      throw err;
    }

    const hadSubscription = await hasAgencyHadPaidSubscription(client, params.agencyId);
    if (hadSubscription) {
      const err: any = new Error("AGENCY_PREVIOUSLY_SUBSCRIBED");
      err.code = "AGENCY_PREVIOUSLY_SUBSCRIBED";
      throw err;
    }

    const expiresAt = new Date(now.getTime() + promo.trial_days * 24 * 60 * 60 * 1000);

    const trialRes = await client.query<TrialOrgRow>(
      `UPDATE organisations
          SET trial_status = 'active',
              trial_expires_at = $2,
              trial_credits_total = $3,
              trial_credits_used = 0,
              trial_promo_code_id = $4,
              updated_at = NOW()
        WHERE agency_id = $1
        RETURNING agency_id, trial_status, trial_expires_at, trial_credits_total, trial_credits_used, trial_promo_code_id;`,
      [params.agencyId, expiresAt.toISOString(), promo.credits_granted, promo.id]
    );

    await client.query(
      `INSERT INTO trial_claims (email_hash, promo_code_id, org_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (email_hash) DO NOTHING;`,
      [emailHash, promo.id, params.agencyId]
    );

    await client.query(
      `UPDATE promo_codes
          SET redemptions_count = redemptions_count + 1,
              updated_at = NOW()
        WHERE id = $1;`,
      [promo.id]
    );

    return { trial: trialRes.rows[0], promo };
  });
}

export async function redeemCreditPromoForExistingAgency(params: {
  agencyId: string;
  promoCode: string;
}): Promise<{ promo: PromoCodeRow; bundle: AgencyImageBundle; duplicated: boolean }> {
  const now = new Date();

  return withTransaction(async (client) => {
    const promo = await fetchPromoByCode(client, params.promoCode);
    if (!promo) {
      const err: any = new Error("INVALID_PROMO");
      err.code = "INVALID_PROMO";
      throw err;
    }
    if (!promo.is_active) {
      const err: any = new Error("PROMO_INACTIVE");
      err.code = "PROMO_INACTIVE";
      throw err;
    }
    if (promo.expires_at && new Date(promo.expires_at) < now) {
      const err: any = new Error("PROMO_EXPIRED");
      err.code = "PROMO_EXPIRED";
      throw err;
    }
    if (!isUnrestrictedCreditPromo(promo)) {
      const err: any = new Error("PROMO_NOT_CREDIT_GRANT");
      err.code = "PROMO_NOT_CREDIT_GRANT";
      throw err;
    }
    if (promo.max_redemptions !== null && promo.redemptions_count >= promo.max_redemptions) {
      const err: any = new Error("PROMO_MAXED");
      err.code = "PROMO_MAXED";
      throw err;
    }

    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `${PROMO_CREDIT_GRANT_SOURCE}:${params.agencyId}:${promo.code_normalized}`,
    ]);

    const existingGrant = await client.query<{
      quantity: number;
      metadata: Record<string, any> | null;
    }>(
      `SELECT quantity, metadata
         FROM addon_purchases
        WHERE agency_id = $1
          AND source = $2
          AND metadata ->> 'promoCodeNormalized' = $3
        LIMIT 1`,
      [params.agencyId, PROMO_CREDIT_GRANT_SOURCE, promo.code_normalized]
    );

    if (existingGrant.rowCount && existingGrant.rows[0]?.metadata) {
      const existingMetadata = existingGrant.rows[0].metadata || {};
      return {
        promo,
        duplicated: true,
        bundle: {
          id: String(existingMetadata.bundleId || `promo_credit_${promo.id}_${params.agencyId}`),
          agencyId: params.agencyId,
          monthKey: String(existingMetadata.monthKey || ""),
          bundleType: "promo",
          bundleCode: String(existingMetadata.bundleCode || `PROMO_${promo.code_normalized.toUpperCase()}`),
          imagesPurchased: Number(existingGrant.rows[0].quantity || promo.credits_granted || 0),
          imagesUsed: 0,
          stripePaymentIntentId: String(existingMetadata.paymentIntentId || `${PROMO_CREDIT_GRANT_SOURCE}:${promo.id}:${params.agencyId}`),
          stripeSessionId: String(existingMetadata.sessionId || `${PROMO_CREDIT_GRANT_SOURCE}:${promo.code_normalized}`),
          purchasedAt: String(existingMetadata.grantedAt || now.toISOString()),
          expiresAt: String(existingMetadata.expiresAt || now.toISOString()),
        },
      };
    }

    const bundleCode = `PROMO_${promo.code_normalized.toUpperCase()}`;
    const paymentIntentId = `${PROMO_CREDIT_GRANT_SOURCE}:${promo.id}:${params.agencyId}`;
    const sessionId = `${PROMO_CREDIT_GRANT_SOURCE}:${promo.code_normalized}`;
    const bundleResult = await createImageBundle({
      agencyId: params.agencyId,
      bundleType: "promo",
      bundleCode,
      imagesPurchased: promo.credits_granted,
      stripePaymentIntentId: paymentIntentId,
      stripeSessionId: sessionId,
      expiresInDays: promo.trial_days,
    });

    if (!bundleResult.created || !bundleResult.bundle) {
      throw new Error(`Failed to create promo credit bundle: ${bundleResult.reason || "unknown"}`);
    }

    await client.query(
      `INSERT INTO agency_accounts (agency_id, monthly_included_images, plan_tier, addon_images_balance)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agency_id) DO UPDATE
         SET addon_images_balance = agency_accounts.addon_images_balance + EXCLUDED.addon_images_balance,
             updated_at = NOW()`,
      [params.agencyId, 0, "starter", promo.credits_granted]
    );

    await client.query(
      `INSERT INTO addon_purchases (agency_id, quantity, source, metadata)
       VALUES ($1, $2, $3, $4)`,
      [
        params.agencyId,
        promo.credits_granted,
        PROMO_CREDIT_GRANT_SOURCE,
        JSON.stringify({
          type: "promo_code_credit_grant",
          promoCodeId: promo.id,
          promoCode: promo.code,
          promoCodeNormalized: promo.code_normalized,
          bundleId: bundleResult.bundle.id,
          bundleCode,
          paymentIntentId,
          sessionId,
          expiresAt: bundleResult.bundle.expiresAt,
          grantedAt: now.toISOString(),
          monthKey: bundleResult.bundle.monthKey,
        }),
      ]
    );

    await client.query(
      `UPDATE promo_codes
          SET redemptions_count = redemptions_count + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [promo.id]
    );

    return { promo, bundle: bundleResult.bundle, duplicated: false };
  });
}

export async function getTrialSummary(agencyId: string): Promise<TrialSummary> {
  const res = await pool.query<TrialOrgRow>(
    `SELECT agency_id, trial_status, trial_expires_at, trial_credits_total, trial_credits_used, trial_promo_code_id
       FROM organisations WHERE agency_id = $1`,
    [agencyId]
  );
  if (!res.rowCount) {
    return { status: "none", creditsTotal: 0, creditsUsed: 0, remaining: 0, expiresAt: null, promoCodeId: null };
  }
  const row = res.rows[0];
  const remaining = Math.max(0, (row.trial_credits_total || 0) - (row.trial_credits_used || 0));
  return {
    status: row.trial_status,
    expiresAt: row.trial_expires_at,
    creditsTotal: row.trial_credits_total,
    creditsUsed: row.trial_credits_used,
    remaining,
    promoCodeId: row.trial_promo_code_id,
  };
}

export async function reserveTrialCredits(params: { agencyId: string; jobId: string; requiredImages: number }): Promise<{
  allowed: boolean;
  reason?: string;
  remaining?: number;
  expiresAt?: string | null;
}> {
  const now = new Date();
  return withTransaction(async (client) => {
    const trialRes = await client.query<TrialOrgRow>(
      `SELECT agency_id, trial_status, trial_expires_at, trial_credits_total, trial_credits_used, trial_promo_code_id
         FROM organisations WHERE agency_id = $1 FOR UPDATE`,
      [params.agencyId]
    );
    if (!trialRes.rowCount) return { allowed: false, reason: "NO_TRIAL" };
    const trial = trialRes.rows[0];

    if (trial.trial_status === "converted") return { allowed: false, reason: "TRIAL_CONVERTED" };
    if (trial.trial_status === "expired") return { allowed: false, reason: "TRIAL_EXPIRED" };
    if (trial.trial_status !== "active") return { allowed: false, reason: "TRIAL_INACTIVE" };

    if (trial.trial_expires_at && new Date(trial.trial_expires_at) < now) {
      await client.query(
        `UPDATE organisations SET trial_status = 'expired', updated_at = NOW() WHERE agency_id = $1`,
        [params.agencyId]
      );
      return { allowed: false, reason: "TRIAL_EXPIRED" };
    }

    const remaining = Math.max(0, (trial.trial_credits_total || 0) - (trial.trial_credits_used || 0));
    if (remaining < params.requiredImages) {
      await client.query(
        `UPDATE organisations SET trial_status = 'expired', updated_at = NOW() WHERE agency_id = $1`,
        [params.agencyId]
      );
      return { allowed: false, reason: "TRIAL_DEPLETED", remaining };
    }

    await client.query(
      `UPDATE organisations
          SET trial_credits_used = trial_credits_used + $2,
              updated_at = NOW()
        WHERE agency_id = $1`,
      [params.agencyId, params.requiredImages]
    );

    await client.query(
      `INSERT INTO trial_reservations (job_id, agency_id, reserved_images, status)
         VALUES ($1, $2, $3, 'reserved')
       ON CONFLICT (job_id) DO UPDATE SET reserved_images = EXCLUDED.reserved_images, status = 'reserved', updated_at = NOW();`,
      [params.jobId, params.agencyId, params.requiredImages]
    );

    return { allowed: true, remaining: remaining - params.requiredImages, expiresAt: trial.trial_expires_at };
  });
}

export async function releaseTrialReservation(jobId: string): Promise<void> {
  await withTransaction(async (client) => {
    const res = await client.query(
      `SELECT job_id, agency_id, reserved_images, status FROM trial_reservations WHERE job_id = $1 FOR UPDATE`,
      [jobId]
    );
    if (!res.rowCount) return;
    const row = res.rows[0];
    if (row.status !== "reserved") return;

    await client.query(
      `UPDATE organisations
          SET trial_credits_used = GREATEST(0, trial_credits_used - $2),
              updated_at = NOW()
        WHERE agency_id = $1;`,
      [row.agency_id, row.reserved_images]
    );

    await client.query(
      `UPDATE trial_reservations SET status = 'released', updated_at = NOW() WHERE job_id = $1`,
      [jobId]
    );
  });
}

export async function markTrialConverted(agencyId: string): Promise<number> {
  return withTransaction(async (client) => {
    const result = await markTrialConvertedInTransaction(client, agencyId);
    return result.trialCreditsUsed;
  });
}

export async function markTrialConvertedInTransaction(
  client: PoolClient,
  agencyId: string
): Promise<{ converted: boolean; trialCreditsUsed: number }> {
  const res = await client.query<{ trial_credits_used: number; trial_credits_total: number }>(
    `UPDATE organisations
        SET trial_status = 'converted',
            trial_credits_used = trial_credits_total,
            updated_at = NOW()
      WHERE agency_id = $1
        AND trial_status <> 'converted'
      RETURNING trial_credits_used, trial_credits_total;`,
    [agencyId]
  );

  if (!res.rowCount) {
    return {
      converted: false,
      trialCreditsUsed: 0,
    };
  }

  const row = res.rows[0];
  return {
    converted: true,
    // Credits consumed prior to conversion should never reduce paid monthly allowance.
    trialCreditsUsed: Math.max(0, Number(row.trial_credits_used || 0)),
  };
}

export async function convertTrialAndDetachUsageIfNeeded(
  agencyId: string
): Promise<{
  converted: boolean;
  detachedAmount: number;
  trialCreditsUsed: number;
  monthKey?: string;
  includedUsed?: number;
}> {
  return withTransaction(async (client) => {
    const conversion = await markTrialConvertedInTransaction(client, agencyId);
    if (!conversion.converted) {
      return {
        converted: false,
        detachedAmount: 0,
        trialCreditsUsed: 0,
      };
    }

    if (conversion.trialCreditsUsed <= 0) {
      return {
        converted: true,
        detachedAmount: 0,
        trialCreditsUsed: 0,
      };
    }

    const detach = await detachTrialUsageFromIncludedAllowanceInTransaction(client, {
      agencyId,
      trialCreditsUsed: conversion.trialCreditsUsed,
    });

    return {
      converted: true,
      detachedAmount: Math.max(0, Number(detach.detachedAmount || 0)),
      trialCreditsUsed: conversion.trialCreditsUsed,
      monthKey: detach.monthKey,
      includedUsed: detach.includedUsed,
    };
  });
}

export async function grantLaunchTrialIfEligible(agencyId: string): Promise<{
  granted: boolean;
  allocated: number;
  max: number;
}> {
  const max = Math.max(0, Number(LAUNCH_TRIAL_MAX_AGENCIES || 0));
  const credits = Math.max(0, Number(LAUNCH_TRIAL_CREDITS || 0));
  const days = Math.max(0, Number(LAUNCH_TRIAL_DAYS || 0));

  if (!agencyId || max <= 0 || credits <= 0 || days <= 0) {
    return { granted: false, allocated: 0, max };
  }

  return withTransaction(async (client) => {
    // Single-writer gate to avoid race conditions around the launch threshold.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ["launch_trial_gate_v1"]);

    const org = await ensureTrialRow(client, agencyId);
    const alreadyLaunchGranted =
      org.trial_promo_code_id === null
      && Number(org.trial_credits_total || 0) === credits
      && org.trial_expires_at !== null;

    const countRes = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM organisations
        WHERE trial_promo_code_id IS NULL
          AND trial_credits_total = $1
          AND trial_expires_at IS NOT NULL`,
      [credits]
    );
    const allocated = Number(countRes.rows[0]?.count || 0);

    if (alreadyLaunchGranted) {
      return { granted: false, allocated, max };
    }

    if (allocated >= max) {
      return { granted: false, allocated, max };
    }

    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await client.query(
      `UPDATE organisations
          SET trial_status = 'active',
              trial_expires_at = $2,
              trial_credits_total = $3,
              trial_credits_used = 0,
              trial_promo_code_id = NULL,
              updated_at = NOW()
        WHERE agency_id = $1`,
      [agencyId, expiresAt.toISOString(), credits]
    );

    return { granted: true, allocated: allocated + 1, max };
  });
}
