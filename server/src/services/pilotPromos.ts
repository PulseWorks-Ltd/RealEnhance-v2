// server/src/services/pilotPromos.ts
// Pilot promo redemption and credit management.
// Pilot credits are stored separately from subscription/add-on credits and
// expire 30 days after redemption. They are spent before any other credit
// source (see usageLedger.ts for priority integration).

import type { PoolClient } from "pg";
import { pool, withTransaction } from "../db/index.js";
import {
  PILOT_PROMOS,
  getAvailablePromoCredits,
  type PilotPromoInfo,
} from "@realenhance/shared/pilotPromos.js";

// ─────────────────────────────────────────────────────────────────────────────
// DB row types
// ─────────────────────────────────────────────────────────────────────────────

export interface PilotPromoRow {
  code: string;
  credits_granted: number;
  expiry_days: number;
  global_cap: number;
  total_redemptions: number;
  is_active: boolean;
}

export interface PilotPromoRedemptionRow {
  id: number;
  promo_code: string;
  agency_id: string | null;
  user_id: string;
  credits_granted: number;
  credits_used: number;
  redeemed_at: string;
  expires_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Redeem
// ─────────────────────────────────────────────────────────────────────────────

export interface RedeemPilotPromoParams {
  promoCode: string;
  userId: string;
  agencyId: string | null;
}

export interface RedeemPilotPromoResult {
  redemption: PilotPromoRedemptionRow;
  promoInfo: PilotPromoInfo;
}

/**
 * Atomically validate and redeem a pilot promo code for a user/agency.
 *
 * Enforces:
 *  - code must exist and be active (in pilot_promos table)
 *  - global cap: once total_redemptions reaches global_cap the code is invalid
 *  - per-user uniqueness: one redemption per (promo_code, user_id)
 *  - per-agency uniqueness: one redemption per (promo_code, agency_id) when agency is present
 *
 * Throws a structured error (err.code) on any violation.
 */
export async function redeemPilotPromo(
  params: RedeemPilotPromoParams
): Promise<RedeemPilotPromoResult> {
  const normalizedCode = params.promoCode.trim().toUpperCase();

  return withTransaction(async (client) => {
    // Lock the promo row to serialise concurrent redemption attempts.
    const promoRes = await client.query<PilotPromoRow>(
      `SELECT code, credits_granted, expiry_days, global_cap, total_redemptions, is_active
         FROM pilot_promos
        WHERE code = $1
        FOR UPDATE`,
      [normalizedCode]
    );

    if (!promoRes.rowCount) {
      throw Object.assign(new Error("Pilot promo not found"), { code: "PILOT_PROMO_NOT_FOUND" });
    }

    const promo = promoRes.rows[0];

    if (!promo.is_active) {
      throw Object.assign(new Error("Pilot promo is inactive"), { code: "PILOT_PROMO_INACTIVE" });
    }

    if (promo.total_redemptions >= promo.global_cap) {
      throw Object.assign(
        new Error(`Pilot promo ${normalizedCode} has reached its global redemption cap of ${promo.global_cap}`),
        { code: "PILOT_PROMO_GLOBAL_CAP_REACHED" }
      );
    }

    // Enforce per-user uniqueness.
    const userCheck = await client.query(
      `SELECT 1 FROM pilot_promo_redemptions WHERE promo_code = $1 AND user_id = $2`,
      [normalizedCode, params.userId]
    );
    if (userCheck.rowCount) {
      throw Object.assign(
        new Error(`User ${params.userId} has already redeemed pilot promo ${normalizedCode}`),
        { code: "PILOT_PROMO_ALREADY_REDEEMED_BY_USER" }
      );
    }

    // Enforce per-agency uniqueness when an agencyId is present.
    if (params.agencyId) {
      const agencyCheck = await client.query(
        `SELECT 1 FROM pilot_promo_redemptions WHERE promo_code = $1 AND agency_id = $2`,
        [normalizedCode, params.agencyId]
      );
      if (agencyCheck.rowCount) {
        throw Object.assign(
          new Error(`Agency ${params.agencyId} has already redeemed pilot promo ${normalizedCode}`),
          { code: "PILOT_PROMO_ALREADY_REDEEMED_BY_AGENCY" }
        );
      }
    }

    // All checks passed – create the redemption row.
    const expiresAt = new Date(Date.now() + promo.expiry_days * 24 * 60 * 60 * 1000).toISOString();

    const insertRes = await client.query<PilotPromoRedemptionRow>(
      `INSERT INTO pilot_promo_redemptions
         (promo_code, agency_id, user_id, credits_granted, credits_used, redeemed_at, expires_at)
       VALUES ($1, $2, $3, $4, 0, NOW(), $5)
       RETURNING id, promo_code, agency_id, user_id, credits_granted, credits_used,
                 redeemed_at::text, expires_at::text`,
      [normalizedCode, params.agencyId, params.userId, promo.credits_granted, expiresAt]
    );

    const redemption = insertRes.rows[0];

    // Increment global counter and deactivate if cap is now reached.
    const newTotal = promo.total_redemptions + 1;
    await client.query(
      `UPDATE pilot_promos
          SET total_redemptions = $1,
              is_active         = CASE WHEN $1 >= global_cap THEN FALSE ELSE is_active END,
              updated_at        = NOW()
        WHERE code = $2`,
      [newTotal, normalizedCode]
    );

    console.log(
      `[PILOT_PROMO] Redeemed ${normalizedCode} for user=${params.userId} agency=${params.agencyId ?? "none"} ` +
        `credits=${promo.credits_granted} expires=${expiresAt} (global total: ${newTotal}/${promo.global_cap})`
    );

    return {
      redemption,
      promoInfo: buildPilotPromoInfo(redemption),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Credit lookup helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the active (non-expired), not-fully-consumed pilot promo redemption for a
 * given agency or user, locking the row for the duration of the caller's
 * transaction. Returns null when no active redemption exists.
 *
 * Priority: agency-level match if agencyId is present; otherwise user-level.
 */
export async function getActiveRedemptionForUpdate(
  client: PoolClient,
  agencyId: string | null,
  userId: string
): Promise<PilotPromoRedemptionRow | null> {
  const now = new Date().toISOString();

  // Prefer agency-level redemption when the job belongs to an agency.
  if (agencyId) {
    const res = await client.query<PilotPromoRedemptionRow>(
      `SELECT id, promo_code, agency_id, user_id, credits_granted, credits_used,
              redeemed_at::text, expires_at::text
         FROM pilot_promo_redemptions
        WHERE agency_id = $1
          AND expires_at > $2
          AND credits_used < credits_granted
        ORDER BY expires_at ASC
        LIMIT 1
        FOR UPDATE`,
      [agencyId, now]
    );
    if (res.rowCount) return res.rows[0];
  }

  // Fall back to user-level redemption.
  const res = await client.query<PilotPromoRedemptionRow>(
    `SELECT id, promo_code, agency_id, user_id, credits_granted, credits_used,
            redeemed_at::text, expires_at::text
       FROM pilot_promo_redemptions
      WHERE user_id = $1
        AND expires_at > $2
        AND credits_used < credits_granted
      ORDER BY expires_at ASC
      LIMIT 1
      FOR UPDATE`,
    [userId, now]
  );
  if (res.rowCount) return res.rows[0];

  return null;
}

/**
 * Deduct pilot promo credits inside an ongoing transaction.
 * Safe to call with amount=0 (no-op).
 */
export async function consumePilotPromoCreditsInTx(
  client: PoolClient,
  redemptionId: number,
  amount: number
): Promise<void> {
  if (amount <= 0) return;
  await client.query(
    `UPDATE pilot_promo_redemptions
        SET credits_used = credits_used + $1,
            updated_at   = NOW()
      WHERE id = $2
        AND credits_used + $1 <= credits_granted`,
    [amount, redemptionId]
  );
}

/**
 * Refund pilot promo credits inside an ongoing transaction (on job failure).
 * Safe to call with amount=0 (no-op).
 */
export async function refundPilotPromoCreditsInTx(
  client: PoolClient,
  redemptionId: number,
  amount: number
): Promise<void> {
  if (amount <= 0) return;
  await client.query(
    `UPDATE pilot_promo_redemptions
        SET credits_used = GREATEST(0, credits_used - $1),
            updated_at   = NOW()
      WHERE id = $2`,
    [amount, redemptionId]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary / visibility
// ─────────────────────────────────────────────────────────────────────────────

function buildPilotPromoInfo(row: PilotPromoRedemptionRow): PilotPromoInfo {
  return {
    promoType: row.promo_code,
    promoCreditsGranted: row.credits_granted,
    promoCreditsRemaining: getAvailablePromoCredits(row),
    promoRedeemedAt: row.redeemed_at,
    promoExpiresAt: row.expires_at,
  };
}

/**
 * Returns the active pilot promo summary for billing/account payloads.
 * Returns null when no active redemption is found.
 */
export async function getPilotPromoSummary(
  agencyId: string | null,
  userId: string
): Promise<PilotPromoInfo | null> {
  const now = new Date().toISOString();

  // Agency-level first.
  if (agencyId) {
    const res = await pool.query<PilotPromoRedemptionRow>(
      `SELECT id, promo_code, agency_id, user_id, credits_granted, credits_used,
              redeemed_at::text, expires_at::text
         FROM pilot_promo_redemptions
        WHERE agency_id = $1
          AND expires_at > $2
          AND credits_used < credits_granted
        ORDER BY expires_at ASC
        LIMIT 1`,
      [agencyId, now]
    );
    if (res.rowCount) return buildPilotPromoInfo(res.rows[0]);
  }

  // User-level fallback.
  const res = await pool.query<PilotPromoRedemptionRow>(
    `SELECT id, promo_code, agency_id, user_id, credits_granted, credits_used,
            redeemed_at::text, expires_at::text
       FROM pilot_promo_redemptions
      WHERE user_id = $1
        AND expires_at > $2
        AND credits_used < credits_granted
      ORDER BY expires_at ASC
      LIMIT 1`,
    [userId, now]
  );
  if (res.rowCount) return buildPilotPromoInfo(res.rows[0]);

  return null;
}

// Re-export the shared utility so callers don't need to know where it lives.
export { getAvailablePromoCredits, PILOT_PROMOS };
