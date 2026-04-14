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
  findPlanByPriceId,
  PLAN_ORDER,
  formatPrice,
} from "@realenhance/shared/billing/stripePlans.js";
import { mapStripeStatusToInternal, type StripeSubscriptionStatus } from "@realenhance/shared/billing/stripeStatus.js";
import { planTierToPlanCode } from "@realenhance/shared/plans.js";
import { getUsageSnapshot } from "../services/usageLedger.js";
import {
  convertTrialAndDetachUsageIfNeeded,
  getTrialSummary,
  redeemCreditPromoForExistingAgency,
  redeemPromoForExistingAgency,
} from "../services/trials.js";
import { pool } from "../db/index.js";

const router = Router();

// Initialize Stripe (only if API key is provided)
// Allow override via STRIPE_API_VERSION; fallback to Stripe default when unset
const stripeApiVersion = process.env.STRIPE_API_VERSION as Stripe.StripeConfig["apiVersion"] | undefined;
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: stripeApiVersion })
  : null;

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const UNRESTRICTED_CREDIT_PROMO_CODES = new Set<string>([
  "giveme100",
]);

async function upsertAgencyAllowance(agencyId: string, planTier: PlanTier) {
  const plan = getStripePlan(planTier);
  await pool.query(
    `INSERT INTO agency_accounts (agency_id, monthly_included_images, plan_tier, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (agency_id) DO UPDATE
       SET monthly_included_images = EXCLUDED.monthly_included_images,
           plan_tier = EXCLUDED.plan_tier,
           updated_at = NOW();`,
    [agencyId, plan.mainAllowance, planTier]
  );
}

async function markTrialConvertedSafe(agencyId: string, reason: string) {
  try {
    const conversion = await convertTrialAndDetachUsageIfNeeded(agencyId);
    if (conversion.converted) {
      console.log(
        `[BILLING] Trial converted during ${reason} for agency ${agencyId}; detached=${conversion.detachedAmount} trialCreditsUsed=${conversion.trialCreditsUsed}`
      );
    }
  } catch (err) {
    console.warn(`[BILLING] Failed to convert trial during ${reason} for agency ${agencyId}`, err);
  }
}

function subscriptionStatusPriority(status: string | undefined): number {
  switch ((status || "").toLowerCase()) {
    case "active":
      return 5;
    case "trialing":
      return 4;
    case "incomplete":
      return 3;
    case "past_due":
      return 2;
    case "unpaid":
      return 1;
    default:
      return 0;
  }
}

function selectBestSubscription(subscriptions: Stripe.Subscription[]): Stripe.Subscription | null {
  if (!subscriptions.length) return null;

  const eligible = subscriptions.filter((s) => subscriptionStatusPriority(s.status) > 0);
  if (!eligible.length) return null;

  return eligible.sort((a, b) => {
    const rankDiff = subscriptionStatusPriority(b.status) - subscriptionStatusPriority(a.status);
    if (rankDiff !== 0) return rankDiff;

    const aPeriodStart = Number((a as any).current_period_start || 0);
    const bPeriodStart = Number((b as any).current_period_start || 0);
    if (bPeriodStart !== aPeriodStart) return bPeriodStart - aPeriodStart;

    return Number(b.created || 0) - Number(a.created || 0);
  })[0];
}

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

async function loadUserAndAgency(req: Request) {
  const sessUser = (req.session as any)?.user;
  const user = await getUserById(sessUser.id);
  if (!user) throw Object.assign(new Error("User not found"), { status: 401 });
  if (!user.agencyId) throw Object.assign(new Error("No agency"), { status: 400 });
  const agency = await getAgency(user.agencyId);
  if (!agency) throw Object.assign(new Error("Agency not found"), { status: 404 });
  return { user, agency };
}

function requireAgencyAdmin(user: any) {
  const role = user?.role || "member";
  return role === "owner" || role === "admin";
}

function blockIfEmailUnverified(user: any, res: Response) {
  if (user?.emailVerified === true) return false;
  res.status(403).json({
    error: "EMAIL_NOT_VERIFIED",
    message: "Please confirm your email address before purchasing a plan.",
  });
  return true;
}

function isStripeMissingCustomerError(error: any): boolean {
  return (
    error?.type === "StripeInvalidRequestError" &&
    error?.code === "resource_missing" &&
    error?.param === "customer"
  );
}

