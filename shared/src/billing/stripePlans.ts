// shared/src/billing/stripePlans.ts
// Stripe billing configuration with multi-currency support

import type { PlanTier } from "../auth/types.js";

export type BillingCountry = "NZ" | "AU" | "ZA";
export type BillingCurrency = "nzd" | "aud" | "zar" | "usd";

/**
 * Currency mapping by country
 */
export const COUNTRY_CURRENCY_MAP: Record<BillingCountry, BillingCurrency> = {
  NZ: "nzd",
  AU: "aud",
  ZA: "zar", // Can fallback to USD if needed
};

/**
 * Currency display configuration
 */
export const CURRENCY_CONFIG: Record<BillingCurrency, { symbol: string; name: string }> = {
  nzd: { symbol: "NZ$", name: "New Zealand Dollar" },
  aud: { symbol: "A$", name: "Australian Dollar" },
  zar: { symbol: "R", name: "South African Rand" },
  usd: { symbol: "$", name: "US Dollar" },
};

/**
 * Stripe plan configuration
 * Prices are in cents (e.g., 12900 = $129.00)
 */
export interface StripePlanConfig {
  planCode: PlanTier;
  displayName: string;
  mainAllowance: number;
  stagingAllowance: number;
  seatLimit: number | null;
  allowInvites: boolean;
  monthlyPriceByCurrency: Partial<Record<BillingCurrency, number>>;
  stripePriceIdByCurrency: Partial<Record<BillingCurrency, string>>;
}

export const STRIPE_PRICES = {
  starter: {
    nzd: process.env.STRIPE_PRICE_STARTER,
    aud: process.env.STRIPE_PRICE_STARTER_AUD,
  },
  pro: {
    nzd: process.env.STRIPE_PRICE_PRO,
    aud: process.env.STRIPE_PRICE_PRO_AUD,
  },
  agency: {
    nzd: process.env.STRIPE_PRICE_AGENCY,
    aud: process.env.STRIPE_PRICE_AGENCY_AUD,
  },
} as const;

/**
 * Exchange rate approximations for pricing (NZD base)
 * Used for dynamic price calculation if Stripe Price IDs not set
 * Update these periodically or fetch from API
 */
const EXCHANGE_RATES: Record<BillingCurrency, number> = {
  nzd: 1.0,
  aud: 0.92, // 1 NZD ≈ 0.92 AUD
  zar: 10.5, // 1 NZD ≈ 10.5 ZAR
  usd: 0.59, // 1 NZD ≈ 0.59 USD
};

/**
 * Calculate price in target currency from NZD base price
 */
function calculatePrice(nzdPrice: number, currency: BillingCurrency): number {
  const converted = Math.round(nzdPrice * EXCHANGE_RATES[currency]);
  // Round to nearest 100 cents for cleaner pricing
  return Math.round(converted / 100) * 100;
}

/**
 * Stripe plan definitions
 */
export const STRIPE_PLANS: Record<PlanTier, StripePlanConfig> = {
  starter: {
    planCode: "starter",
    displayName: "Starter",
    mainAllowance: 75,
    stagingAllowance: 0,
    seatLimit: null,
    allowInvites: true,
    monthlyPriceByCurrency: {
      nzd: 14900, // $149 NZD
      aud: 13700, // $137 AUD (calculated: ~13708)
      zar: 156500, // R1565 ZAR (calculated: ~156450)
      usd: 8800, // $88 USD (calculated: ~8791)
    },
    stripePriceIdByCurrency: {
      nzd: STRIPE_PRICES.starter.nzd,
      aud: STRIPE_PRICES.starter.aud,
    },
  },
  pro: {
    planCode: "pro",
    displayName: "Pro",
    mainAllowance: 150,
    stagingAllowance: 0,
    seatLimit: null,
    allowInvites: true,
    monthlyPriceByCurrency: {
      nzd: 24900, // $249 NZD
      aud: 22900, // $229 AUD (calculated: ~22908)
      zar: 261500, // R2615 ZAR (calculated: ~261450)
      usd: 14700, // $147 USD (calculated: ~14691)
    },
    stripePriceIdByCurrency: {
      nzd: STRIPE_PRICES.pro.nzd,
      aud: STRIPE_PRICES.pro.aud,
    },
  },
  agency: {
    planCode: "agency",
    displayName: "Agency",
    mainAllowance: 300,
    stagingAllowance: 0,
    seatLimit: null,
    allowInvites: true,
    monthlyPriceByCurrency: {
      nzd: 44900, // $449 NZD
      aud: 41300, // $413 AUD (calculated: ~41308)
      zar: 471500, // R4715 ZAR (calculated: ~471450)
      usd: 26500, // $265 USD (calculated: ~26491)
    },
    stripePriceIdByCurrency: {
      nzd: STRIPE_PRICES.agency.nzd,
      aud: STRIPE_PRICES.agency.aud,
    },
  },
};

// Centralized lookup for Stripe Price ID -> plan mapping (NZD/AUD only for now)
export const PRICE_ID_TO_PLAN_TIER: Record<string, PlanTier> = (() => {
  const entries: Record<string, PlanTier> = {};
  for (const planTier of Object.keys(STRIPE_PLANS) as PlanTier[]) {
    const priceIds = STRIPE_PLANS[planTier].stripePriceIdByCurrency || {};
    for (const priceId of Object.values(priceIds)) {
      if (priceId) entries[priceId] = planTier;
    }
  }
  return entries;
})();

/**
 * Get plan configuration by tier
 */
export function getStripePlan(planTier: PlanTier): StripePlanConfig {
  return STRIPE_PLANS[planTier];
}

/**
 * Get price in cents for a plan in a specific currency
 */
export function getPlanPrice(planTier: PlanTier, currency: BillingCurrency): number {
  const plan = getStripePlan(planTier);
  return plan.monthlyPriceByCurrency[currency] || plan.monthlyPriceByCurrency.nzd || 0;
}

/**
 * Get Stripe Price ID for a plan in a specific currency
 * Returns undefined if not configured (will use dynamic price_data)
 */
export function getStripePriceId(planTier: PlanTier, currency: BillingCurrency): string | undefined {
  const plan = getStripePlan(planTier);
  return plan.stripePriceIdByCurrency[currency];
}

/**
 * Find plan by Stripe Price ID (any currency) for webhook and upgrade flows.
 */
export function findPlanByPriceId(priceId?: string | null): { planTier: PlanTier; plan: StripePlanConfig } | null {
  if (!priceId) return null;
  const planTier = PRICE_ID_TO_PLAN_TIER[priceId];
  if (!planTier) return null;
  return { planTier, plan: STRIPE_PLANS[planTier] };
}

export const PLAN_ORDER: PlanTier[] = ["starter", "pro", "agency"];

/**
 * Format price for display
 */
export function formatPrice(amountInCents: number, currency: BillingCurrency): string {
  const config = CURRENCY_CONFIG[currency];
  const amount = (amountInCents / 100).toFixed(2);
  return `${config.symbol}${amount} ${currency.toUpperCase()}`;
}

/**
 * Get currency for a country
 */
export function getCurrencyForCountry(country: BillingCountry): BillingCurrency {
  return COUNTRY_CURRENCY_MAP[country];
}

/**
 * Validate country code
 */
export function isValidCountry(country: string): country is BillingCountry {
  return ["NZ", "AU", "ZA"].includes(country);
}

/**
 * Validate currency code
 */
export function isValidCurrency(currency: string): currency is BillingCurrency {
  return ["nzd", "aud", "zar", "usd"].includes(currency.toLowerCase());
}
