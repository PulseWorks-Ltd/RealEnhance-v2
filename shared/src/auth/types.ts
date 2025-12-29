// shared/src/auth/types.ts
// Agency and authentication type definitions

export type UserRole = "owner" | "admin" | "member";
export type PlanTier = "starter" | "pro" | "agency";

// Subscription status for direct debit billing (managed outside Stripe)
export type SubscriptionStatus = "ACTIVE" | "PAST_DUE" | "CANCELLED" | "TRIAL";

export interface Agency {
  agencyId: string;
  name: string;
  planTier: PlanTier;
  // Subscription status - managed manually for direct debit billing
  subscriptionStatus: SubscriptionStatus;
  // Optional: subscription period tracking
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  createdAt: string;
  updatedAt?: string;
}
