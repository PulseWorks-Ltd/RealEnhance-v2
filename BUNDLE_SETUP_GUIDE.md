# RealEnhance Bundle Products - Stripe Setup Guide

## Quick Overview

RealEnhance offers two one-time bundle add-ons for customers who need extra images during busy months:

| Bundle | Images | Price (NZD) | Price (AUD) | Price per Image |
|--------|--------|-------------|-------------|-----------------|
| **50 Bundle** | 50 | $49 | ~$45 | $0.98 NZD |
| **100 Bundle** | 100 | $89 | ~$82 | $0.89 NZD |

**Key Features:**
- ✅ One-time purchase (not recurring)
- ✅ Expires at end of purchase month
- ✅ Consumed AFTER monthly subscription allowance
- ✅ Perfect for unexpectedly busy months
- ✅ Secure payment via Stripe Checkout

---

## Step 1: Create Bundle Products in Stripe

### 1.1 Create 50 Image Bundle Product

1. **Navigate to:** Stripe Dashboard → **Products** → **Add product**
2. **Fill in details:**
   - **Name:** `RealEnhance 50 Image Bundle`
   - **Description:** `50 additional enhanced images. Expires at end of purchase month.`
   - **Pricing model:** **One-time**
3. Click **Add pricing**

### 1.2 Add NZD Price

1. **Price:** `49.00`
2. **Currency:** `New Zealand Dollar (NZD)`
3. **Billing period:** `One-time`
4. Click **Add price**
5. **📋 COPY THE PRICE ID** - It looks like: `price_1SlxABCPay1sYFQ7VXyzDefGh`
   - Save this for Step 3!

### 1.3 Add AUD Price (Optional)

1. Click **Add another price** on the same product
2. **Price:** `45.00`
3. **Currency:** `Australian Dollar (AUD)`
4. **Billing period:** `One-time`
5. Click **Add price**
6. **📋 COPY THE PRICE ID**
   - Save this for Step 3!

---

## Step 2: Create 100 Image Bundle Product

### 2.1 Create Product

1. **Navigate to:** Stripe Dashboard → **Products** → **Add product**
2. **Fill in details:**
   - **Name:** `RealEnhance 100 Image Bundle`
   - **Description:** `100 additional enhanced images. Best value. Expires at end of purchase month.`
   - **Pricing model:** **One-time**
3. Click **Add pricing**

### 2.2 Add NZD Price

1. **Price:** `89.00`
2. **Currency:** `New Zealand Dollar (NZD)`
3. **Billing period:** `One-time`
4. Click **Add price**
5. **📋 COPY THE PRICE ID**
   - Save this for Step 3!

### 2.3 Add AUD Price (Optional)

1. Click **Add another price** on the same product
2. **Price:** `82.00`
3. **Currency:** `Australian Dollar (AUD)`
4. **Billing period:** `One-time`
5. Click **Add price**
6. **📋 COPY THE PRICE ID**
   - Save this for Step 3!

---

## Step 3: Update Code with Stripe Price IDs

### 3.1 Update `shared/src/bundles.ts`

First, update the TypeScript interface to support Stripe Price IDs:

```typescript
export interface ImageBundle {
  code: BundleCode;
  images: number;
  priceNZD: number;
  name: string;
  description: string;
  stripePriceIdByCurrency?: {
    nzd?: string;
    aud?: string;
  };
}
```

### 3.2 Add Your Price IDs

Update the `IMAGE_BUNDLES` configuration with your copied Price IDs:

```typescript
export const IMAGE_BUNDLES: Record<BundleCode, ImageBundle> = {
  BUNDLE_50: {
    code: "BUNDLE_50",
    images: 50,
    priceNZD: 49,
    name: "50 Image Bundle",
    description: "50 enhanced images - perfect for a busy month",
    stripePriceIdByCurrency: {
      nzd: "price_1Slx...YOUR_50_NZD_PRICE_ID",  // ← Replace with Step 1.2 Price ID
      aud: "price_1Slx...YOUR_50_AUD_PRICE_ID",  // ← Replace with Step 1.3 Price ID (if created)
    },
  },
  BUNDLE_100: {
    code: "BUNDLE_100",
    images: 100,
    priceNZD: 89,
    name: "100 Image Bundle",
    description: "100 enhanced images - best value for high-volume agencies",
    stripePriceIdByCurrency: {
      nzd: "price_1Slx...YOUR_100_NZD_PRICE_ID",  // ← Replace with Step 2.2 Price ID
      aud: "price_1Slx...YOUR_100_AUD_PRICE_ID",  // ← Replace with Step 2.3 Price ID (if created)
    },
  }
};
```

