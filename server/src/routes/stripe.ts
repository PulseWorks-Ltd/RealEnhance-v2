// server/src/routes/stripe.ts
// Stripe webhook handler for bundle purchases

import { Router, type Request, type Response } from "express";
import Stripe from "stripe";
import { createImageBundle } from "@realenhance/shared/usage/imageBundles.js";
import { IMAGE_BUNDLES, type BundleCode } from "@realenhance/shared/bundles.js";

const router = Router();

// Initialize Stripe with secret key from environment
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-12-15.clover" })
  : null;

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

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
          console.log(`[STRIPE] Payment intent: ${session.payment_intent}`);
          console.log(`[STRIPE] Metadata:`, session.metadata);

          // Extract metadata
          const { agencyId, bundleCode, images } = session.metadata || {};

          if (!agencyId || !bundleCode || !images) {
            console.error("[STRIPE] Missing metadata in checkout session:", session.metadata);
            return res.status(400).json({ error: "Missing metadata" });
          }

          if (!(bundleCode in IMAGE_BUNDLES)) {
            console.error("[STRIPE] Invalid bundle code:", bundleCode);
            return res.status(400).json({ error: "Invalid bundle code" });
          }

          // Verify payment intent exists
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
