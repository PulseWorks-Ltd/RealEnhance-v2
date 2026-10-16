// server/src/services/lifetimeBonus.ts
// Lifetime monthly bonus codes: a code adds extra credits to an agency's
// monthly allowance for as long as it stays subscribed. Each code can only be
// redeemed by one agency; after that it is useless to everyone else.
// Codes are stored as SHA-256 hashes (see migration 022).

import crypto from "node:crypto";
import { pool } from "../db/index.js";

export interface LifetimeBonusRow {
  code_hash: string;
  label: string | null;
  bonus_credits: number;
  is_active: boolean;
  redeemed_by_agency_id: string | null;
  redeemed_by_user_id: string | null;
  redeemed_at: string | null;
}

type Queryable = { query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }> };

export function normalizeLifetimeBonusCode(code: string): string {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashLifetimeBonusCode(code: string): string {
  return crypto.createHash("sha256").update(normalizeLifetimeBonusCode(code)).digest("hex");
}

function bonusError(code: string): Error {
  const err = new Error(code) as Error & { code: string };
  err.code = code;
  return err;
}

/** Returns the code's row if the entered text is a lifetime bonus code, else null. */
export async function findLifetimeBonusCode(code: string, db: Queryable = pool): Promise<LifetimeBonusRow | null> {
  if (!normalizeLifetimeBonusCode(code)) return null;
  try {
    const res = await db.query(`SELECT * FROM lifetime_bonus_codes WHERE code_hash = $1`, [hashLifetimeBonusCode(code)]);
    return (res.rows[0] as LifetimeBonusRow) || null;
  } catch (err) {
    // Table missing (migration not run yet): treat as "not a bonus code" so other promo types still work.
    console.warn("[LIFETIME_BONUS] code lookup failed:", (err as Error)?.message || err);
    return null;
  }
}

/**
 * Claim the code for this agency. The UPDATE only matches an unclaimed code,
 * and Postgres re-checks that condition under the row lock, so two agencies
 * racing for the same code cannot both win. Re-entering the code from the
 * agency that already owns it is a harmless no-op.
 */
export async function redeemLifetimeBonusCode(
  params: { code: string; agencyId: string; userId: string },
  db: Queryable = pool
): Promise<{ row: LifetimeBonusRow; duplicated: boolean }> {
  const codeHash = hashLifetimeBonusCode(params.code);
  const claimed = await db.query(
    `UPDATE lifetime_bonus_codes
        SET redeemed_by_agency_id = $2,
            redeemed_by_user_id   = $3,
            redeemed_at           = NOW(),
            updated_at            = NOW()
      WHERE code_hash = $1
        AND is_active = TRUE
        AND redeemed_by_agency_id IS NULL
      RETURNING *`,
    [codeHash, params.agencyId, params.userId]
  );
  if (claimed.rows[0]) return { row: claimed.rows[0] as LifetimeBonusRow, duplicated: false };

  const existing = await db.query(`SELECT * FROM lifetime_bonus_codes WHERE code_hash = $1`, [codeHash]);
  const row = existing.rows[0] as LifetimeBonusRow | undefined;
  if (!row) throw bonusError("INVALID_PROMO");
  if (!row.is_active) throw bonusError("PROMO_INACTIVE");
  if (row.redeemed_by_agency_id === params.agencyId) return { row, duplicated: true };
  throw bonusError("LIFETIME_BONUS_ALREADY_REDEEMED");
}

/** Total monthly bonus credits this agency has claimed (0 if none). */
export async function getLifetimeMonthlyBonus(agencyId: string, db: Queryable = pool): Promise<number> {
  if (!agencyId) return 0;
  try {
    const res = await db.query(
      `SELECT COALESCE(SUM(bonus_credits), 0)::int AS bonus
         FROM lifetime_bonus_codes
        WHERE redeemed_by_agency_id = $1 AND is_active = TRUE`,
      [agencyId]
    );
    return Math.max(0, Number(res.rows[0]?.bonus || 0));
  } catch (err) {
    // Table may not exist yet if migrations haven't run; never block billing.
    console.warn(`[LIFETIME_BONUS] lookup failed for ${agencyId}:`, (err as Error)?.message || err);
    return 0;
  }
}
