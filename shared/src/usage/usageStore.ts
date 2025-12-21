// shared/src/usage/usageStore.ts
// Redis-based usage tracking storage (best-effort, never blocks jobs)

import { getRedis } from "../redisClient.js";
import { UsageEvent, MonthlyRollup, UsageWarning } from "./types.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Get current month in YYYY-MM format
 */
function getCurrentMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Record a single usage event (best-effort, never throws)
 */
export async function recordUsageEvent(event: Omit<UsageEvent, "id" | "createdAt">): Promise<void> {
  try {
    const client = getRedis();
    const month = getCurrentMonth();

    const fullEvent: UsageEvent = {
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      ...event,
    };

    // 1. Append to monthly events log
    const eventsKey = `usage:events:${month}`;
    await client.rPush(eventsKey, JSON.stringify(fullEvent));

    // 2. Update user rollup
    if (fullEvent.userId) {
      await updateUserRollup(fullEvent.userId, month, fullEvent);
    }

    // 3. Update agency rollup
    if (fullEvent.agencyId) {
      await updateAgencyRollup(fullEvent.agencyId, month, fullEvent);
    }

    console.log(`[USAGE] Recorded event: ${fullEvent.stage} for job ${fullEvent.jobId}`);
  } catch (err) {
    console.error("[USAGE] Failed to record usage event (non-blocking):", err);
  }
}

/**
 * Update user monthly rollup
 */
async function updateUserRollup(userId: string, month: string, event: UsageEvent): Promise<void> {
  try {
    const client = getRedis();
    const key = `usage:rollup:user:${userId}:${month}`;

    // Increment stage counter
    await client.hIncrBy(key, `stage_${event.stage}`, 1);

    // Increment total images (count all stage completions)
    await client.hIncrBy(key, "images", 1);

    // Track distinct listing IDs
    if (event.listingId) {
      const listingsKey = `usage:listings:user:${userId}:${month}`;
      await client.sAdd(listingsKey, event.listingId);
      const listingCount = await client.sCard(listingsKey);
      await client.hSet(key, "listings", listingCount.toString());
    }

    // Set expiry (13 months from now to keep historical data)
    await client.expire(key, 60 * 60 * 24 * 390);
  } catch (err) {
    console.error("[USAGE] Failed to update user rollup:", err);
  }
}

/**
 * Update agency monthly rollup
 */
async function updateAgencyRollup(agencyId: string, month: string, event: UsageEvent): Promise<void> {
  try {
    const client = getRedis();
    const key = `usage:rollup:agency:${agencyId}:${month}`;

    // Increment stage counter
    await client.hIncrBy(key, `stage_${event.stage}`, 1);

    // Increment total images
    await client.hIncrBy(key, "images", 1);

    // Track distinct listing IDs
    if (event.listingId) {
      const listingsKey = `usage:listings:agency:${agencyId}:${month}`;
      await client.sAdd(listingsKey, event.listingId);
      const listingCount = await client.sCard(listingsKey);
      await client.hSet(key, "listings", listingCount.toString());
    }

    // Set expiry
    await client.expire(key, 60 * 60 * 24 * 390);
  } catch (err) {
    console.error("[USAGE] Failed to update agency rollup:", err);
  }
}

/**
 * Get user monthly rollup
 */
export async function getUserRollup(userId: string, month?: string): Promise<MonthlyRollup | null> {
  try {
    const client = getRedis();
    const targetMonth = month || getCurrentMonth();
    const key = `usage:rollup:user:${userId}:${targetMonth}`;

    const data = await client.hGetAll(key);
    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      images: parseInt(data.images || "0", 10),
      listings: parseInt(data.listings || "0", 10),
      stage_1A: parseInt(data.stage_1A || "0", 10),
      stage_1B: parseInt(data.stage_1B || "0", 10),
      stage_2: parseInt(data.stage_2 || "0", 10),
      stage_edit: parseInt(data.stage_edit || "0", 10),
      stage_region_edit: parseInt(data["stage_region-edit"] || "0", 10),
    };
  } catch (err) {
    console.error("[USAGE] Failed to get user rollup:", err);
    return null;
  }
}

/**
 * Get agency monthly rollup
 */
export async function getAgencyRollup(agencyId: string, month?: string): Promise<MonthlyRollup | null> {
  try {
    const client = getRedis();
    const targetMonth = month || getCurrentMonth();
    const key = `usage:rollup:agency:${agencyId}:${targetMonth}`;

    const data = await client.hGetAll(key);
    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      images: parseInt(data.images || "0", 10),
      listings: parseInt(data.listings || "0", 10),
      stage_1A: parseInt(data.stage_1A || "0", 10),
      stage_1B: parseInt(data.stage_1B || "0", 10),
      stage_2: parseInt(data.stage_2 || "0", 10),
      stage_edit: parseInt(data.stage_edit || "0", 10),
      stage_region_edit: parseInt(data["stage_region-edit"] || "0", 10),
    };
  } catch (err) {
    console.error("[USAGE] Failed to get agency rollup:", err);
    return null;
  }
}

/**
 * Store a usage warning (best-effort)
 */
export async function storeWarning(warning: UsageWarning): Promise<void> {
  try {
    const client = getRedis();
    const key = `usage:warnings:agency:${warning.agencyId}:${warning.month}`;

    await client.rPush(key, JSON.stringify(warning));
    await client.expire(key, 60 * 60 * 24 * 390); // 13 months
  } catch (err) {
    console.error("[USAGE] Failed to store warning:", err);
  }
}

/**
 * Get all warnings for an agency in a month
 */
export async function getWarnings(agencyId: string, month?: string): Promise<UsageWarning[]> {
  try {
    const client = getRedis();
    const targetMonth = month || getCurrentMonth();
    const key = `usage:warnings:agency:${agencyId}:${targetMonth}`;

    const rawWarnings = await client.lRange(key, 0, -1);
    return rawWarnings.map((w: string) => JSON.parse(w) as UsageWarning);
  } catch (err) {
    console.error("[USAGE] Failed to get warnings:", err);
    return [];
  }
}

/**
 * Get recent usage events for an agency (limit 100)
 */
export async function getRecentEvents(agencyId: string, month?: string, limit = 100): Promise<UsageEvent[]> {
  try {
    const client = getRedis();
    const targetMonth = month || getCurrentMonth();
    const eventsKey = `usage:events:${targetMonth}`;

    const rawEvents = await client.lRange(eventsKey, -limit, -1);
    const allEvents = rawEvents.map((e: string) => JSON.parse(e) as UsageEvent);

    // Filter by agency
    return allEvents.filter((e: UsageEvent) => e.agencyId === agencyId);
  } catch (err) {
    console.error("[USAGE] Failed to get recent events:", err);
    return [];
  }
}
