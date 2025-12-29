// shared/src/agencies.ts
// Agency management with seat tracking and role enforcement

import { getRedis } from "./redisClient.js";
import type { Agency, PlanTier, SeatLimitCheck } from "./auth/types.js";
import type { UserRecord } from "./types.js";
import { getMaxSeatsForPlan } from "./plans.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Create a new agency
 */
export async function createAgency(params: {
  name: string;
  planTier?: PlanTier;
  ownerId: string;
}): Promise<Agency> {
  const planTier = params.planTier || "starter";
  const maxSeats = getMaxSeatsForPlan(planTier);

  const agency: Agency = {
    agencyId: `agency_${uuidv4()}`,
    name: params.name,
    planTier,
    maxSeats,
    createdAt: new Date().toISOString(),
  };

  try {
    const client = getRedis();
    const key = `agency:${agency.agencyId}`;

    await client.hSet(key, {
      agencyId: agency.agencyId,
      name: agency.name,
      planTier: agency.planTier,
      maxSeats: agency.maxSeats.toString(),
      createdAt: agency.createdAt,
    });

    console.log(`[AGENCY] Created agency ${agency.agencyId} with ${maxSeats} seats`);
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
      maxSeats: parseInt(data.maxSeats, 10),
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  } catch (err) {
    console.error("[AGENCY] Failed to get agency:", err);
    return null;
  }
}

/**
 * Update agency
 */
export async function updateAgency(agency: Agency): Promise<void> {
  try {
    const client = getRedis();
    const key = `agency:${agency.agencyId}`;

    const data: Record<string, string> = {
      agencyId: agency.agencyId,
      name: agency.name,
      planTier: agency.planTier,
      maxSeats: agency.maxSeats.toString(),
      createdAt: agency.createdAt,
      updatedAt: new Date().toISOString(),
    };

    await client.hSet(key, data);
  } catch (err) {
    console.error("[AGENCY] Failed to update agency:", err);
    throw new Error("Failed to update agency");
  }
}

/**
 * List all users for an agency
 */
export async function listAgencyUsers(agencyId: string): Promise<UserRecord[]> {
  try {
    const client = getRedis();
    const keys = await client.keys("user:*");

    const users: UserRecord[] = [];
    for (const key of keys) {
      const data = await client.hGetAll(key);
      if (data && data.agencyId === agencyId) {
        users.push(parseUserFromRedis(data));
      }
    }

    return users;
  } catch (err) {
    console.error("[AGENCY] Failed to list agency users:", err);
    return [];
  }
}

/**
 * Count active users in an agency
 * Active = isActive !== false AND has agencyId
 */
export async function countActiveAgencyUsers(agencyId: string): Promise<number> {
  try {
    const users = await listAgencyUsers(agencyId);
    // Count users where isActive is not explicitly false (defaults to true)
    const activeCount = users.filter(u => u.isActive !== false).length;
    return activeCount;
  } catch (err) {
    console.error("[AGENCY] Failed to count active users:", err);
    return 0;
  }
}

/**
 * Check if agency is over its seat limit
 */
export async function isAgencyOverSeatLimit(agencyId: string): Promise<SeatLimitCheck> {
  try {
    const agency = await getAgency(agencyId);
    if (!agency) {
      return { over: false, active: 0, maxSeats: 0 };
    }

    const activeCount = await countActiveAgencyUsers(agencyId);

    return {
      over: activeCount > agency.maxSeats,
      active: activeCount,
      maxSeats: agency.maxSeats,
    };
  } catch (err) {
    console.error("[AGENCY] Failed to check seat limit:", err);
    return { over: false, active: 0, maxSeats: 0 };
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
    passwordHash: data.passwordHash,
    authProvider: (data.authProvider as "email" | "google") || "email",
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
