// server/src/routes/billing.ts
// Stripe subscription checkout and billing portal

import { Router, type Request, type Response } from "express";
import Stripe from "stripe";
import { getAgency, updateAgency } from "@realenhance/shared/agencies.js";
import { getUserById } from "../services/users.js";
import type { PlanTier } from "@realenhance/shared/auth/types.js";
import {
  getStripePlan,
  getStripePriceId,
  getCurrencyForCountry,
  isValidCountry,
  type BillingCountry,
  type BillingCurrency,
} from "@realenhance/shared/billing/stripePlans.js";

const router = Router();

// Initialize Stripe (only if API key is provided)
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2025-12-15.clover",
    })
  : null;

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

/**
 * Middleware to require authentication
 */
function requireAuth(req: Request, res: Response, next: Function) {
  const sessUser = (req.session as any)?.user;
  if (!sessUser) {
    return res.status(401).json({ error: "not_authenticated" });
  }
  next();
}

/**
 * POST /api/billing/checkout-subscription
 * Create a Stripe Checkout session for subscription
 */
router.post("/checkout-subscription", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!stripe) {
      return res.status(503).json({
        error: "Stripe not configured",
        message: "Stripe billing is not configured. Please contact support.",
      });
    }

    const sessUser = (req.session as any)?.user;
    const { planTier, country, currency } = req.body as {
      planTier: PlanTier;
      country?: BillingCountry;
      currency?: BillingCurrency;
    };

    // Validate plan tier
    if (!planTier || !["starter", "pro", "agency"].includes(planTier)) {
      return res.status(400).json({
        error: "Invalid plan tier",
        message: "Plan tier must be one of: starter, pro, agency",
      });
    }

    // Get user and agency
    const user = await getUserById(sessUser.id);
    if (!user || !user.agencyId) {
      return res.status(400).json({
        error: "No agency",
        message: "User must be part of an agency to subscribe",
      });
    }

    const agency = await getAgency(user.agencyId);
    if (!agency) {
      return res.status(404).json({ error: "Agency not found" });
    }

    // Determine billing country and currency
    const billingCountry: BillingCountry =
      country && isValidCountry(country) ? country : agency.billingCountry || "NZ";
    const billingCurrency: BillingCurrency =
      currency || agency.billingCurrency || getCurrencyForCountry(billingCountry);

    // Get plan configuration
    const plan = getStripePlan(planTier);
    const priceInCents = plan.monthlyPriceByCurrency[billingCurrency];

    if (!priceInCents) {
      return res.status(400).json({
        error: "Currency not supported",
        message: `Plan ${planTier} does not support currency ${billingCurrency}`,
      });
    }

    // Create or get Stripe customer
    let stripeCustomerId = agency.stripeCustomerId;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email || undefined,
        metadata: {
          agencyId: agency.agencyId,
          userId: user.id,
        },
      });

      stripeCustomerId = customer.id;

      // Save customer ID to agency
      agency.stripeCustomerId = stripeCustomerId;
      await updateAgency(agency);

      console.log(`[BILLING] Created Stripe customer ${stripeCustomerId} for agency ${agency.agencyId}`);
    }

    // Get or create Stripe Price ID
    const stripePriceId = getStripePriceId(planTier, billingCurrency);

    let lineItems: Stripe.Checkout.SessionCreateParams.LineItem[];

    if (stripePriceId) {
      // Use pre-created Price ID (production)
      lineItems = [{ price: stripePriceId, quantity: 1 }];
    } else {
      // Dynamic price_data (development)
      lineItems = [
        {
          price_data: {
            currency: billingCurrency,
            product_data: {
              name: `${plan.displayName} Plan`,
              description: `${plan.mainAllowance} enhanced images + ${plan.stagingAllowance} staging images per month`,
            },
            unit_amount: priceInCents,
            recurring: { interval: "month" },
          },
          quantity: 1,
        },
      ];
    }

    // Create Checkout Session
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      client_reference_id: agency.agencyId,
      mode: "subscription",
      line_items: lineItems,
      success_url: `${CLIENT_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CLIENT_URL}/agency`,
      metadata: {
        agencyId: agency.agencyId,
        planTier,
        currency: billingCurrency,
        country: billingCountry,
      },
      subscription_data: {
        metadata: {
          agencyId: agency.agencyId,
          planTier,
        },
      },
    });

    console.log(`[BILLING] Created checkout session ${session.id} for agency ${agency.agencyId}`);

    res.json({ url: session.url });
  } catch (error: any) {
    console.error("[BILLING] Checkout error:", error);
    res.status(500).json({
      error: "Checkout failed",
      message: error.message || "Failed to create checkout session",
    });
  }
});

/**
 * POST /api/billing/portal
 * Create a Stripe Customer Portal session
 */
router.post("/portal", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!stripe) {
      return res.status(503).json({
        error: "Stripe not configured",
        message: "Stripe billing is not configured. Please contact support.",
      });
    }

    const sessUser = (req.session as any)?.user;

    // Get user and agency
    const user = await getUserById(sessUser.id);
    if (!user || !user.agencyId) {
      return res.status(400).json({
        error: "No agency",
        message: "User must be part of an agency",
      });
    }

    const agency = await getAgency(user.agencyId);
    if (!agency) {
      return res.status(404).json({ error: "Agency not found" });
    }

    if (!agency.stripeCustomerId) {
      return res.status(400).json({
        error: "No Stripe customer",
        message: "Please subscribe first before accessing the billing portal",
      });
    }

    // Create portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: agency.stripeCustomerId,
      return_url: `${CLIENT_URL}/agency`,
    });

    console.log(`[BILLING] Created portal session for agency ${agency.agencyId}`);

    res.json({ url: session.url });
  } catch (error: any) {
    console.error("[BILLING] Portal error:", error);
    res.status(500).json({
      error: "Portal failed",
      message: error.message || "Failed to create portal session",
    });
  }
});

export default router;