async function ensureValidStripeCustomerId(params: {
  stripe: Stripe;
  agency: any;
  user: any;
}): Promise<string> {
  const { stripe, agency, user } = params;

  const createCustomer = async (reason: string): Promise<string> => {
    const customer = await stripe.customers.create({
      email: user.email || undefined,
      metadata: {
        agencyId: agency.agencyId,
        userId: user.id,
      },
    });

    agency.stripeCustomerId = customer.id;
    await updateAgency(agency);

    console.log(
      `[BILLING] Created Stripe customer ${customer.id} for agency ${agency.agencyId} (${reason})`
    );

    return customer.id;
  };

  const existingId = typeof agency.stripeCustomerId === "string" ? agency.stripeCustomerId.trim() : "";
  if (!existingId) {
    return createCustomer("missing_local_customer_id");
  }

  try {
    const customer = await stripe.customers.retrieve(existingId);
    if ("deleted" in customer && customer.deleted) {
      return createCustomer("stripe_customer_deleted");
    }
    return existingId;
  } catch (err: any) {
    if (isStripeMissingCustomerError(err)) {
      return createCustomer("stripe_customer_missing");
    }
    throw err;
  }
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
    if (blockIfEmailUnverified(user, res)) return;

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

    // Create or get Stripe customer, and self-heal stale customer IDs.
    let stripeCustomerId = await ensureValidStripeCustomerId({ stripe, agency, user });

    // Get or create Stripe Price ID
    const stripePriceId = getStripePriceId(planTier, billingCurrency);

    // If agency already has a subscription, update that subscription instead of creating a new one.
    if (agency.stripeSubscriptionId) {
      let existingSubscription: Stripe.Subscription | null = null;

      try {
        existingSubscription = await stripe.subscriptions.retrieve(agency.stripeSubscriptionId);
      } catch (subErr: any) {
        // If the stored subscription no longer exists in Stripe, fall back to checkout creation.
        if (subErr?.code !== "resource_missing") {
          throw subErr;
        }
      }

      if (existingSubscription) {
        if (!stripePriceId) {
          return res.status(400).json({
            error: "Missing Stripe price ID",
            message: "Subscription updates require configured Stripe price IDs",
          });
        }

        const existingCustomerId =
          typeof existingSubscription.customer === "string"
            ? existingSubscription.customer
            : existingSubscription.customer?.id;

        if (!stripeCustomerId && existingCustomerId) {
          stripeCustomerId = existingCustomerId;
          agency.stripeCustomerId = existingCustomerId;
          await updateAgency(agency);
        }

        if (!existingCustomerId) {
          return res.status(400).json({
            error: "Missing Stripe customer",
            message: "Existing subscription is not linked to a Stripe customer",
          });
        }

        const stripeCustomer = await stripe.customers.retrieve(existingCustomerId);
        const customerDefaultPaymentMethod =
          "deleted" in stripeCustomer && stripeCustomer.deleted
            ? null
            : stripeCustomer.invoice_settings?.default_payment_method;
        const subscriptionDefaultPaymentMethod = existingSubscription.default_payment_method;

        if (!subscriptionDefaultPaymentMethod && !customerDefaultPaymentMethod) {
          let portalUrl: string | null = null;
          try {
            const portalSession = await stripe.billingPortal.sessions.create({
              customer: existingCustomerId,
              return_url: `${CLIENT_URL}/agency`,
            });
            portalUrl = portalSession.url;
          } catch (portalErr) {
            console.warn(
              `[BILLING] Failed to create portal session for missing payment method (agency ${agency.agencyId})`,
              portalErr
            );
          }

          return res.status(409).json({
            code: "missing_payment_method",
            error: "No default payment method",
            message: "Please add a default payment method in Stripe billing portal before changing plans",
            portalUrl,
          });
        }

        const item = existingSubscription.items.data[0];
        if (!item) {
          return res.status(400).json({ error: "Subscription item not found" });
        }

        const updatedSubscription = await stripe.subscriptions.update(existingSubscription.id, {
          items: [
            {
              id: item.id,
              price: stripePriceId,
            },
          ],
          proration_behavior: "create_prorations",
          metadata: {
            ...existingSubscription.metadata,
            agencyId: agency.agencyId,
            planTier,
            currency: billingCurrency,
            country: billingCountry,
          },
        });

        agency.stripeSubscriptionId = updatedSubscription.id;
        agency.stripePriceId = stripePriceId;
        agency.planTier = planTier;
        agency.subscriptionStatus = "ACTIVE";
        if (stripeCustomerId) agency.stripeCustomerId = stripeCustomerId;

        const updatedPeriodStart = (updatedSubscription as any).current_period_start;
        const updatedPeriodEnd = (updatedSubscription as any).current_period_end;
        if (updatedPeriodStart) {
          agency.currentPeriodStart = new Date(updatedPeriodStart * 1000).toISOString();
        }
        if (updatedPeriodEnd) {
          agency.currentPeriodEnd = new Date(updatedPeriodEnd * 1000).toISOString();
        }

        if (billingCurrency) agency.billingCurrency = billingCurrency;
        if (billingCountry) agency.billingCountry = billingCountry;

        await updateAgency(agency);

        console.log(
          `[BILLING] Updated existing subscription ${updatedSubscription.id} for agency ${agency.agencyId} to ${planTier}`
        );

        return res.json({
          updated: true,
          subscriptionId: updatedSubscription.id,
          planTier,
          url: `${CLIENT_URL}/agency?subscription=updated`,
        });
      }
    }

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

    // Create Checkout Session (retry once if Stripe says customer is missing).
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        client_reference_id: agency.agencyId,
        mode: "subscription",
        line_items: lineItems,
        success_url: `${CLIENT_URL}/agency?subscription=success`,
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
    } catch (checkoutErr: any) {
      if (!isStripeMissingCustomerError(checkoutErr)) {
        throw checkoutErr;
      }

      console.warn(
        `[BILLING] Stripe customer ${stripeCustomerId} missing at checkout for agency ${agency.agencyId}. Recreating and retrying once.`
      );

      stripeCustomerId = await ensureValidStripeCustomerId({
        stripe,
        agency: { ...agency, stripeCustomerId: "" },
        user,
      });

      session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        client_reference_id: agency.agencyId,
        mode: "subscription",
        line_items: lineItems,
        success_url: `${CLIENT_URL}/agency?subscription=success`,
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
    }

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
    if (blockIfEmailUnverified(user, res)) return;

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