### 3.3 Rebuild Shared Package

```bash
cd /workspaces/RealEnhance-v2
pnpm --filter @realenhance/shared run build
```

---

## Step 4: Update Backend Bundle Checkout Route

### 4.1 Verify Bundle Checkout Endpoint

Check that `server/src/routes/agency.ts` has the bundle checkout endpoint:

```typescript
router.post("/bundles/checkout", requireAuth, async (req: Request, res: Response) => {
  try {
    const { bundleCode } = req.body;
    const user = (req as any).user;

    // Get bundle configuration
    const bundle = getBundleByCode(bundleCode);
    if (!bundle) {
      return res.status(400).json({ error: "Invalid bundle code" });
    }

    // Get user's agency
    const agency = await getAgencyById(user.agencyId);
    if (!agency) {
      return res.status(404).json({ error: "Agency not found" });
    }

    // Determine currency based on agency's billing country
    const currency = agency.billingCountry ?
      getCurrencyForCountry(agency.billingCountry) : 'nzd';

    // Get Stripe Price ID for currency
    const priceId = bundle.stripePriceIdByCurrency?.[currency];

    if (!priceId) {
      return res.status(400).json({
        error: `Bundle not available in ${currency.toUpperCase()}`
      });
    }

    // Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment', // One-time payment
      customer: agency.stripeCustomerId,
      line_items: [{
        price: priceId,
        quantity: 1,
      }],
      success_url: `${CLIENT_URL}/agency/settings?bundle_success=true`,
      cancel_url: `${CLIENT_URL}/agency/settings?bundle_cancelled=true`,
      metadata: {
        agencyId: agency.agencyId,
        bundleCode: bundleCode,
        bundleImages: bundle.images.toString(),
      },
    });

    res.json({ checkoutUrl: session.url });
  } catch (error) {
    console.error("Bundle checkout error:", error);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});
```

### 4.2 Add Webhook Handler for Bundle Purchases

Update your webhook handler to process bundle purchases:

```typescript
// In webhook handler
if (event.type === 'checkout.session.completed') {
  const session = event.data.object;

  if (session.mode === 'payment') {
    // This is a one-time bundle purchase
    const { agencyId, bundleCode, bundleImages } = session.metadata;

    // Add bundle images to agency's allowance
    const agency = await getAgencyById(agencyId);
    if (agency) {
      agency.bundleAllowance = (agency.bundleAllowance || 0) + parseInt(bundleImages);
      agency.bundleExpiresAt = getEndOfMonth(); // Expires end of current month
      await updateAgency(agencyId, agency);
    }
  }
}
```

---

## Step 5: Test Bundle Purchase Flow

### 5.1 Start Development Environment

```bash
# Terminal 1: Redis
redis-server

# Terminal 2: Backend
cd /workspaces/RealEnhance-v2/server
export STRIPE_SECRET_KEY=sk_test_YourTestKey
export CLIENT_URL=http://localhost:5173
npm run dev

# Terminal 3: Frontend
cd /workspaces/RealEnhance-v2/client
npm run dev
```

### 5.2 Test Purchase

1. Log in to your RealEnhance account
2. Navigate to **Agency Settings**
3. Scroll to **Additional Images** section
4. Click **Purchase 50 Images** or **Purchase 100 Images**
5. You'll be redirected to Stripe Checkout
6. Use Stripe test card:
   - Card: `4242 4242 4242 4242`
   - Expiry: Any future date (e.g., `12/34`)
   - CVC: Any 3 digits (e.g., `123`)
   - ZIP: Any 5 digits (e.g., `12345`)
7. Complete payment
8. You'll be redirected back to Agency Settings

### 5.3 Verify Purchase

Check that bundle images were added:

