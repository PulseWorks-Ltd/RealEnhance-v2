# Subscription Model Documentation

## Overview

RealEnhance uses a **direct debit subscription model** with manual subscription management. Stripe is used ONLY for one-time image bundle purchases, NOT for recurring subscriptions.

**Key Principles:**
- ✅ **Unlimited users per agency** - no seat limits
- ✅ **Subscription status gates uploads** - only ACTIVE or TRIAL agencies can upload
- ✅ **Monthly image allowances** - usage tracked per agency per month
- ✅ **Fail-closed security** - blocks uploads if subscription can't be verified
- ✅ **Backwards compatible** - legacy agencies auto-set to ACTIVE on first check

---

## Subscription Statuses

| Status | Can Upload? | Description |
|--------|-------------|-------------|
| `ACTIVE` | ✅ Yes | Fully paid and active subscription |
| `TRIAL` | ✅ Yes | Trial period (new agencies default to this) |
| `PAST_DUE` | ❌ No | Payment overdue |
| `CANCELLED` | ❌ No | Subscription cancelled |

---

## Plan Tiers

| Tier | Monthly Price | Enhanced Images | Virtual Staging Bundle |
|------|---------------|-----------------|------------------------|
| **Starter** | $129 NZD | 100 | 0 |
| **Pro** | $249 NZD | 250 | 25 |
| **Studio** | $399 NZD | 500 | 75 |

**All plans include unlimited users.**

---

## Gating Logic (Upload Endpoint)

### 1. Subscription Status Check (FAIL-CLOSED)

```typescript
// Allow ACTIVE and TRIAL
const allowedStatuses = ["ACTIVE", "TRIAL"];
if (!allowedStatuses.includes(agency.subscriptionStatus)) {
  return 403 SUBSCRIPTION_INACTIVE
}
```

**Error Responses:**

- **403 Forbidden** - `SUBSCRIPTION_INACTIVE`
  - Status is PAST_DUE or CANCELLED
  - Message: "Your subscription is inactive. Please contact support to reactivate your account."

- **503 Service Unavailable** - `SUBSCRIPTION_CHECK_FAILED`
  - Agency not found or subscription check error
  - Message: "Unable to verify your subscription. Please try again or contact support."
  - **CRITICAL: This prevents "Redis outage = free processing"**

### 2. Usage Exhaustion Check (FAIL-OPEN)

```typescript
if (exhaustedCheck.exhausted) {
  return 402 USAGE_EXHAUSTED
}
```

**Error Response:**

- **402 Payment Required** - `USAGE_EXHAUSTED`
  - Monthly image allowance exhausted
  - Message: "Your agency has reached its monthly image limit. Please upgrade your plan or wait until next month."

---

## Admin Management

### Option 1: Admin API (Protected by API Key)

Set environment variable:
```bash
export ADMIN_API_KEY="your-secure-random-key-here"
```

**Endpoints:**

```bash
# Get agency details
GET /internal/admin/agencies/:agencyId
Headers: X-Admin-API-Key: your-key

# Update subscription
POST /internal/admin/agencies/:agencyId/subscription
Headers: X-Admin-API-Key: your-key
Body: {
  "subscriptionStatus": "ACTIVE",
  "planTier": "pro",
  "currentPeriodStart": "2025-01-01T00:00:00Z",
  "currentPeriodEnd": "2025-02-01T00:00:00Z"
}

# Quick activate
POST /internal/admin/agencies/:agencyId/activate
Headers: X-Admin-API-Key: your-key

# Quick cancel
POST /internal/admin/agencies/:agencyId/cancel
Headers: X-Admin-API-Key: your-key
```

### Option 2: CLI Script (For Emergencies)

```bash
# Get current status
tsx server/scripts/manage-subscription.ts get agency_123

# Activate subscription
tsx server/scripts/manage-subscription.ts activate agency_123

# Cancel subscription
tsx server/scripts/manage-subscription.ts cancel agency_123

# Set specific status
tsx server/scripts/manage-subscription.ts set-status agency_123 ACTIVE

# Change plan tier
tsx server/scripts/manage-subscription.ts set-plan agency_123 pro

# Set billing period
tsx server/scripts/manage-subscription.ts set-period agency_123 2025-01-01 2025-02-01
```

---

## Testing Scenarios

### ✅ Scenario 1: Active Subscription, Under Limit
- **Setup**: `subscriptionStatus = "ACTIVE"`, `mainUsed < mainAllowance`
- **Expected**: Upload succeeds
- **Test**: Upload image → 200 OK

### ✅ Scenario 2: Active Subscription, Exhausted Usage
- **Setup**: `subscriptionStatus = "ACTIVE"`, `mainRemaining = 0`
- **Expected**: Upload blocked with 402 USAGE_EXHAUSTED
- **Test**: Upload image → 402 with code "USAGE_EXHAUSTED"

### ✅ Scenario 3: Trial Subscription (Usable)
- **Setup**: `subscriptionStatus = "TRIAL"`, under limit
- **Expected**: Upload succeeds (trials are usable)
- **Test**: Upload image → 200 OK

### ✅ Scenario 4: Cancelled Subscription
- **Setup**: `subscriptionStatus = "CANCELLED"`
- **Expected**: Upload blocked with 403 SUBSCRIPTION_INACTIVE
- **Test**: Upload image → 403 with code "SUBSCRIPTION_INACTIVE"