/**
 * POST /api/billing/redeem-promo
 * Redeem a promo code for a one-time trial on the current agency
 */
router.post("/redeem-promo", requireAuth, async (req: Request, res: Response) => {
  try {
    const { user, agency } = await loadUserAndAgency(req);

    if (!requireAgencyAdmin(user)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const promoCode = typeof req.body?.promoCode === "string" ? req.body.promoCode.trim() : "";
    if (!promoCode) {
      return res.status(400).json({ error: "Promo code is required" });
    }

    const normalizedPromoCode = promoCode.toLowerCase();

    if (UNRESTRICTED_CREDIT_PROMO_CODES.has(normalizedPromoCode)) {
      const { bundle, promo, duplicated } = await redeemCreditPromoForExistingAgency({
        agencyId: agency.agencyId,
        promoCode,
      });

      const usage = await getUsageSnapshot(agency.agencyId);

      return res.json({
        success: true,
        duplicated,
        code: promo.code,
        promoType: "credit_bundle",
        grant: {
          expiresAt: bundle.expiresAt,
          creditsTotal: bundle.imagesPurchased,
          remaining: Math.max(0, bundle.imagesPurchased - bundle.imagesUsed),
        },
        allowance: {
          monthlyIncluded: usage.includedLimit,
          monthlyRemaining: usage.includedRemaining,
          addonBalance: usage.addonBalance,
          addonRemaining: usage.addonRemaining,
          totalRemaining: usage.remaining,
          monthKey: usage.monthKey,
        },
      });
    }

    if (!user.email) {
      return res.status(400).json({ error: "User email is required" });
    }

    const { trial, promo } = await redeemPromoForExistingAgency({
      agencyId: agency.agencyId,
      email: user.email,
      promoCode,
    });

    if (agency.subscriptionStatus !== "TRIAL") {
      agency.subscriptionStatus = "TRIAL";
      await updateAgency(agency);
    }

    const usage = await getUsageSnapshot(agency.agencyId);

    return res.json({
      success: true,
      code: promo.code,
      promoType: "trial",
      trial: {
        status: trial.trial_status,
        expiresAt: trial.trial_expires_at,
        creditsTotal: trial.trial_credits_total,
        creditsUsed: trial.trial_credits_used,
        remaining: Math.max(0, Number(trial.trial_credits_total || 0) - Number(trial.trial_credits_used || 0)),
      },
      allowance: {
        monthlyIncluded: usage.includedLimit,
        monthlyRemaining: usage.includedRemaining,
        addonBalance: usage.addonBalance,
        addonRemaining: usage.addonRemaining,
        totalRemaining: usage.remaining,
        monthKey: usage.monthKey,
      },
    });
  } catch (error: any) {
    const code = error?.code || "PROMO_REDEEM_FAILED";
    if (
      code === "INVALID_PROMO" ||
      code === "PROMO_INACTIVE" ||
      code === "PROMO_EXPIRED" ||
      code === "PROMO_MAXED" ||
      code === "TRIAL_ALREADY_CLAIMED" ||
      code === "AGENCY_ALREADY_USED_TRIAL" ||
      code === "AGENCY_PREVIOUSLY_SUBSCRIBED"
    ) {
      return res.status(400).json({ error: code });
    }

    console.error("[BILLING] redeem-promo error", error);
    return res.status(500).json({ error: "Failed to redeem promo code" });
  }
});

/**
 * GET /api/billing/subscription
 * Returns the agency subscription details and usage snapshot
 */
router.get("/subscription", requireAuth, async (req: Request, res: Response) => {
  try {
    const { user, agency } = await loadUserAndAgency(req);

    const [usage, trial, listingPackRow] = await Promise.all([
      getUsageSnapshot(agency.agencyId),
      getTrialSummary(agency.agencyId),
      pool.query(
        `SELECT listing_pack_credits FROM agency_accounts WHERE agency_id = $1`,
        [agency.agencyId]
      ),
    ]);
    const listingPackCredits = Math.max(0, Number(listingPackRow.rows[0]?.listing_pack_credits || 0));
    const agencyPlanTier = agency.planTier ?? null;
    const hasActiveStripeSubscription =
      !!agency.stripeSubscriptionId &&
      (agency.subscriptionStatus === "ACTIVE" || agency.subscriptionStatus === "TRIAL");
    const effectiveTier = hasActiveStripeSubscription
      ? ((agencyPlanTier as PlanTier) || "starter")
      : null;
    const plan = effectiveTier ? getStripePlan(effectiveTier) : null;
    const billingCurrency: BillingCurrency = (agency.billingCurrency as BillingCurrency) || "nzd";

    const currentPricePlan = findPlanByPriceId(agency.stripePriceId);
    const pricedTier = currentPricePlan?.planTier || effectiveTier;
    const effectivePlan = currentPricePlan?.plan || plan;
    const now = Date.now();
    const trialActive =
      trial.status === "active" &&
      (!trial.expiresAt || Number.isNaN(Date.parse(trial.expiresAt)) || Date.parse(trial.expiresAt) > now);
    const trialRemaining = trialActive ? Math.max(0, Number(trial.remaining || 0)) : 0;
    const trialIncluded = trialActive ? Math.max(0, Number(trial.creditsTotal || 0)) : 0;
    const trialUsed = trialActive ? Math.max(0, Number(trial.creditsUsed || 0)) : 0;

    const effectiveMonthlyIncluded = trialActive
      ? Math.max(Number(usage.includedLimit || 0), trialIncluded)
      : Number(usage.includedLimit || 0);
    const effectiveMonthlyUsed = trialActive
      ? Math.max(Number(usage.includedUsed || 0), trialUsed)
      : Number(usage.includedUsed || 0);
    const effectiveMonthlyRemaining = Math.max(0, Number(usage.includedRemaining || 0)) + trialRemaining;
    const effectiveTotalRemaining = effectiveMonthlyRemaining + Math.max(0, Number(usage.addonRemaining || 0));
    const fallbackPlanDisplayName = trialActive ? "Starter (Trial)" : "No Plan";

    const currentIndex = pricedTier ? PLAN_ORDER.indexOf(pricedTier) : -1;
    const upgradeOptions = PLAN_ORDER.filter((p) => PLAN_ORDER.indexOf(p) > currentIndex).map((p) => {
      const cfg = getStripePlan(p);
      const priceId = getStripePriceId(p, billingCurrency);
      const priceCents = cfg.monthlyPriceByCurrency[billingCurrency] || cfg.monthlyPriceByCurrency.nzd || 0;
      return {
        planTier: p,
        displayName: cfg.displayName,
        monthlyAllowance: cfg.mainAllowance,
        priceId,
        price: priceCents,
        priceFormatted: priceCents ? formatPrice(priceCents, billingCurrency) : null,
        seatLimit: cfg.seatLimit,
        allowInvites: cfg.allowInvites,
      };
    }).filter((p) => !!p.priceId);

    return res.json({
      agencyId: agency.agencyId,
      planCode: pricedTier ? planTierToPlanCode(pricedTier) : null,
      planTier: pricedTier,
      planDisplayName: effectivePlan?.displayName || fallbackPlanDisplayName,
      stripePriceId: agency.stripePriceId || null,
      stripeSubscriptionId: agency.stripeSubscriptionId || null,
      status: agency.subscriptionStatus || "CANCELLED",
      currentPeriodEnd: agency.currentPeriodEnd || null,
      billingCountry: agency.billingCountry || null,
      billingCurrency,
      seatLimit: effectivePlan?.seatLimit ?? null,
      allowInvites: effectivePlan?.allowInvites ?? false,
      allowance: {
        monthlyIncluded: effectiveMonthlyIncluded,
        monthlyUsed: effectiveMonthlyUsed,
        monthlyRemaining: effectiveMonthlyRemaining,
        addonBalance: usage.addonRemaining,
        totalRemaining: effectiveTotalRemaining,
      },
      usage: {
        monthKey: usage.monthKey,
        includedUsed: usage.includedUsed,
        addonUsed: usage.addonUsed,
      },
      addOns: {
        balance: usage.addonBalance,
        remaining: usage.addonRemaining,
      },
      listingPackCredits,
      upgradeOptions,
      canManage: requireAgencyAdmin(user),
    });
  } catch (error: any) {
    const status = error?.status || 500;
    const message = error?.message || "Failed to load subscription";
    console.error("[BILLING] subscription error", error);
    return res.status(status).json({ error: message });
  }
});

/**
 * POST /api/billing/reconcile-subscription
 * Safety-net sync for checkout return when webhook delivery is delayed/missed.
 */
router.post("/reconcile-subscription", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Stripe not configured" });
    }

    const { user, agency } = await loadUserAndAgency(req);

    if (!requireAgencyAdmin(user)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const requestedAgencyId = typeof req.body?.agencyId === "string" ? req.body.agencyId : undefined;
    if (requestedAgencyId && requestedAgencyId !== agency.agencyId) {
      return res.status(403).json({ error: "Agency mismatch" });
    }

    const customerId = agency.stripeCustomerId;
    if (!customerId) {
      return res.status(400).json({
        reconciled: false,
        reason: "missing_customer",
        message: "No Stripe customer linked to this agency",
      });
    }

    const allSubscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 50,
    });

    const best = selectBestSubscription(allSubscriptions.data);
    if (!best) {
      return res.json({
        reconciled: false,
        reason: "no_active_subscription",
      });
    }

    const latestPriceId = best.items.data[0]?.price?.id || null;
    const mapped = findPlanByPriceId(latestPriceId);
    const planTier: PlanTier = mapped?.planTier || "starter";

    if (!mapped) {
      console.error(
        `[BILLING] Unknown Stripe price ID ${latestPriceId || "null"} during reconciliation for agency ${agency.agencyId}; defaulting to starter`
      );
    }

    agency.stripeCustomerId = customerId;
    agency.stripeSubscriptionId = best.id;
    if (latestPriceId) {
      agency.stripePriceId = latestPriceId;
    }
    agency.planTier = planTier;
    agency.subscriptionStatus = mapStripeStatusToInternal(best.status as StripeSubscriptionStatus);

    const periodStart = (best as any).current_period_start;
    const periodEnd = (best as any).current_period_end;
    if (periodStart) {
      agency.currentPeriodStart = new Date(periodStart * 1000).toISOString();
    }
    if (periodEnd) {
      agency.currentPeriodEnd = new Date(periodEnd * 1000).toISOString();
    }

    await updateAgency(agency);
    await upsertAgencyAllowance(agency.agencyId, planTier);
    await markTrialConvertedSafe(agency.agencyId, "billing.reconcile-subscription");

    const usage = await getUsageSnapshot(agency.agencyId);

    return res.json({
      reconciled: true,
      agencyId: agency.agencyId,
      planTier,
      stripeSubscriptionId: best.id,
      stripePriceId: latestPriceId,
      allowance: {
        monthlyIncluded: usage.includedLimit,
        monthlyUsed: usage.includedUsed,
        monthlyRemaining: usage.includedRemaining,
      },
    });
  } catch (error: any) {
    console.error("[BILLING] reconcile-subscription error", error);
    const status = error?.status || 500;
    return res.status(status).json({ error: error?.message || "Reconciliation failed" });
  }
});

