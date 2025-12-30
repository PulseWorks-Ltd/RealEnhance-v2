# RealEnhance Stripe Setup Guide

## Overview
This guide walks you through setting up Stripe for RealEnhance billing from scratch. Since you have no existing clients or agencies, we'll start fresh with a clean Stripe account.

---

## Step 1: Create Stripe Account

### 1.1 Sign Up for Stripe
1. Go to https://dashboard.stripe.com/register
2. Create account with your business email (pulseworkslimited@gmail.com)
3. Choose **New Zealand** as your country
4. Complete business details:
   - Business name: "RealEnhance" or "PulseWorks Limited"
   - Business type: SaaS/Software
   - Industry: Technology/Software

### 1.2 Activate Your Account
1. Complete identity verification (required for live mode)
2. Add bank account for payouts (NZ bank account)
3. Set up 2-factor authentication (highly recommended)

**Time estimate:** 10-15 minutes (plus verification time)

---

## Step 2: Configure Stripe Products

Stripe uses a Product → Price hierarchy. Each plan is a Product with associated Prices in different currencies.

### 2.1 Create Products

Navigate to: **Products** → **Add product**

#### Product 1: Starter Plan
- **Name:** RealEnhance Starter
- **Description:** 100 enhanced images per month. Perfect for individual agents.
- **Pricing model:** Recurring
- Click **Add pricing**

#### Product 2: Pro Plan
- **Name:** RealEnhance Pro
- **Description:** 275 enhanced images per month. Ideal for active agents and small teams.
- **Pricing model:** Recurring
- Click **Add pricing**

#### Product 3: Studio Plan (Agency)
- **Name:** RealEnhance Studio
- **Description:** 600 enhanced images per month. Unlimited users. Built for agencies.
- **Pricing model:** Recurring
- Click **Add pricing**

**💡 Tip:** Add detailed descriptions - they appear on invoices and customer portal.

---

## Step 3: Create Prices for Each Product

For each product above, you'll create prices in different currencies. Start with NZD, then add AUD when ready for AU expansion.

### 3.1 Starter Plan Prices

**NZD Price:**
1. Go to **Starter Product** → **Add another price**
2. Configure:
   - **Price:** 129.00
   - **Currency:** NZD (New Zealand Dollar)
   - **Billing period:** Monthly
   - **Usage is metered:** No
3. Click **Add price**
4. **Copy the Price ID** (looks like `price_1ABC...xyz`)
   - This goes in your code as `stripePriceIdByCurrency.nzd`

**AUD Price (optional, for AU expansion):**
1. Add another price: 119.00 AUD
2. Billing period: Monthly
3. **Copy the Price ID** → `stripePriceIdByCurrency.aud`

### 3.2 Pro Plan Prices

**NZD Price:**
- Price: **249.00 NZD**
- Billing: Monthly
- Copy Price ID

**AUD Price:**
- Price: **229.00 AUD**
- Billing: Monthly
- Copy Price ID

### 3.3 Studio Plan Prices

**NZD Price:**
- Price: **499.00 NZD** ⚠️ (New pricing!)
- Billing: Monthly
- Copy Price ID

**AUD Price:**
- Price: **449.00 AUD** ⚠️ (New pricing!)
- Billing: Monthly
- Copy Price ID

---

## Step 4: Get Your API Keys

### 4.1 Development Keys (Test Mode)

1. Go to: **Developers** → **API keys**
2. Make sure you're in **Test mode** (toggle in sidebar)
3. Copy both keys:
   - **Publishable key:** `pk_test_...` (for frontend)
   - **Secret key:** `sk_test_...` (for backend)

### 4.2 Production Keys (Live Mode)

1. Switch to **Live mode** (toggle in sidebar)
2. ⚠️ **Only use these in production!**
3. Copy both keys:
   - **Publishable key:** `pk_live_...`
   - **Secret key:** `sk_live_...`

---

## Step 5: Configure Webhook Endpoint

Webhooks notify your server when subscriptions change (payments succeed/fail, cancellations, etc.)

### 5.1 Create Webhook Endpoint

