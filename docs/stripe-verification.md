# Stripe Live Purchase Verification

Use this checklist to prove live checkout works on https://www.realenhance.co.nz and that entitlements land in storage. Run it after any billing change or domain move.

## Prerequisites
- Live Stripe keys and webhook secret deployed to the server (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PUBLIC_ORIGIN` includes https://www.realenhance.co.nz).
- Known agency ID/email to purchase under (or create one in admin tools).
- Access to production logs (Railway/hosting provider) and Stripe Dashboard.

## End-to-end checkout
1. Open https://www.realenhance.co.nz, start a live checkout for the target plan (production mode, not test). Use a real card you can refund afterward.
2. Complete the payment and wait for the success/return page to load.
3. Note the `agencyId` sent in metadata (visible in the Stripe Checkout session) for later verification.

## Verify webhook delivery and server handling
- Stripe Dashboard → Developers → Webhooks → select the production endpoint. Confirm recent events `checkout.session.completed`, `customer.subscription.updated`, and (if applicable) `invoice.payment_succeeded` show “Delivered” with 2xx responses.
- Stripe Dashboard → Developers → Events: open the most recent `checkout.session.completed` and ensure the request URL matches `/api/stripe/webhook`.
- Server logs: search for `[STRIPE]` entries confirming session completion and subscription updates. Location: your hosting log stream (e.g., Railway/Cloud logs). Key lines:
  - `Checkout session completed` with session ID/metadata
  - `Subscription activated` (shows agencyId, planTier, subscription status)
  - Any signature verification or processing errors should be zero.

## Confirm entitlements persisted
- Redis-backed agency record (primary source):
  - Run a quick script/REPL using `getAgency(<agencyId>)` from `@realenhance/shared/agencies` or inspect via `redis-cli hgetall agency:<agencyId>`.
  - Verify fields: `planTier`, `subscriptionStatus` (ACTIVE/TRIAL/PAST_DUE), `stripeSubscriptionId`, `stripeCustomerId`, `stripePriceId`, `currentPeriodStart`, `currentPeriodEnd`, `billingCurrency`, and `billingCountry`.
- Optional Postgres usage tables (if used for limits/rollups):
  - Check `agency_accounts` and `agency_month_usage` rows for the agency to confirm plan tier/limits were reset or aligned.

## Refund the live test charge
1. Stripe Dashboard → Payments → open the payment linked to the session.
2. Click **Refund** → select **Full** (or desired amount) → submit.
3. If this was a subscription, also cancel the subscription in Stripe (or set to cancel at period end) to avoid future renewals.
4. Verify webhook delivery for `charge.refunded`/`customer.subscription.deleted` and confirm the agency record `subscriptionStatus` updates accordingly in Redis.

## Notes
- Webhook signature verification requires raw bodies; ensure any reverse proxy preserves the raw request.
- If a webhook fails, use “Retry” in Stripe events after fixing the issue; the handler is idempotent for subscriptions.