/**
 * GET /api/billing/subscription/preview-change
 * Returns proration preview for switching subscription price
 */
router.get("/subscription/preview-change", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Stripe not configured" });
    }

    const newPriceId = req.query.newPriceId as string;
    if (!newPriceId) {
      return res.status(400).json({ error: "newPriceId is required" });
    }

    const { user, agency } = await loadUserAndAgency(req);

    if (blockIfEmailUnverified(user, res)) return;
    if (!requireAgencyAdmin(user)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    if (!agency.stripeSubscriptionId || !agency.stripeCustomerId) {
      return res.status(400).json({ error: "No active subscription to preview" });
    }

    const subscription = await stripe.subscriptions.retrieve(agency.stripeSubscriptionId);
    const item = subscription.items.data[0];
    if (!item) {
      return res.status(400).json({ error: "Subscription item not found" });
    }

    const upcoming = await (stripe.invoices as any).retrieveUpcoming({
      customer: agency.stripeCustomerId,
      subscription: subscription.id,
      subscription_items: [
        {
          id: item.id,
          price: newPriceId,
        },
      ],
      subscription_proration_behavior: "create_prorations",
    } as any);

    const currency = (upcoming.currency || subscription.currency || "nzd") as BillingCurrency;
    const dueToday = upcoming.amount_due || 0;
    const subscriptionLine = upcoming.lines.data.find((l) => l.type === "subscription");
    const newMonthly = subscriptionLine?.amount || 0;
    const prorationLines = upcoming.lines.data
      .filter((l) => l.proration)
      .map((l) => ({ description: l.description, amount: l.amount }));

    return res.json({
      currency,
      dueToday,
      newMonthly,
      prorationLines,
    });
  } catch (error: any) {
    console.error("[BILLING] preview-change error", error);
    const status = error?.status || 500;
    return res.status(status).json({ error: error?.message || "Preview failed" });
  }
});

