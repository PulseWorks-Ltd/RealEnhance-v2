// server/src/services/upgradeProration.ts
// Mid-period upgrades get credits in proportion to the days left, the same way
// Stripe charges for them (Nov 2026). Stripe bills an upgrade as "the price
// difference x the share of the billing period left", so the agency keeps its
// old plan's credits for the whole period and gets the extra credits of the new
// plan only for the share of the period it is on it.
//
// Example: Starter (80) -> Pro (160) with 26 of 30 days left
//   80 + (160 - 80) x 26/30 = 149 credits for that period, 160 from renewal.
//
// The adjusted limit is kept in Redis for that one billing period; the next
// period has a new key, so the full allowance applies from renewal on its own.

import type Stripe from "stripe";
import { getRedis } from "@realenhance/shared/redisClient.js";
import { PLAN_LIMITS } from "@realenhance/shared/plans.js";
import type { PlanTier } from "@realenhance/shared/auth/types.js";

type PeriodOverride = { limit: number; applied: string[] };

function overrideKey(agencyId: string, periodKey: string) {
  return `agency:${agencyId}:periodLimit:${periodKey}`;
}

export function periodKeyFromUnix(periodStartSec: number): string {
  // Same format as the billing cycle key (currentPeriodStart.slice(0, 10)).
  return new Date(periodStartSec * 1000).toISOString().slice(0, 10);
}

/** The plan credits for this period after a mid-period upgrade, if any. */
export async function getPeriodLimitOverride(agencyId: string, periodKey: string): Promise<number | null> {
  try {
    const raw = await getRedis().get(overrideKey(agencyId, periodKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PeriodOverride;
    return Number.isFinite(parsed?.limit) ? Math.max(0, Math.round(parsed.limit)) : null;
  } catch (err) {
    console.warn(`[USAGE] could not read period limit for ${agencyId}/${periodKey}:`, err);
    return null;
  }
}

export type UpgradeProrationResult = {
  periodKey: string;
  fromTier: PlanTier;
  toTier: PlanTier;
  shareOfPeriodLeft: number;
  periodLimit: number;
};

/**
 * Record the prorated plan credits for an upgrade from `fromTier` to `toTier`
 * at `changeSec` within the billing period. Does nothing for downgrades, for
 * a change outside the period, or when this same upgrade was already recorded
 * for the period (the upgrade route and Stripe's webhook can both see it).
 */
export async function recordUpgradeProration(params: {
  agencyId: string;
  fromTier: PlanTier | null | undefined;
  toTier: PlanTier;
  periodStartSec: number | undefined;
  periodEndSec: number | undefined;
  changeSec: number;
}): Promise<UpgradeProrationResult | null> {
  const { agencyId, fromTier, toTier, periodStartSec, periodEndSec, changeSec } = params;
  if (!fromTier || fromTier === toTier) return null;
  const fromAllowance = PLAN_LIMITS[fromTier]?.mainAllowance;
  const toAllowance = PLAN_LIMITS[toTier]?.mainAllowance;
  if (!fromAllowance || !toAllowance || toAllowance <= fromAllowance) return null;
  if (!periodStartSec || !periodEndSec || periodEndSec <= periodStartSec) return null;
  if (changeSec <= periodStartSec || changeSec >= periodEndSec) return null;

  const periodKey = periodKeyFromUnix(periodStartSec);
  const key = overrideKey(agencyId, periodKey);
  const marker = `${fromTier}->${toTier}`;
  const redis = getRedis();

  let current: PeriodOverride | null = null;
  try {
    const raw = await redis.get(key);
    if (raw) current = JSON.parse(raw) as PeriodOverride;
  } catch {
    current = null;
  }
  if (current?.applied?.includes(marker)) return null;

  const share = (periodEndSec - changeSec) / (periodEndSec - periodStartSec);
  // Start from what the agency already had this period (its old plan, or an
  // earlier upgrade's adjusted figure) and add the new plan's extra credits
  // for the share of the period left.
  const base = current && Number.isFinite(current.limit) ? current.limit : fromAllowance;
  const periodLimit = Math.round(base + (toAllowance - fromAllowance) * share);

  const next: PeriodOverride = { limit: periodLimit, applied: [...(current?.applied || []), marker] };
  // Keep it a while past the period end; the key is unused after renewal.
  const ttlSec = Math.max(86400, Math.round(periodEndSec - Date.now() / 1000) + 40 * 86400);
  await redis.set(key, JSON.stringify(next), { EX: ttlSec });

  console.log(
    `[BILLING] agency ${agencyId} upgraded ${fromTier} -> ${toTier} with ${(share * 100).toFixed(1)}% of the period left: ` +
      `${periodLimit} plan credits for the period from ${periodKey} (full ${toAllowance} from renewal)`
  );
  return { periodKey, fromTier, toTier, shareOfPeriodLeft: share, periodLimit };
}

/**
 * When an upgrade happened, from Stripe's next invoice: its proration lines
 * ("Remaining time on Pro after 16 Nov") start at the moment of the change.
 * Used when the app learns of an upgrade late (the admin "Sync from Stripe").
 */
export async function findUpgradeTimeFromStripe(
  stripe: Stripe,
  subscriptionId: string,
  periodStartSec: number,
  periodEndSec: number,
): Promise<number | null> {
  try {
    const preview: any = await (stripe.invoices as any).createPreview({ subscription: subscriptionId });
    const starts: number[] = [];
    for (const line of preview?.lines?.data || []) {
      const s = Number(line?.period?.start || 0);
      const e = Number(line?.period?.end || 0);
      if (s > periodStartSec + 60 && s < periodEndSec && Math.abs(e - periodEndSec) < 3600) starts.push(s);
    }
    return starts.length ? Math.min(...starts) : null;
  } catch (err: any) {
    console.warn(`[BILLING] could not read upgrade time from Stripe for ${subscriptionId}:`, err?.message || err);
    return null;
  }
}
