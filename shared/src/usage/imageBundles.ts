// shared/src/usage/imageBundles.ts
// Agency image bundle storage and management

import { getRedis } from "../redisClient.js";
import { getCurrentMonthKey } from "./monthlyUsage.js";
import type { BundleCode } from "../bundles.js";

export interface AgencyImageBundle {
  id: string;
  agencyId: string;
  monthKey: string; // YYYY-MM when purchased
  bundleCode: BundleCode;
  imagesPurchased: number;
  imagesUsed: number;
  stripePaymentIntentId: string;
  stripeSessionId?: string;
  purchasedAt: string;
  expiresAt: string; // End of purchase month
}

/**
 * Create a new image bundle record after Stripe payment confirmation
 * ONLY called from Stripe webhook
 */
export async function createImageBundle(params: {
  agencyId: string;
  bundleCode: BundleCode;
  imagesPurchased: number;
  stripePaymentIntentId: string;
  stripeSessionId?: string;
  monthKey?: string;
}): Promise<{ created: boolean; bundle?: AgencyImageBundle; reason?: string }> {
  const redis = getRedis();
  const monthKey = params.monthKey || getCurrentMonthKey();

  try {
    // Check for duplicate payment (idempotency)
    const duplicateKey = `bundle:payment:${params.stripePaymentIntentId}`;
    const existing = await redis.get(duplicateKey);
    if (existing) {
      console.log(`[BUNDLES] Duplicate payment ${params.stripePaymentIntentId} - already processed`);
      return {
        created: false,
        reason: "duplicate",
        bundle: JSON.parse(existing)
      };
    }

    // Calculate expiry (end of purchase month)
    const [year, month] = monthKey.split("-").map(Number);
    const expiryDate = new Date(year, month, 0, 23, 59, 59); // Last day of month
    const expiresAt = expiryDate.toISOString();

    const bundle: AgencyImageBundle = {
      id: `bundle_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      agencyId: params.agencyId,
      monthKey,
      bundleCode: params.bundleCode,
      imagesPurchased: params.imagesPurchased,
      imagesUsed: 0,
      stripePaymentIntentId: params.stripePaymentIntentId,
      stripeSessionId: params.stripeSessionId,
      purchasedAt: new Date().toISOString(),
      expiresAt,
    };

    // Store bundle
    const bundleKey = `agency:${params.agencyId}:bundle:${bundle.id}`;
    await redis.set(bundleKey, JSON.stringify(bundle));
    // Expire 90 days after purchase month ends
    await redis.expire(bundleKey, 120 * 24 * 60 * 60);

    // Store payment intent mapping for deduplication (also 90 days)
    await redis.set(duplicateKey, JSON.stringify(bundle));
    await redis.expire(duplicateKey, 120 * 24 * 60 * 60);

    // Add to agency's bundle list
    const listKey = `agency:${params.agencyId}:bundles`;
    await redis.lPush(listKey, bundle.id);

    console.log(`[BUNDLES] Created bundle ${bundle.id} for agency ${params.agencyId}: ${params.imagesPurchased} images`);

    return {
      created: true,
      bundle
    };
  } catch (err) {
    console.error("[BUNDLES] Error creating bundle:", err);
    return {
      created: false,
      reason: "error"
    };
  }
}

/**
 * Get all active bundles for an agency in current month
 */
export async function getActiveBundles(
  agencyId: string,
  monthKey: string = getCurrentMonthKey()
): Promise<AgencyImageBundle[]> {
  const redis = getRedis();

  try {
    const listKey = `agency:${agencyId}:bundles`;
    const bundleIds = await redis.lRange(listKey, 0, -1);

    if (!bundleIds || bundleIds.length === 0) {
      return [];
    }

    const bundles: AgencyImageBundle[] = [];

    for (const bundleId of bundleIds) {
      const bundleKey = `agency:${agencyId}:bundle:${bundleId}`;
      const data = await redis.get(bundleKey);

      if (data) {
        const bundle: AgencyImageBundle = JSON.parse(data);

        // Only include bundles from current month that haven't expired
        if (bundle.monthKey === monthKey && new Date(bundle.expiresAt) > new Date()) {
          bundles.push(bundle);
        }
      }
    }

    return bundles;
  } catch (err) {
    console.error("[BUNDLES] Error getting active bundles:", err);
    return [];
  }
}

/**
 * Get total remaining images from all active bundles
 */
export async function getTotalBundleRemaining(
  agencyId: string,
  monthKey: string = getCurrentMonthKey()
): Promise<number> {
  const bundles = await getActiveBundles(agencyId, monthKey);

  return bundles.reduce((total, bundle) => {
    const remaining = Math.max(0, bundle.imagesPurchased - bundle.imagesUsed);
    return total + remaining;
  }, 0);
}

/**
 * Consume images from bundles (FIFO - oldest first)
 * Returns number of images actually consumed
 */
export async function consumeBundleImages(
  agencyId: string,
  amount: number,
  monthKey: string = getCurrentMonthKey()
): Promise<number> {
  const redis = getRedis();
  const bundles = await getActiveBundles(agencyId, monthKey);

  if (bundles.length === 0) {
    return 0;
  }

  // Sort by purchase date (oldest first)
  bundles.sort((a, b) => new Date(a.purchasedAt).getTime() - new Date(b.purchasedAt).getTime());

  let remaining = amount;
  let consumed = 0;

  for (const bundle of bundles) {
    if (remaining <= 0) break;

    const available = bundle.imagesPurchased - bundle.imagesUsed;
    if (available <= 0) continue;

    const toConsume = Math.min(remaining, available);

    // Update bundle
    bundle.imagesUsed += toConsume;
    const bundleKey = `agency:${agencyId}:bundle:${bundle.id}`;
    await redis.set(bundleKey, JSON.stringify(bundle));

    consumed += toConsume;
    remaining -= toConsume;

    console.log(`[BUNDLES] Consumed ${toConsume} from bundle ${bundle.id}, remaining in bundle: ${bundle.imagesPurchased - bundle.imagesUsed}`);
  }

  return consumed;
}

/**
 * Get bundle purchase history for an agency (all months)
 */
export async function getBundleHistory(agencyId: string): Promise<AgencyImageBundle[]> {
  const redis = getRedis();

  try {
    const listKey = `agency:${agencyId}:bundles`;
    const bundleIds = await redis.lRange(listKey, 0, -1);

    if (!bundleIds || bundleIds.length === 0) {
      return [];
    }

    const bundles: AgencyImageBundle[] = [];

    for (const bundleId of bundleIds) {
      const bundleKey = `agency:${agencyId}:bundle:${bundleId}`;
      const data = await redis.get(bundleKey);

      if (data) {
        bundles.push(JSON.parse(data));
      }
    }

    // Sort by purchase date (newest first)
    return bundles.sort((a, b) => new Date(b.purchasedAt).getTime() - new Date(a.purchasedAt).getTime());
  } catch (err) {
    console.error("[BUNDLES] Error getting bundle history:", err);
    return [];
  }
}
