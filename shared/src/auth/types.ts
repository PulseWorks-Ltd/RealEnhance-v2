// shared/src/auth/types.ts
// Agency and authentication type definitions

export type UserRole = "owner" | "admin" | "member";
export type PlanTier = "starter" | "pro" | "agency";

// Subscription status (driven by Stripe webhooks in normal operation)
export type SubscriptionStatus = "ACTIVE" | "PAST_DUE" | "CANCELLED" | "TRIAL";

export interface Agency {
  agencyId: string;
  name: string;
  planTier: PlanTier;

  // Subscription status - automatically updated by Stripe webhooks
  subscriptionStatus: SubscriptionStatus;

  // Stripe billing fields
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripePriceId?: string;

  // Billing region & currency
  billingCountry?: "NZ" | "AU" | "ZA";
  billingCurrency?: "nzd" | "aud" | "zar" | "usd";
  billingEmail?: string;

  // Subscription period tracking (from Stripe)
  currentPeriodStart?: string;
  currentPeriodEnd?: string;

  // Grandfather flag for agencies migrated from direct debit
  billingGrandfatheredUntil?: string; // ISO date

  createdAt: string;
  updatedAt?: string;
}
