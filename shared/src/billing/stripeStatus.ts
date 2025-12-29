// shared/src/billing/stripeStatus.ts
// Stripe subscription status mapping

import type { SubscriptionStatus } from "../auth/types.js";

/**
 * Stripe subscription status values
 * See: https://stripe.com/docs/api/subscriptions/object#subscription_object-status
 */
export type StripeSubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

/**
 * Map Stripe subscription status to internal subscription status
 *
 * Mapping logic:
 * - active → ACTIVE (fully paid and active)
 * - trialing → TRIAL (in trial period)
 * - past_due, unpaid, incomplete → PAST_DUE (payment issues)
 * - canceled, incomplete_expired → CANCELLED (subscription ended)
 * - paused → PAST_DUE (temporary hold, treat as payment issue)
 */
export function mapStripeStatusToInternal(
  stripeStatus: StripeSubscriptionStatus
): SubscriptionStatus {
  switch (stripeStatus) {
    case "active":
      return "ACTIVE";

    case "trialing":
      return "TRIAL";

    case "past_due":
    case "unpaid":
    case "incomplete":
    case "paused":
      return "PAST_DUE";

    case "canceled":
    case "incomplete_expired":
      return "CANCELLED";

    default:
      // Defensive: treat unknown status as PAST_DUE (fail-safe)
      console.warn(`[STRIPE] Unknown subscription status: ${stripeStatus}, defaulting to PAST_DUE`);
      return "PAST_DUE";
  }
}

/**
 * Check if a Stripe subscription status allows uploads
 */
export function isStripeStatusActive(stripeStatus: StripeSubscriptionStatus): boolean {
  const internal = mapStripeStatusToInternal(stripeStatus);
  return internal === "ACTIVE" || internal === "TRIAL";
}

/**
 * Get user-friendly message for subscription status
 */
export function getStatusMessage(status: SubscriptionStatus): string {
  switch (status) {
    case "ACTIVE":
      return "Your subscription is active";
    case "TRIAL":
      return "You're in your trial period";
    case "PAST_DUE":
      return "Your subscription payment is overdue. Please update your payment method.";
    case "CANCELLED":
      return "Your subscription has been cancelled. Please resubscribe to continue.";
    default:
      return "Unknown subscription status";
  }
}