1. Go to: **Developers** → **Webhooks**
2. Click **Add endpoint**
3. **Endpoint URL:**
   - Development: `https://your-dev-url.com/api/stripe/webhook`
   - Production: `https://realenhance.com/api/stripe/webhook`

4. **Events to listen for:** Click **Select events**, then add:
   ```
   ✓ checkout.session.completed
   ✓ customer.subscription.created
   ✓ customer.subscription.updated
   ✓ customer.subscription.deleted
   ✓ invoice.payment_succeeded
   ✓ invoice.payment_failed
   ```

5. Click **Add endpoint**
6. **Copy the Signing secret** (looks like `whsec_...`)
   - This goes in `STRIPE_WEBHOOK_SECRET` environment variable

### 5.2 Test Webhook (Optional but Recommended)

1. Install Stripe CLI: https://stripe.com/docs/stripe-cli
2. Run:
   ```bash
   stripe listen --forward-to localhost:5000/api/stripe/webhook
   ```
3. This gives you a temporary webhook secret for local testing

---

## Step 6: Update Your Code with Stripe Price IDs

### 6.1 Edit `shared/src/billing/stripePlans.ts`

Replace the empty `stripePriceIdByCurrency` objects with your actual Price IDs:

```typescript
export const STRIPE_PLANS: Record<PlanTier, StripePlanConfig> = {
  starter: {
    planCode: "starter",
    displayName: "Starter",
    mainAllowance: 100,
    stagingAllowance: 0,
    monthlyPriceByCurrency: {
      nzd: 12900,
      aud: 11900,
    },
    stripePriceIdByCurrency: {
      nzd: "price_ABC123YourStarterNZD",  // ← Your NZD Price ID
      aud: "price_DEF456YourStarterAUD",  // ← Your AUD Price ID (if created)
    },
  },
  pro: {
    planCode: "pro",
    displayName: "Pro",
    mainAllowance: 275,
    stagingAllowance: 0,
    monthlyPriceByCurrency: {
      nzd: 24900,
      aud: 22900,
    },
    stripePriceIdByCurrency: {
      nzd: "price_GHI789YourProNZD",      // ← Your NZD Price ID
      aud: "price_JKL012YourProAUD",      // ← Your AUD Price ID (if created)
    },
  },
  agency: {
    planCode: "agency",
    displayName: "Studio",
    mainAllowance: 600,
    stagingAllowance: 0,
    monthlyPriceByCurrency: {
      nzd: 49900,
      aud: 44900,
    },
    stripePriceIdByCurrency: {
      nzd: "price_MNO345YourStudioNZD",   // ← Your NZD Price ID
      aud: "price_PQR678YourStudioAUD",   // ← Your AUD Price ID (if created)
    },
  },
};
```

### 6.2 Rebuild Shared Package

```bash
cd /workspaces/RealEnhance-v2
pnpm --filter @realenhance/shared run build
```

---

## Step 7: Set Environment Variables

### 7.1 Development Environment

Create/update `.env` file in `server/` directory:

```bash
# Stripe API Keys (Test Mode)
STRIPE_SECRET_KEY=sk_test_YourTestSecretKey
STRIPE_PUBLISHABLE_KEY=pk_test_YourTestPublishableKey
STRIPE_WEBHOOK_SECRET=whsec_YourWebhookSigningSecret

# Client URL (for redirect after checkout)
CLIENT_URL=http://localhost:5173

# Redis (already configured)
REDIS_URL=redis://localhost:6379

# Session Secret (generate a random string)
SESSION_SECRET=your-super-secret-random-string-here
```

### 7.2 Production Environment

⚠️ **Use LIVE mode keys in production:**

```bash
# Stripe API Keys (Live Mode)
STRIPE_SECRET_KEY=sk_live_YourLiveSecretKey
STRIPE_PUBLISHABLE_KEY=pk_live_YourLivePublishableKey
STRIPE_WEBHOOK_SECRET=whsec_YourLiveWebhookSecret

# Production Client URL
CLIENT_URL=https://app.realenhance.com

# Redis URL (production)
REDIS_URL=redis://your-production-redis-url:6379

# Session Secret (use a strong, unique secret)
SESSION_SECRET=production-secret-use-pwgen-64-1
```

### 7.3 Generate Secure Session Secret

