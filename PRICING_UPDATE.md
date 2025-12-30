# RealEnhance Pricing Update - Agency Plan

## Summary
Updated Agency (Studio) plan pricing and allowances effective immediately for new subscriptions.

## Changes

### Agency Plan Updates

**Pricing:**
- NZ: $499/month (previously $399) - **+$100 increase**
- AU: $449/month (previously $367) - **+$82 increase**
- ZA: R5240/month (previously R4190) - **+R1050 increase**
- US: $294/month (previously $235) - **+$59 increase**

**Allowances:**
- Image uploads: **600/month** (previously 500) - **+100 images**
- Virtual staging: **Removed** (previously 75/month)
- Retention: 2000 images (unchanged)
- Users/seats: **Unlimited** (unchanged)

**Rationale:**
- Simplified offering: Single 600 image allowance, no separate staging quota
- Unlimited retries and edits included (no credit system)
- Better value proposition for agencies with higher volume needs

### Updated Plans

**Starter Plan:**
- Price: $129 NZD / $119 AUD (unchanged)
- Allowances: 100 images/month (unchanged)
- Retention: 300 images (unchanged)

**Pro Plan:**
- Price: $249 NZD / $229 AUD (unchanged)
- Allowances: **275 images/month** (simplified from 250 + 25 staging)
- Retention: 800 images (unchanged)
- **Change:** Removed separate staging allowance, consolidated into main allowance

## Grandfathering

**Existing Subscriptions:**
- All existing Agency plan subscriptions remain at their original pricing
- Price is locked to the Stripe Price ID at time of subscription
- No action required for existing customers

**How it Works:**
1. Each subscription stores its `stripePriceId` on the agency record
2. Price changes only affect new subscriptions created after deployment
3. Existing subscriptions continue billing at original price until cancelled/changed
4. Manual plan changes (upgrade/downgrade) will use new pricing

## Technical Implementation

### Files Updated

1. **`shared/src/plans.ts`**
   - Updated `PLAN_LIMITS.pro.mainAllowance`: 250 → 275
   - Updated `PLAN_LIMITS.pro.stagingAllowance`: 25 → 0
   - Updated `PLAN_LIMITS.agency.mainAllowance`: 500 → 600
   - Updated `PLAN_LIMITS.agency.stagingAllowance`: 75 → 0
   - Updated `PLAN_LIMITS.agency.price`: 399 → 499 (NZD base)

2. **`shared/src/billing/stripePlans.ts`**
   - Updated `STRIPE_PLANS.pro.mainAllowance`: 250 → 275
   - Updated `STRIPE_PLANS.pro.stagingAllowance`: 25 → 0
   - Updated `STRIPE_PLANS.agency.mainAllowance`: 500 → 600
   - Updated `STRIPE_PLANS.agency.stagingAllowance`: 75 → 0
   - Updated `STRIPE_PLANS.agency.monthlyPriceByCurrency`:
     - NZD: 39900 → 49900 cents
     - AUD: 36700 → 44900 cents
     - ZAR: 419000 → 524000 cents
     - USD: 23500 → 29400 cents

### Grandfathering Mechanism

**Stripe Integration:**
- Subscriptions store `stripePriceId` field on agency record
- Price ID is set when subscription is created (stripe.ts:100)
- Price ID is updated only when subscription plan changes (stripe.ts:186-188)
- Billing uses stored Price ID, not current plan configuration

**Usage Enforcement:**
- Usage limits read from `PLAN_LIMITS[agency.planTier]`
- All Agency tier subscriptions (old and new) get 600 image allowance
- Legacy customers get increased allowance at original price (bonus!)

### Production Deployment Steps

1. **Create new Stripe Price objects** for Agency plan:
   ```bash
   # NZD - $499/month
   stripe prices create \
     --currency nzd \
     --unit-amount 49900 \
     --recurring-interval month \
     --product <AGENCY_PRODUCT_ID>

   # AUD - $449/month
   stripe prices create \
     --currency aud \
     --unit-amount 44900 \
     --recurring-interval month \
     --product <AGENCY_PRODUCT_ID>
   ```

2. **Update `stripePlans.ts`** with new Price IDs:
   ```typescript
   stripePriceIdByCurrency: {
     nzd: "price_NEW_NZD_ID",
     aud: "price_NEW_AUD_ID",
     // ... other currencies
   }
   ```

3. **Deploy code** with updated pricing configuration

4. **Verify new subscriptions** use new Price IDs and pricing

## Validation

### Before Deployment
- ✅ Build succeeds without errors
- ✅ Usage limits updated (600 images for Agency tier)
- ✅ Stripe pricing configuration updated
- ✅ Grandfathering logic verified

### After Deployment
- [ ] Create test subscription - verify $499 NZD pricing
- [ ] Check existing subscription - verify original pricing maintained
- [ ] Verify usage limit - 600 images enforced
- [ ] Admin dashboard - verify correct plan display

## Rollback Plan

If issues arise, rollback by reverting:
1. `shared/src/plans.ts` to previous values
2. `shared/src/billing/stripePlans.ts` to previous values
3. Rebuild and redeploy

Existing subscriptions will be unaffected either way.

## Notes

- **No user notification required** - pricing displayed at signup only
- **No migration scripts needed** - changes are configuration only
- **No database changes** - existing data structure unchanged
- **AU expansion ready** - AUD pricing configured and tested