/**
 * POST /api/billing/upgrade
 * Upgrades the active subscription to a higher tier with proration
 */
router.post("/upgrade", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Stripe not configured" });
    }

    const { newPriceId } = req.body as { newPriceId?: string };

    if (!newPriceId) {
      return res.status(400).json({ error: "newPriceId is required" });
    }

    const { user, agency } = await loadUserAndAgency(req);

    if (!requireAgencyAdmin(user)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    if (!agency.stripeSubscriptionId || !agency.stripeCustomerId) {
      return res.status(400).json({ error: "No active subscription to upgrade" });
    }

    const targetPlan = findPlanByPriceId(newPriceId);
    if (!targetPlan) {
      return res.status(400).json({ error: "Invalid price for upgrade" });
    }

    const subscription = await stripe.subscriptions.retrieve(agency.stripeSubscriptionId);
    const item = subscription.items.data[0];
    if (!item) {
      return res.status(400).json({ error: "Subscription item not found" });
    }

    const currentPriceId = (item.price as any)?.id || item.price as any;
    const currentPlan = findPlanByPriceId(currentPriceId) || findPlanByPriceId(agency.stripePriceId);
    const currentTier = currentPlan?.planTier || (agency.planTier as PlanTier) || "starter";

    const currentIndex = PLAN_ORDER.indexOf(currentTier);
    const targetIndex = PLAN_ORDER.indexOf(targetPlan.planTier);

    if (targetIndex <= currentIndex) {
      return res.status(400).json({ error: "Upgrade must move to a higher tier" });
    }

    const updated = await stripe.subscriptions.update(subscription.id, {
      items: [
        {
          id: item.id,
          price: newPriceId,
        },
      ],
      proration_behavior: "create_prorations",
      metadata: {
        ...subscription.metadata,
        planTier: targetPlan.planTier,
      },
    });

    return res.json({
      ok: true,
      subscriptionId: updated.id,
      newPriceId,
      planTier: targetPlan.planTier,
      currentPeriodEnd: (updated as any).current_period_end
        ? new Date((updated as any).current_period_end * 1000).toISOString()
        : null,
    });
  } catch (error: any) {
    console.error("[BILLING] upgrade error", error);
    const status = error?.status || 500;
    return res.status(status).json({ error: error?.message || "Upgrade failed" });
  }
});

