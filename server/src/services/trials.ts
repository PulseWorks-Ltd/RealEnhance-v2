import crypto from "node:crypto";
import { pool, withTransaction } from "../db/index.js";
import { getUserByEmail } from "./users.js";
import type { PoolClient } from "pg";

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

export async function markTrialConverted(agencyId: string): Promise<void> {
  await pool.query(
    `UPDATE organisations
        SET trial_status = 'converted',
            trial_credits_used = trial_credits_total,
            updated_at = NOW()
      WHERE agency_id = $1;`,
    [agencyId]
  );
}
