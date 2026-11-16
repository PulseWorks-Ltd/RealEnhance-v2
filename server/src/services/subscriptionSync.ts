// server/src/services/subscriptionSync.ts
// Make the app's record of an agency's plan match its Stripe subscription
// (Nov 2026). The plan used to change in the app only when Stripe's
// "subscription updated" webhook arrived; when it didn't (Harcourts Reforma:
// Pro in Stripe, still Starter / 80 credits in the app), the upgrade never
// showed. Used right after an in-app upgrade and by the admin "Sync from
// Stripe" action.

import Stripe from "stripe";
import { getAgency, updateAgency } from "@realenhance/shared/agencies.js";
import { findPlanByPriceId, getStripePlan } from "@realenhance/shared/billing/stripePlans.js";
import { mapStripeStatusToInternal, type StripeSubscriptionStatus } from "@realenhance/shared/billing/stripeStatus.js";
import { pool } from "../db/index.js";
import { subPeriodStart, subPeriodEnd } from "./stripeShapes.js";
import { findUpgradeTimeFromStripe, recordUpgradeProration, type UpgradeProrationResult } from "./upgradeProration.js";

export type SubscriptionSyncResult = {
  agencyId: string;
  subscriptionId: string;
  planBefore: string | null;
  planAfter: string;
  monthlyCredits: number;
  status: string;
  metadataRepaired: boolean;
  proration: UpgradeProrationResult | null;
};

export async function syncAgencyFromStripeSubscription(
  stripe: Stripe,
  agencyId: string,
  subscription?: Stripe.Subscription | null,
  // When the plan changed (Unix seconds). Omitted when the app learns of the
  // change late; it is then read from Stripe's next invoice.
  options: { changeSec?: number } = {},
): Promise<SubscriptionSyncResult> {
  const agency = await getAgency(agencyId);
  if (!agency) throw new Error("Agency not found");
  const sub = subscription
    ?? (agency.stripeSubscriptionId ? await stripe.subscriptions.retrieve(agency.stripeSubscriptionId) : null);
  if (!sub) throw new Error("This agency has no Stripe subscription");

  const priceId = sub.items.data[0]?.price?.id || null;
  const plan = priceId ? findPlanByPriceId(priceId) : null;
  if (!plan) throw new Error(`Stripe price ${priceId || "(none)"} is not a known RealEnhance plan`);

  const planBefore = agency.planTier ?? null;
  agency.stripeSubscriptionId = sub.id;
  if (typeof sub.customer === "string") agency.stripeCustomerId = sub.customer;
  agency.subscriptionStatus = mapStripeStatusToInternal(sub.status as StripeSubscriptionStatus);
  const periodStart = subPeriodStart(sub);
  const periodEnd = subPeriodEnd(sub);
  if (periodStart) agency.currentPeriodStart = new Date(periodStart * 1000).toISOString();
  if (periodEnd) agency.currentPeriodEnd = new Date(periodEnd * 1000).toISOString();
  agency.stripePriceId = priceId!;
  agency.planTier = plan.planTier;
  await updateAgency(agency);

  // An upgrade part-way through the period: the new plan's extra credits only
  // for the share of the period left, as Stripe charges it.
  let proration: UpgradeProrationResult | null = null;
  const pStart = subPeriodStart(sub);
  const pEnd = subPeriodEnd(sub);
  if (planBefore && planBefore !== plan.planTier && pStart && pEnd) {
    const changeSec = options.changeSec
      ?? (await findUpgradeTimeFromStripe(stripe, sub.id, pStart, pEnd))
      ?? Math.floor(Date.now() / 1000);
    proration = await recordUpgradeProration({
      agencyId,
      fromTier: planBefore as any,
      toTier: plan.planTier,
      periodStartSec: pStart,
      periodEndSec: pEnd,
      changeSec,
    });
  }

  // The monthly allowance; this month's limit follows on the next use.
  const monthlyCredits = getStripePlan(plan.planTier).mainAllowance;
  await pool.query(
    `INSERT INTO agency_accounts (agency_id, monthly_included_images, plan_tier, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (agency_id) DO UPDATE
       SET monthly_included_images = EXCLUDED.monthly_included_images,
           plan_tier = EXCLUDED.plan_tier,
           updated_at = NOW();`,
    [agencyId, monthlyCredits, plan.planTier],
  );

  // Stripe's webhooks find the agency through the subscription's metadata; a
  // subscription without it is ignored by them. Repair it so later changes
  // (renewals, cancellations) sync on their own.
  let metadataRepaired = false;
  if (sub.metadata?.agencyId !== agencyId || sub.metadata?.planTier !== plan.planTier) {
    try {
      await stripe.subscriptions.update(sub.id, { metadata: { ...(sub.metadata || {}), agencyId, planTier: plan.planTier } });
      metadataRepaired = sub.metadata?.agencyId !== agencyId;
    } catch (err: any) {
      console.warn(`[BILLING] could not update subscription metadata for agency ${agencyId}:`, err?.message || err);
    }
  }

  console.log(`[BILLING] agency ${agencyId} synced from Stripe subscription ${sub.id}: ${planBefore} -> ${plan.planTier} (${monthlyCredits} credits/month, ${sub.status})${metadataRepaired ? " — agencyId added to subscription metadata" : ""}`);
  return { agencyId, subscriptionId: sub.id, planBefore, planAfter: plan.planTier, monthlyCredits, status: sub.status, metadataRepaired, proration };
}
