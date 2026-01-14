// shared/src/agencies.ts
// Agency management (unlimited users per agency)

import { getRedis } from "./redisClient.js";
import type { Agency, PlanTier, SubscriptionStatus } from "./auth/types.js";
import type { UserRecord } from "./types.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Create a new agency (with unlimited users)
 */
export async function createAgency(params: {
  name: string;
  planTier?: PlanTier;
  ownerId: string;
  subscriptionStatus?: SubscriptionStatus;
}): Promise<Agency> {
  const planTier = params.planTier || "starter";
  const subscriptionStatus = params.subscriptionStatus || "TRIAL"; // New agencies start as TRIAL

  const agency: Agency = {
    agencyId: `agency_${uuidv4()}`,
    name: params.name,
    planTier,
    subscriptionStatus,
    createdAt: new Date().toISOString(),
  };

  try {
    const client = getRedis();
    const key = `agency:${agency.agencyId}`;

    await client.hSet(key, {
      agencyId: agency.agencyId,
      name: agency.name,
      planTier: agency.planTier,
      subscriptionStatus: agency.subscriptionStatus,
      createdAt: agency.createdAt,
    });

    console.log(`[AGENCY] Created agency ${agency.agencyId} (plan: ${planTier}, status: ${subscriptionStatus})`);
    return agency;
  } catch (err) {
    console.error("[AGENCY] Failed to create agency:", err);
    throw new Error("Failed to create agency");
  }
}

/**
 * Get agency by ID
 */
export async function getAgency(agencyId: string): Promise<Agency | null> {
  try {
    const client = getRedis();
    const key = `agency:${agencyId}`;
    const data = await client.hGetAll(key);

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      agencyId: data.agencyId,
      name: data.name,
      planTier: data.planTier as PlanTier,
      subscriptionStatus: (data.subscriptionStatus as SubscriptionStatus) || "ACTIVE", // Default to ACTIVE for backwards compatibility
      // Stripe billing fields
      stripeCustomerId: data.stripeCustomerId,
      stripeSubscriptionId: data.stripeSubscriptionId,
      stripePriceId: data.stripePriceId,
      // Billing region & currency
      billingCountry: data.billingCountry as "NZ" | "AU" | "ZA" | undefined,
      billingCurrency: data.billingCurrency as "nzd" | "aud" | "zar" | "usd" | undefined,
      billingEmail: data.billingEmail,
      // Subscription period
      currentPeriodStart: data.currentPeriodStart,
      currentPeriodEnd: data.currentPeriodEnd,
      // Grandfather flag
      billingGrandfatheredUntil: data.billingGrandfatheredUntil,
      // Metadata
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  } catch (err) {
    console.error("[AGENCY] Failed to get agency:", err);
    return null;
  }
}

/**
 * Update agency (including subscription status for admin use)
 */
export async function updateAgency(agency: Agency): Promise<void> {
  try {
    const client = getRedis();
    const key = `agency:${agency.agencyId}`;

    const data: Record<string, string> = {
      agencyId: agency.agencyId,
      name: agency.name,
      planTier: agency.planTier,
      subscriptionStatus: agency.subscriptionStatus,
      createdAt: agency.createdAt,
      updatedAt: new Date().toISOString(),
    };

    // Stripe billing fields
    if (agency.stripeCustomerId) data.stripeCustomerId = agency.stripeCustomerId;
    if (agency.stripeSubscriptionId) data.stripeSubscriptionId = agency.stripeSubscriptionId;
    if (agency.stripePriceId) data.stripePriceId = agency.stripePriceId;

    // Billing region & currency
    if (agency.billingCountry) data.billingCountry = agency.billingCountry;
    if (agency.billingCurrency) data.billingCurrency = agency.billingCurrency;
    if (agency.billingEmail) data.billingEmail = agency.billingEmail;

    // Subscription period
    if (agency.currentPeriodStart) data.currentPeriodStart = agency.currentPeriodStart;
    if (agency.currentPeriodEnd) data.currentPeriodEnd = agency.currentPeriodEnd;

    // Grandfather flag
    if (agency.billingGrandfatheredUntil) data.billingGrandfatheredUntil = agency.billingGrandfatheredUntil;

    await client.hSet(key, data);
    console.log(`[AGENCY] Updated agency ${agency.agencyId} (status: ${agency.subscriptionStatus})`);
  } catch (err) {
    console.error("[AGENCY] Failed to update agency:", err);
    throw new Error("Failed to update agency");
  }
}

/**
 * Update agency subscription status (for admin/billing management)
 */
export async function updateAgencySubscriptionStatus(
  agencyId: string,
  subscriptionStatus: SubscriptionStatus
): Promise<void> {
  const agency = await getAgency(agencyId);
  if (!agency) {
    throw new Error(`Agency ${agencyId} not found`);
  }

  agency.subscriptionStatus = subscriptionStatus;
  agency.updatedAt = new Date().toISOString();

  await updateAgency(agency);
}

/**
 * List all users for an agency (no limits)
 */
export async function listAgencyUsers(agencyId: string): Promise<UserRecord[]> {
  try {
    const client = getRedis();
    const keys = await client.keys("user:*");

    const users: UserRecord[] = [];
    for (const key of keys) {
      // Some legacy keys may not be hashes; skip them to avoid WRONGTYPE errors
      try {
        const keyType = await client.type(key);
        if (keyType !== "hash") {
          continue;
        }

        const data = await client.hGetAll(key);
        if (data && data.agencyId === agencyId) {
          users.push(parseUserFromRedis(data));
        }
      } catch (err) {
        console.warn(`[AGENCY] Skipping malformed user key ${key}:`, err);
      }
    }

    return users;
  } catch (err) {
    console.error("[AGENCY] Failed to list agency users:", err);
    return [];
  }
}

/**
 * Count active users in an agency (for informational purposes only - no limits enforced)
 */
export async function countActiveAgencyUsers(agencyId: string): Promise<number> {
  try {
    const users = await listAgencyUsers(agencyId);
    // Count users where isActive is not explicitly false (defaults to true)
    const activeCount = users.filter(u => u.isActive !== false).length;
    return activeCount;
  } catch (err) {
    console.error("[AGENCY] Failed to count agency users:", err);
    return 0;
  }
}

/**
 * Helper to parse user from Redis hash
 */
function parseUserFromRedis(data: Record<string, string>): UserRecord {
  return {
    id: data.id,
    email: data.email,
    name: data.name,
    firstName: data.firstName || undefined,
    lastName: data.lastName || undefined,
    passwordHash: data.passwordHash,
    authProvider: (data.authProvider as "email" | "google" | "both") || "email",
    googleId: data.googleId || undefined,
    credits: parseInt(data.credits || "0", 10),
    imageIds: data.imageIds ? JSON.parse(data.imageIds) : [],
    agencyId: data.agencyId || null,
    role: (data.role as "owner" | "admin" | "member") || "member",
    isActive: data.isActive !== "false", // Defaults to true
    plan: data.plan as any,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}