/**
 * POST /api/billing/subscription/change-plan
 * Updates the Stripe subscription item price
 */
router.post("/subscription/change-plan", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Stripe not configured" });
    }

    const { newPriceId, effective } = req.body as {
      newPriceId?: string;
      effective?: "immediate" | "next_renewal";
    };

    if (!newPriceId) {
      return res.status(400).json({ error: "newPriceId is required" });
    }

    const { user, agency } = await loadUserAndAgency(req);
    if (!requireAgencyAdmin(user)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    if (blockIfEmailUnverified(user, res)) return;

    if (!agency.stripeSubscriptionId || !agency.stripeCustomerId) {
      return res.status(400).json({ error: "No active subscription to change" });
    }

    const subscription = await stripe.subscriptions.retrieve(agency.stripeSubscriptionId);
    const item = subscription.items.data[0];
    if (!item) {
      return res.status(400).json({ error: "Subscription item not found" });
    }

    const prorationBehavior = effective === "next_renewal" ? "none" : "create_prorations";
    const mappedPlan = findPlanByPriceId(newPriceId);

    const updated = await stripe.subscriptions.update(subscription.id, {
      items: [
        {
          id: item.id,
          price: newPriceId,
        },
      ],
      proration_behavior: prorationBehavior,
      metadata: {
        ...subscription.metadata,
        planTier: mappedPlan?.planTier || subscription.metadata.planTier,
      },
    });

    return res.json({
      ok: true,
      subscriptionId: updated.id,
      prorationBehavior,
      newPriceId,
      currentPeriodEnd: (updated as any).current_period_end
        ? new Date((updated as any).current_period_end * 1000).toISOString()
        : null,
    });
  } catch (error: any) {
    console.error("[BILLING] change-plan error", error);
    const status = error?.status || 500;
    return res.status(status).json({ error: error?.message || "Change plan failed" });
  }
});

