// server/src/routes/stripe.ts
// Stripe webhook handler for bundles and subscriptions

import { Router, type Request, type Response } from "express";
import Stripe from "stripe";
import { createImageBundle } from "@realenhance/shared/usage/imageBundles.js";
import { IMAGE_BUNDLES, type BundleCode } from "@realenhance/shared/bundles.js";
import { getAgency, updateAgency } from "@realenhance/shared/agencies.js";
import { mapStripeStatusToInternal, type StripeSubscriptionStatus } from "@realenhance/shared/billing/stripeStatus.js";
import { findPlanByPriceId, getStripePlan } from "@realenhance/shared/billing/stripePlans.js";
import { pool, withTransaction } from "../db/index.js";
import type { PlanTier } from "@realenhance/shared/auth/types.js";
import { markTrialConverted } from "../services/trials.js";

const router = Router();

// Initialize Stripe with secret key from environment
// Allow override via STRIPE_API_VERSION; fallback to Stripe default when unset
const stripeApiVersion = process.env.STRIPE_API_VERSION as Stripe.StripeConfig["apiVersion"] | undefined;
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: stripeApiVersion })
  : null;

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

async function upsertAgencyAllowance(agencyId: string, planTier: PlanTier) {
  const plan = getStripePlan(planTier);
  const allowance = plan.mainAllowance;
  await pool.query(
    `INSERT INTO agency_accounts (agency_id, monthly_included_images, plan_tier, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (agency_id) DO UPDATE
       SET monthly_included_images = EXCLUDED.monthly_included_images,
           plan_tier = EXCLUDED.plan_tier,
           updated_at = NOW();`,
    [agencyId, allowance, planTier]
  );
}

async function recordSubscriptionInvoiceCredit(params: {
  agencyId: string;
  planTier: PlanTier;
  invoiceId?: string | null;
  subscriptionId?: string | null;
  stripePriceId?: string | null;
}) {
  const plan = getStripePlan(params.planTier);
  const creditAmount = plan.mainAllowance;

  return withTransaction(async (client) => {
    if (params.invoiceId) {
      const existing = await client.query(
        `SELECT 1 FROM addon_purchases WHERE metadata ->> 'invoiceId' = $1 LIMIT 1`,
        [params.invoiceId]
      );
      if (existing.rowCount) {
        return { granted: false as const, reason: "duplicate" };
      }
    }

    await client.query(
      `INSERT INTO agency_accounts (agency_id, monthly_included_images, plan_tier, addon_images_balance)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agency_id) DO UPDATE
         SET monthly_included_images = EXCLUDED.monthly_included_images,
             plan_tier = EXCLUDED.plan_tier,
             addon_images_balance = agency_accounts.addon_images_balance + EXCLUDED.addon_images_balance,
             updated_at = NOW();`,
      [params.agencyId, creditAmount, params.planTier, creditAmount]
    );

    await client.query(
      `INSERT INTO addon_purchases (agency_id, quantity, source, metadata)
         VALUES ($1, $2, $3, $4)`,
      [
        params.agencyId,
        creditAmount,
        "subscription_invoice",
        JSON.stringify({
          invoiceId: params.invoiceId || null,
          subscriptionId: params.subscriptionId || null,
          stripePriceId: params.stripePriceId || null,
          planTier: params.planTier,
          creditAmount,
        }),
      ]
    );

    return { granted: true as const, amount: creditAmount };
  });
}

/**
 * POST /api/stripe/webhook
 * Handle Stripe webhook events
 * CRITICAL: This endpoint must use raw body, not JSON parsing
 */