```bash
# Check agency record in Redis
redis-cli HGETALL agency:agency_YOUR_AGENCY_ID

# Should show:
# bundleAllowance: 50 (or 100)
# bundleExpiresAt: <end of current month>
```

---

## Step 6: Production Deployment

### 6.1 Create Live Mode Products

1. Switch Stripe Dashboard to **Live mode**
2. Repeat Steps 1-2 to create bundle products in Live mode
3. Copy the **Live** Price IDs
4. Update `shared/src/bundles.ts` with **Live** Price IDs
5. Rebuild: `pnpm --filter @realenhance/shared run build`

### 6.2 Update Environment Variables

Use **Live** Stripe API keys in production:

```bash
STRIPE_SECRET_KEY=sk_live_YourLiveSecretKey
STRIPE_PUBLISHABLE_KEY=pk_live_YourLivePublishableKey
```

---

## Pricing Summary

### Current Bundle Pricing

| Bundle | Images | NZD Price | AUD Price | Per Image (NZD) | Savings vs Pro Plan* |
|--------|--------|-----------|-----------|-----------------|---------------------|
| 50 Bundle | 50 | $49 | ~$45 | $0.98 | 8% cheaper |
| 100 Bundle | 100 | $89 | ~$82 | $0.89 | 16% cheaper |

*Pro plan = $249 NZD for 275 images = $0.91 per image

### How Bundles Work

1. **Purchase:** Customer buys bundle via Stripe Checkout (one-time payment)
2. **Storage:** `bundleAllowance` added to agency record
3. **Expiry:** Set to end of current month (`bundleExpiresAt`)
4. **Usage:** Images consumed AFTER monthly subscription allowance
5. **Reset:** Bundle allowance resets to 0 at month end

### Example Usage

**Agency with Pro Plan (275/month) buys 100 bundle:**
- Month usage: 350 images total
- First 275 images: From Pro subscription
- Next 75 images: From bundle (25 bundle images remain)
- Remaining 25 bundle images: Expire at month end

---

## Troubleshooting

### Issue: "Bundle not available" error

**Cause:** Price ID not set for selected currency

**Fix:**
1. Check `bundles.ts` has Price ID for user's currency
2. Ensure you created prices for both NZD and AUD in Stripe

### Issue: Bundle images not added after payment

**Cause:** Webhook not processing `checkout.session.completed` event

**Fix:**
1. Check Stripe Dashboard → Webhooks → Event logs
2. Verify webhook handler processes `mode: 'payment'` sessions
3. Check server logs for errors
4. Verify `STRIPE_WEBHOOK_SECRET` is correct

### Issue: Bundle images don't expire

**Cause:** Monthly reset job not running or not checking `bundleExpiresAt`

**Fix:**
1. Check cron job or scheduled task is running
2. Verify `bundleExpiresAt` is set correctly
3. Check monthly reset logic in `server/src/jobs/monthlyReset.ts`

---

## Summary Checklist

- [ ] Create 50 Image Bundle product in Stripe (Step 1)
- [ ] Create 100 Image Bundle product in Stripe (Step 2)
- [ ] Add NZD prices for both bundles
- [ ] Add AUD prices for both bundles (optional)
- [ ] Copy all 4 Price IDs (2 bundles × 2 currencies)
- [ ] Update `shared/src/bundles.ts` with Price IDs (Step 3)
- [ ] Rebuild shared package
- [ ] Verify bundle checkout endpoint exists (Step 4)
- [ ] Add webhook handler for bundle purchases
- [ ] Test bundle purchase flow (Step 5)
- [ ] Create Live mode products for production (Step 6)

**Estimated setup time:** 20-30 minutes

---

## Quick Reference: Bundle Configuration

### Stripe Products Created

1. **RealEnhance 50 Image Bundle** (One-time)
   - NZD: $49.00
   - AUD: $45.00

2. **RealEnhance 100 Image Bundle** (One-time)
   - NZD: $89.00
   - AUD: $82.00

### Code Files Modified

- `shared/src/bundles.ts` - Bundle configuration with Price IDs
- `server/src/routes/agency.ts` - Bundle checkout endpoint
- `server/src/routes/webhooks.ts` - Webhook handler for purchases

---

Good luck with your bundle setup! 🎉