```bash
# On Linux/Mac:
openssl rand -hex 32

# Or use an online generator:
# https://www.browserling.com/tools/random-string
```

---

## Step 8: Configure Stripe Customer Portal

The Customer Portal allows users to manage their own subscriptions.

### 8.1 Enable Customer Portal

1. Go to: **Settings** → **Billing** → **Customer portal**
2. Click **Activate test link** (or **Activate** in live mode)
3. Configure settings:

**Business information:**
- Business name: RealEnhance
- Support email: support@realenhance.com (or your email)
- Privacy policy: (add if you have one)
- Terms of service: (add if you have one)

**Features:**
- ✓ Allow customers to update payment methods
- ✓ Allow customers to update billing information
- ✓ Allow customers to cancel subscriptions
- ✓ Show invoice history

**Subscription cancellation:**
- Choose: "Cancel immediately" or "Cancel at period end" (your preference)
- Add optional cancellation survey

4. Click **Save changes**

---

## Step 9: Test the Integration (Development)

### 9.1 Start Your Dev Server

```bash
# Terminal 1: Start Redis
redis-server

# Terminal 2: Start backend (with env vars)
cd /workspaces/RealEnhance-v2/server
export REDIS_URL=redis://localhost:6379
export STRIPE_SECRET_KEY=sk_test_YourKey
export CLIENT_URL=http://localhost:5173
npm run dev

# Terminal 3: Start frontend
cd /workspaces/RealEnhance-v2/client
npm run dev
```

### 9.2 Test Subscription Flow

1. **Sign up** for a new account
2. Navigate to **Agency Settings**
3. Click **Subscribe Now**
4. Select a plan (Studio)
5. Choose country (NZ)
6. You'll be redirected to Stripe Checkout

### 9.3 Use Stripe Test Cards

**Successful payment:**
```
Card number: 4242 4242 4242 4242
Expiry: Any future date (e.g., 12/34)
CVC: Any 3 digits (e.g., 123)
ZIP: Any 5 digits (e.g., 12345)
```

**Payment declined:**
```
Card number: 4000 0000 0000 0002
```

**3D Secure authentication:**
```
Card number: 4000 0027 6000 3184
```

Full list: https://stripe.com/docs/testing#cards

### 9.4 Verify Webhook Reception

1. Go to Stripe Dashboard: **Developers** → **Webhooks**
2. Click on your webhook endpoint
3. Check **Event logs** - you should see events being received
4. Events to look for:
   - `checkout.session.completed` (when user completes checkout)
   - `customer.subscription.created` (subscription activated)
   - `invoice.payment_succeeded` (first payment succeeded)

### 9.5 Check Your Database

After successful test subscription:

```bash
# Check agency was updated
redis-cli HGETALL agency:agency_YOUR_AGENCY_ID

# Should show:
# stripeCustomerId: cus_...
# stripeSubscriptionId: sub_...
# stripePriceId: price_...
# subscriptionStatus: ACTIVE
```

---

## Step 10: Deploy to Production

### 10.1 Pre-Deployment Checklist

- [ ] Switch Stripe Dashboard to **Live mode**
- [ ] Create live Products and Prices (same as test mode)
- [ ] Update webhook endpoint URL to production
- [ ] Copy **live** API keys and webhook secret
- [ ] Update production environment variables
- [ ] Test Customer Portal in live mode
- [ ] Enable Stripe Radar for fraud prevention (recommended)

### 10.2 Deploy Code

```bash
# Build all packages
pnpm run build

# Deploy to your hosting (example)
# Vercel / Railway / Render / AWS / etc.
```

### 10.3 Update Stripe Webhook URL

1. Go to: **Developers** → **Webhooks** (Live mode)
2. Add endpoint: `https://app.realenhance.com/api/stripe/webhook`
3. Select same events as before
4. Copy new webhook secret
5. Update `STRIPE_WEBHOOK_SECRET` in production env

### 10.4 Post-Deployment Verification

1. Create a test subscription in production
2. Use a **real card** or Stripe test mode (if still testing)
3. Verify:
   - Subscription created in Stripe Dashboard
   - Agency record updated in Redis
   - User can access features
   - Webhooks are being received
   - Customer Portal works