### ✅ Scenario 5: Past Due Subscription
- **Setup**: `subscriptionStatus = "PAST_DUE"`
- **Expected**: Upload blocked with 403 SUBSCRIPTION_INACTIVE
- **Test**: Upload image → 403 with code "SUBSCRIPTION_INACTIVE"

### ✅ Scenario 6: Agency Not Found (Fail-Closed)
- **Setup**: Invalid agencyId in user record
- **Expected**: Upload blocked with 503 SUBSCRIPTION_CHECK_FAILED
- **Test**: Upload with invalid agency → 503 with code "SUBSCRIPTION_CHECK_FAILED"

### ✅ Scenario 7: Legacy Agency (Backwards Compatibility)
- **Setup**: Agency exists but `subscriptionStatus` is missing/undefined
- **Expected**: Defaults to ACTIVE, writes back to Redis
- **Test**: Upload → succeeds + agency.subscriptionStatus set to "ACTIVE"

---

## Migration Plan

### For Existing Agencies

All existing agencies will automatically be treated as **ACTIVE** due to backwards compatibility:

```typescript
// In getAgency():
subscriptionStatus: (data.subscriptionStatus as SubscriptionStatus) || "ACTIVE"

// In upload endpoint:
if (!agency.subscriptionStatus) {
  agency.subscriptionStatus = "ACTIVE";
  await updateAgency(agency);
}
```

**No manual migration required** - agencies will be upgraded on first upload.

### For New Agencies

New agencies are created with `subscriptionStatus = "TRIAL"` by default:

```typescript
// In createAgency():
const subscriptionStatus = params.subscriptionStatus || "TRIAL";
```

---

## Monitoring & Logging

All subscription events are logged with prefix `[SUBSCRIPTION GATE]`:

```
[SUBSCRIPTION GATE] Agency agency_123 has inactive subscription: CANCELLED
[SUBSCRIPTION GATE] Writing back ACTIVE status for legacy agency agency_456
[SUBSCRIPTION GATE] Agency agency_789 not found
```

**Recommended Monitoring:**
- Alert on high rate of `SUBSCRIPTION_CHECK_FAILED` errors (indicates Redis issues)
- Track `SUBSCRIPTION_INACTIVE` blocks by agency (identify churn)
- Monitor TRIAL → ACTIVE conversion rate

---

## Security Considerations

### ✅ Implemented

1. **Fail-Closed Subscription Check** - blocks uploads if verification fails
2. **Admin API Key Protection** - prevents unauthorized subscription changes
3. **Audit Logging** - all subscription changes logged with timestamps
4. **Backwards Compatibility** - safely handles legacy data

### ⚠️ Future Enhancements

1. **Rate Limiting** - limit admin API calls to prevent abuse
2. **Webhook Integration** - automate status updates from payment provider
3. **Trial Expiry** - automatic TRIAL → CANCELLED after X days
4. **Usage Cap for Trials** - hard limit on trial usage (e.g., 20 images max)

---

## Environment Variables

```bash
# Required for admin management
ADMIN_API_KEY=your-secure-random-key-here

# Stripe (for image bundles only, NOT subscriptions)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

---

## FAQ

### Q: Can I use Stripe for recurring subscriptions?
**A:** No. Stripe is ONLY for one-time image bundle purchases. Base subscriptions are managed via direct debit outside the app.

### Q: What happens to users when an agency is cancelled?
**A:** All users in the agency are immediately blocked from uploading. They can still log in and view past images, but cannot create new enhancements.

### Q: Do trials expire automatically?
**A:** Not yet. Currently, TRIAL agencies can upload indefinitely. You must manually set status to CANCELLED or implement auto-expiry logic.

### Q: What if Redis is down?
**A:** Upload will return 503 SUBSCRIPTION_CHECK_FAILED (fail-closed). This prevents free processing during outages.

### Q: Can I add seat limits back later?
**A:** Yes, but it would require reinstating the removed code. The current architecture supports unlimited users per agency.

---

## Support & Troubleshooting

### Common Issues

**Issue**: Legacy agency can't upload
- **Cause**: Missing `subscriptionStatus` field
- **Fix**: Automatically resolved on first upload attempt (writes back ACTIVE)
- **Manual Fix**: `tsx server/scripts/manage-subscription.ts activate <agencyId>`

**Issue**: New agency can't upload immediately
- **Cause**: Created with TRIAL status
- **Fix**: TRIAL is usable - this should work. Check if there's another issue.
- **Manual Fix**: `tsx server/scripts/manage-subscription.ts activate <agencyId>`

**Issue**: Admin API returns 401
- **Cause**: Missing or incorrect `ADMIN_API_KEY`
- **Fix**: Set environment variable and restart server

---

## Related Documentation

- [USAGE_IMPLEMENTATION.md](./USAGE_IMPLEMENTATION.md) - Image usage tracking
- [STRIPE_INTEGRATION.md](./STRIPE_INTEGRATION.md) - Image bundle purchases (not subscriptions)
- [AGENCY_IMPLEMENTATION.md](./AGENCY_IMPLEMENTATION.md) - Agency management (deprecated seat limits)