// ─── Listing Pack ────────────────────────────────────────────────────────────

const LISTING_PACK_CREDITS = 15;
const LISTING_PACK_PRICE_NZD = 4900; // $49 NZD in cents

/**
 * POST /api/billing/listing-pack/checkout
 * Create a Stripe Checkout session for a one-time Listing Pack purchase ($49 NZD)
 */
router.post("/listing-pack/checkout", requireAuth, async (req: Request, res: Response) => {
  try {
    if (!stripe) {
      return res.status(503).json({
        error: "Stripe not configured",
        message: "Stripe billing is not configured. Please contact support.",
      });
    }

    const { user, agency } = await loadUserAndAgency(req);
    if (blockIfEmailUnverified(user, res)) return;

    const stripeCustomerId = await ensureValidStripeCustomerId({ stripe, agency, user });

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      client_reference_id: agency.agencyId,
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "nzd",
            product_data: {
              name: "Listing Pack",
              description: "Enhance up to 15 images — no subscription required",
            },
            unit_amount: LISTING_PACK_PRICE_NZD,
          },
          quantity: 1,
        },
      ],
      success_url: `${CLIENT_URL}/agency?listing_pack=success`,
      cancel_url: `${CLIENT_URL}/agency`,
      metadata: {
        type: "listing_pack",
        agencyId: agency.agencyId,
        credits: String(LISTING_PACK_CREDITS),
        purchasedByUserId: user.id,
      },
    });

    console.log(`[BILLING] Created listing-pack checkout session ${session.id} for agency ${agency.agencyId}`);

    res.json({ url: session.url });
  } catch (error: any) {
    console.error("[BILLING] Listing pack checkout error:", error);
    res.status(500).json({
      error: "Checkout failed",
      message: error.message || "Failed to create listing pack checkout session",
    });
  }
});

export default router;
