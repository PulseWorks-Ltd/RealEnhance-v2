// shared/src/pilotPromos.ts
// Single source of truth for pilot promo definitions.
// Add new pilot promo types here only – never inline in application code.

/** Days until a redeemed pilot promo expires (applies to all pilot promos). */
export const PILOT_PROMO_EXPIRY_DAYS = 30;

/** Default global redemption cap (max successful redemptions before the promo deactivates). */
export const PILOT_PROMO_DEFAULT_GLOBAL_CAP = 10;

export interface PilotPromoDef {
  /** Promo code string (exact, case-sensitive). */
  code: string;
  /** Credits granted on redemption. */
  creditsGranted: number;
  /** Days before redeemed credits expire. */
  expiryDays: number;
  /** Maximum total redemptions across all users/agencies before the promo deactivates. */
  globalCap: number;
}

export const PILOT_PROMOS: Readonly<Record<string, PilotPromoDef>> = {
  PILOT_50: {
    code: "PILOT_50",
    creditsGranted: 50,
    expiryDays: PILOT_PROMO_EXPIRY_DAYS,
    globalCap: PILOT_PROMO_DEFAULT_GLOBAL_CAP,
  },
  PILOT_30: {
    code: "PILOT_30",
    creditsGranted: 30,
    expiryDays: PILOT_PROMO_EXPIRY_DAYS,
    globalCap: PILOT_PROMO_DEFAULT_GLOBAL_CAP,
  },
} as const;

export type PilotPromoCode = keyof typeof PILOT_PROMOS;

/** Visible promo state returned in billing/account payloads. */
export interface PilotPromoInfo {
  promoType: string;
  promoCreditsGranted: number;
  promoCreditsRemaining: number;
  promoRedeemedAt: string;
  promoExpiresAt: string;
}

/**
 * Returns the number of credits still available from a pilot promo redemption row.
 * Returns 0 if the row is null or the promo has expired.
 */
export function getAvailablePromoCredits(
  redemption: {
    credits_granted: number;
    credits_used: number;
    expires_at: string;
  } | null
): number {
  if (!redemption) return 0;
  if (new Date(redemption.expires_at) <= new Date()) return 0;
  return Math.max(0, redemption.credits_granted - redemption.credits_used);
}