router.post(
  "/webhook",
  // Express.raw() middleware for webhook signature verification
  // Note: This needs to be configured in the main app to use raw body for this route
  async (req: Request, res: Response) => {
    try {
      if (!stripe) {
        console.error("[STRIPE] Stripe not configured");
        return res.status(503).json({ error: "Stripe not configured" });
      }

      if (!webhookSecret) {
        console.error("[STRIPE] Webhook secret not configured");
        return res.status(500).json({ error: "Webhook secret not configured" });
      }

      // Get the signature from headers
      const signature = req.headers["stripe-signature"];

      if (!signature || typeof signature !== "string") {
        console.error("[STRIPE] No signature in webhook");
        return res.status(400).json({ error: "No signature" });
      }

      let event: Stripe.Event;

      try {
        // Verify webhook signature
        // req.body should be raw buffer for signature verification
        event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
      } catch (err: any) {
        console.error("[STRIPE] Webhook signature verification failed:", err.message);
        return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
      }

      console.log(`[STRIPE] Received event: ${event.type} (${event.id})`);

      // Handle the event
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;

          console.log(`[STRIPE] Checkout session completed: ${session.id}`);
          console.log(`[STRIPE] Mode: ${session.mode}`);
          console.log(`[STRIPE] Metadata:`, session.metadata);

          if (session.mode === "subscription") {
            // Handle subscription checkout
            const { agencyId, planTier, currency, country } = session.metadata || {};

            if (!agencyId || !planTier) {
              console.error("[STRIPE] Missing subscription metadata:", session.metadata);
              return res.status(400).json({ error: "Missing subscription metadata" });
            }

            // Get subscription details from Stripe
            const subscriptionId = session.subscription as string;
            if (!subscriptionId) {
              console.error("[STRIPE] No subscription ID in session");
              return res.status(400).json({ error: "No subscription ID" });
            }

            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const stripePriceId = subscription.items.data[0]?.price.id;
            const mapped = findPlanByPriceId(stripePriceId);
            if (!mapped) {
              console.error(`[STRIPE] Unknown price ID ${stripePriceId} for subscription ${subscriptionId}`);
              return res.status(400).json({ error: "Unknown Stripe price ID" });
            }
            const planTierFromPrice = mapped.planTier;

            // Update agency with subscription details
            const agency = await getAgency(agencyId);
            if (!agency) {
              console.error(`[STRIPE] Agency not found: ${agencyId}`);
              return res.status(404).json({ error: "Agency not found" });
            }

            agency.stripeCustomerId = session.customer as string;
            agency.stripeSubscriptionId = subscriptionId;
            agency.stripePriceId = stripePriceId;
            agency.planTier = planTierFromPrice;
            agency.subscriptionStatus = mapStripeStatusToInternal(subscription.status as StripeSubscriptionStatus);

            // Safely convert Unix timestamps to ISO strings
            const periodStart = (subscription as any).current_period_start;
            const periodEnd = (subscription as any).current_period_end;
            if (periodStart) {
              agency.currentPeriodStart = new Date(periodStart * 1000).toISOString();
            }
            if (periodEnd) {
              agency.currentPeriodEnd = new Date(periodEnd * 1000).toISOString();
            }

            if (currency) agency.billingCurrency = currency as any;
            if (country) agency.billingCountry = country as any;

            await updateAgency(agency);
            await upsertAgencyAllowance(agency.agencyId, agency.planTier);
            await markTrialConverted(agency.agencyId);

            console.log(`[STRIPE] ✅ Subscription activated for agency ${agencyId}: ${planTier} (${subscription.status})`);
          } else {
            // Handle bundle checkout
            const { agencyId, bundleCode, images } = session.metadata || {};

            if (!agencyId || !bundleCode || !images) {
              console.error("[STRIPE] Missing bundle metadata:", session.metadata);
              return res.status(400).json({ error: "Missing bundle metadata" });
            }

            if (!(bundleCode in IMAGE_BUNDLES)) {
              console.error("[STRIPE] Invalid bundle code:", bundleCode);
              return res.status(400).json({ error: "Invalid bundle code" });
            }

            if (!session.payment_intent) {
              console.error("[STRIPE] No payment intent in checkout session");
              return res.status(400).json({ error: "No payment intent" });
            }

            // Create bundle record (idempotent via payment intent ID)
            const result = await createImageBundle({
              agencyId,
              bundleCode: bundleCode as BundleCode,
              imagesPurchased: parseInt(images, 10),
              stripePaymentIntentId: session.payment_intent as string,
              stripeSessionId: session.id,
            });

            if (result.created) {
              console.log(`[STRIPE] ✅ Bundle created: ${result.bundle?.id} - ${images} images`);
            } else if (result.reason === "duplicate") {
              console.log(`[STRIPE] ⚠️  Duplicate payment intent - bundle already exists`);
            } else {
              console.error(`[STRIPE] ❌ Failed to create bundle: ${result.reason}`);
            }
          }

          break;
        }

        case "payment_intent.succeeded": {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          console.log(`[STRIPE] Payment intent succeeded: ${paymentIntent.id}`);
          // Bundle creation happens in checkout.session.completed
          break;
        }

        case "payment_intent.payment_failed": {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          console.log(`[STRIPE] Payment intent failed: ${paymentIntent.id}`);
          console.log(`[STRIPE] Last error:`, paymentIntent.last_payment_error?.message);
          break;
        }

        case "customer.subscription.updated": {
          const subscription = event.data.object as Stripe.Subscription;
          const agencyId = subscription.metadata.agencyId;

          if (!agencyId) {
            console.error("[STRIPE] No agencyId in subscription metadata");
            break;
          }

          const agency = await getAgency(agencyId);
          if (!agency) {
            console.error(`[STRIPE] Agency not found: ${agencyId}`);
            break;
          }

          // Update subscription status
          agency.subscriptionStatus = mapStripeStatusToInternal(subscription.status as StripeSubscriptionStatus);

          // Safely convert Unix timestamps to ISO strings
          const periodStart = (subscription as any).current_period_start;
          const periodEnd = (subscription as any).current_period_end;
          if (periodStart) {
            agency.currentPeriodStart = new Date(periodStart * 1000).toISOString();
          }
          if (periodEnd) {
            agency.currentPeriodEnd = new Date(periodEnd * 1000).toISOString();
          }

          // Update price if changed (plan upgrade/downgrade)
          const newPriceId = subscription.items.data[0]?.price.id;
          if (newPriceId) {
            agency.stripePriceId = newPriceId;
            const mapped = findPlanByPriceId(newPriceId);
            if (mapped) {
              agency.planTier = mapped.planTier;
              await upsertAgencyAllowance(agency.agencyId, mapped.planTier);
            } else {
              console.error(`[STRIPE] Unknown price ID ${newPriceId} on subscription.update for agency ${agencyId}`);
            }
          }

          await updateAgency(agency);

          console.log(`[STRIPE] ✅ Subscription updated for agency ${agencyId}: ${subscription.status}`);
          break;
        }

        case "invoice.payment_succeeded": {
          const invoice = event.data.object as Stripe.Invoice;
          const subscriptionId = (invoice.subscription as string) || null;

          if (!subscriptionId) {
            console.warn(`[STRIPE] invoice.payment_succeeded missing subscription for invoice ${invoice.id}`);
            break;
          }

          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const agencyId = (subscription.metadata as any)?.agencyId || (invoice.metadata as any)?.agencyId;

          if (!agencyId) {
            console.error(`[STRIPE] invoice.payment_succeeded missing agencyId for subscription ${subscriptionId}`);
            break;
          }

          const priceId = invoice.lines.data[0]?.price?.id || subscription.items.data[0]?.price?.id || null;
          const mapped = priceId ? findPlanByPriceId(priceId) : null;
          const planTier = (mapped?.planTier as PlanTier) || ((subscription.metadata as any)?.planTier as PlanTier) || "starter";

          await upsertAgencyAllowance(agencyId, planTier);

          try {
            const result = await recordSubscriptionInvoiceCredit({
              agencyId,
              planTier,
              invoiceId: invoice.id,
              subscriptionId,
              stripePriceId: priceId,
            });

            if (result.granted) {
              console.log(
                `[STRIPE] ✅ Granted ${result.amount} roll-over credits for invoice ${invoice.id} (agency ${agencyId}, plan ${planTier})`
              );
            } else {
              console.log(
                `[STRIPE] ⚠️  Skipped credit grant for invoice ${invoice.id} (agency ${agencyId}) reason=${result.reason}`
              );
            }
          } catch (grantErr) {
            console.error(`[STRIPE] Failed to record subscription credits for invoice ${invoice.id}`, grantErr);
          }

          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object as Stripe.Subscription;
          const agencyId = subscription.metadata.agencyId;

          if (!agencyId) {
            console.error("[STRIPE] No agencyId in subscription metadata");
            break;
          }

          const agency = await getAgency(agencyId);
          if (!agency) {
            console.error(`[STRIPE] Agency not found: ${agencyId}`);
            break;
          }

          // Mark subscription as cancelled
          agency.subscriptionStatus = "CANCELLED";

          await updateAgency(agency);

          console.log(`[STRIPE] ✅ Subscription cancelled for agency ${agencyId}`);
          break;
        }

        case "invoice.payment_succeeded": {
          const invoice = event.data.object as Stripe.Invoice;
          const subscriptionId = (invoice as any).subscription as string;

          if (!subscriptionId) {
            break; // Not a subscription invoice
          }

          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const agencyId = subscription.metadata.agencyId;

          if (!agencyId) {
            console.error("[STRIPE] No agencyId in subscription metadata");
            break;
          }

          const agency = await getAgency(agencyId);
          if (!agency) {
            console.error(`[STRIPE] Agency not found: ${agencyId}`);
            break;
          }

          // Ensure status is ACTIVE after successful payment
          agency.subscriptionStatus = mapStripeStatusToInternal(subscription.status as StripeSubscriptionStatus);

          // Safely convert Unix timestamps to ISO strings
          const periodStart = (subscription as any).current_period_start;
          const periodEnd = (subscription as any).current_period_end;
          if (periodStart) {
            agency.currentPeriodStart = new Date(periodStart * 1000).toISOString();
          }
          if (periodEnd) {
            agency.currentPeriodEnd = new Date(periodEnd * 1000).toISOString();
          }

          const priceId = subscription.items.data[0]?.price.id;
          if (priceId) {
            agency.stripePriceId = priceId;
            const mapped = findPlanByPriceId(priceId);
            if (mapped) {
              agency.planTier = mapped.planTier;
              await upsertAgencyAllowance(agency.agencyId, mapped.planTier);
            } else {
              console.error(`[STRIPE] Unknown price ID ${priceId} on invoice.payment_succeeded for agency ${agencyId}`);
            }
          }

          await updateAgency(agency);

          console.log(`[STRIPE] ✅ Invoice paid for agency ${agencyId}: $${(invoice.amount_paid / 100).toFixed(2)}`);
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object as Stripe.Invoice;
          const subscriptionId = (invoice as any).subscription as string;

          if (!subscriptionId) {
            break; // Not a subscription invoice
          }

          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const agencyId = subscription.metadata.agencyId;

          if (!agencyId) {
            console.error("[STRIPE] No agencyId in subscription metadata");
            break;
          }

          const agency = await getAgency(agencyId);
          if (!agency) {
            console.error(`[STRIPE] Agency not found: ${agencyId}`);
            break;
          }

          // Mark as past due
          agency.subscriptionStatus = mapStripeStatusToInternal(subscription.status as StripeSubscriptionStatus);

          const priceId = subscription.items.data[0]?.price.id;
          if (priceId) {
            agency.stripePriceId = priceId;
            const mapped = findPlanByPriceId(priceId);
            if (mapped) {
              agency.planTier = mapped.planTier;
              await upsertAgencyAllowance(agency.agencyId, mapped.planTier);
            } else {
              console.error(`[STRIPE] Unknown price ID ${priceId} on invoice.payment_failed for agency ${agencyId}`);
            }
          }

          await updateAgency(agency);

          console.log(`[STRIPE] ⚠️  Invoice payment failed for agency ${agencyId}: ${invoice.last_finalization_error?.message}`);
          break;
        }

        default:
          console.log(`[STRIPE] Unhandled event type: ${event.type}`);
      }

      // Return 200 to acknowledge receipt
      res.json({ received: true, eventType: event.type });
    } catch (err) {
      console.error("[STRIPE] Webhook handler error:", err);
      res.status(500).json({ error: "Webhook handler failed" });
    }
  }
);

export default router;