---

## Step 11: Ongoing Management

### 11.1 Monitor Subscriptions

**Stripe Dashboard:**
- **Customers:** View all subscribers
- **Subscriptions:** Active/cancelled subscriptions
- **Payments:** Successful/failed payments
- **Analytics:** Revenue, churn, MRR

### 11.2 Handle Failed Payments

Stripe automatically retries failed payments. Configure retry settings:

1. Go to: **Settings** → **Billing** → **Subscriptions and emails**
2. Configure:
   - Smart retries (recommended)
   - Email notifications to customers
   - Dunning management

### 11.3 Tax Configuration (Optional)

If you need to charge GST/VAT:

1. Go to: **Settings** → **Tax settings**
2. Enable Stripe Tax (automatic tax calculation)
3. Or manually configure tax rates per country

---

## Quick Reference: Environment Variables

### Development (.env)
```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
CLIENT_URL=http://localhost:5173
REDIS_URL=redis://localhost:6379
SESSION_SECRET=dev-secret-change-in-prod
```

### Production
```bash
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
CLIENT_URL=https://app.realenhance.com
REDIS_URL=redis://production-url:6379
SESSION_SECRET=production-secret-use-strong-random
```

---

## Troubleshooting

### Issue: "Stripe not configured" error

**Cause:** `STRIPE_SECRET_KEY` not set or invalid

**Fix:**
```bash
# Check environment variable
echo $STRIPE_SECRET_KEY

# Should output: sk_test_... or sk_live_...
# If empty, add to .env and restart server
```

### Issue: Webhooks not received

**Cause:** Webhook endpoint not accessible or signing secret wrong

**Fix:**
1. Check webhook URL is publicly accessible
2. Verify `STRIPE_WEBHOOK_SECRET` matches Stripe Dashboard
3. Check Stripe Dashboard → Webhooks → Event logs for errors
4. For local testing, use Stripe CLI:
   ```bash
   stripe listen --forward-to localhost:5000/api/stripe/webhook
   ```

### Issue: "Invalid price ID" error

**Cause:** Price ID in code doesn't match Stripe

**Fix:**
1. Go to Stripe Dashboard → Products
2. Copy correct Price IDs
3. Update `stripePlans.ts`
4. Rebuild: `pnpm --filter @realenhance/shared run build`

### Issue: Subscription created but agency not updated

**Cause:** Webhook not processed or Redis not available

**Fix:**
1. Check webhook logs in Stripe Dashboard
2. Check server logs for errors
3. Verify Redis is running: `redis-cli ping`
4. Manually update agency if needed (see Step 9.5)

---

## Support Resources

- **Stripe Documentation:** https://stripe.com/docs
- **Test Cards:** https://stripe.com/docs/testing
- **Webhook Testing:** https://stripe.com/docs/webhooks/test
- **Stripe Support:** https://support.stripe.com/

---

## Summary Checklist

- [ ] Create Stripe account (Step 1)
- [ ] Create 3 products: Starter, Pro, Studio (Step 2)
- [ ] Create prices for each product (NZD + AUD) (Step 3)
- [ ] Copy API keys (test + live) (Step 4)
- [ ] Set up webhook endpoint (Step 5)
- [ ] Update code with Price IDs (Step 6)
- [ ] Set environment variables (Step 7)
- [ ] Configure Customer Portal (Step 8)
- [ ] Test with test cards (Step 9)
- [ ] Deploy to production (Step 10)
- [ ] Monitor and maintain (Step 11)

**Estimated setup time:** 1-2 hours (first time)

---

## Current Plan Configuration

As of this setup, RealEnhance offers three plans:

| Plan | Price (NZD) | Price (AUD) | Images/Month | Users | Retention |
|------|-------------|-------------|--------------|-------|-----------|
| **Starter** | $129 | $119 | 100 | Unlimited | 300 |
| **Pro** | $249 | $229 | 275 | Unlimited | 800 |
| **Studio** | $499 | $449 | 600 | Unlimited | 2000 |

All plans include:
- Unlimited users per agency
- Unlimited retries and edits
- No seat limits
- Rolling image retention

---

Good luck with your launch! 🚀
